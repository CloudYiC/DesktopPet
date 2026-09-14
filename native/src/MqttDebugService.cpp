#include "Milo/MqttDebugService.h"

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <schannel.h>
#include <security.h>

#include <algorithm>
#include <chrono>
#include <climits>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <deque>
#include <functional>
#include <map>
#include <mutex>
#include <set>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "cloudyi/mqtt_codec.h"

namespace milo {
namespace {

const std::size_t kMaximumPayloadBytes = 256U * 1024U;
const std::size_t kMaximumPacketBytes = 1024U * 1024U;
const std::size_t kMaximumPendingBytes = 2U * 1024U * 1024U;
const std::size_t kMaximumEventBytes = 4U * 1024U * 1024U;
const std::size_t kMaximumEventCount = 1000U;
const std::size_t kMaximumPollCount = 200U;
const std::size_t kMaximumSubscriptions = 128U;
const std::size_t kMaximumInflight = 128U;
const int kIoWaitMilliseconds = 80;
const std::uint64_t kConnectTimeoutMilliseconds = 10000U;
const std::uint64_t kSendTimeoutMilliseconds = 10000U;

std::int64_t UnixMilliseconds() {
  return static_cast<std::int64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::system_clock::now().time_since_epoch())
          .count());
}

std::uint64_t MonotonicMilliseconds() {
  return static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now().time_since_epoch())
          .count());
}

std::wstring Utf8ToWide(const std::string& value) {
  if (value.empty()) return std::wstring();
  const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                        value.data(),
                                        static_cast<int>(value.size()),
                                        nullptr, 0);
  if (count <= 0) return std::wstring();
  std::wstring result(static_cast<std::size_t>(count), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                          static_cast<int>(value.size()), &result[0], count) !=
      count) {
    return std::wstring();
  }
  return result;
}

bool ReadString(const nlohmann::json& payload, const char* key,
                std::size_t maximum, bool allowEmpty, std::string* output) {
  const nlohmann::json::const_iterator value = payload.find(key);
  if (value == payload.end() || !value->is_string()) return false;
  const std::string parsed = value->get<std::string>();
  if (parsed.size() > maximum || (!allowEmpty && parsed.empty()) ||
      parsed.find('\0') != std::string::npos) return false;
  if (output != nullptr) *output = parsed;
  return true;
}

bool ReadInteger(const nlohmann::json& payload, const char* key,
                 std::int64_t minimum, std::int64_t maximum,
                 std::int64_t* output) {
  const nlohmann::json::const_iterator value = payload.find(key);
  if (value == payload.end() ||
      (!value->is_number_integer() && !value->is_number_unsigned())) {
    return false;
  }
  std::int64_t parsed = 0;
  if (value->is_number_unsigned()) {
    const std::uint64_t number = value->get<std::uint64_t>();
    if (number > static_cast<std::uint64_t>(maximum)) return false;
    parsed = static_cast<std::int64_t>(number);
  } else {
    parsed = value->get<std::int64_t>();
  }
  if (parsed < minimum || parsed > maximum) return false;
  if (output != nullptr) *output = parsed;
  return true;
}

bool ReadBoolean(const nlohmann::json& payload, const char* key,
                 bool* output) {
  const nlohmann::json::const_iterator value = payload.find(key);
  if (value == payload.end() || !value->is_boolean()) return false;
  if (output != nullptr) *output = value->get<bool>();
  return true;
}

int HexNibble(char value) {
  if (value >= '0' && value <= '9') return value - '0';
  if (value >= 'a' && value <= 'f') return value - 'a' + 10;
  if (value >= 'A' && value <= 'F') return value - 'A' + 10;
  return -1;
}

bool DecodeHex(const std::string& text, std::vector<unsigned char>* output) {
  if (output == nullptr || text.size() % 2U != 0 ||
      text.size() / 2U > kMaximumPayloadBytes) {
    return false;
  }
  output->clear();
  output->reserve(text.size() / 2U);
  for (std::size_t index = 0; index < text.size(); index += 2U) {
    const int high = HexNibble(text[index]);
    const int low = HexNibble(text[index + 1U]);
    if (high < 0 || low < 0) {
      output->clear();
      return false;
    }
    output->push_back(static_cast<unsigned char>((high << 4) | low));
  }
  return true;
}

std::string EncodeHex(const unsigned char* data, std::size_t size) {
  static const char digits[] = "0123456789abcdef";
  std::string result(size * 2U, '0');
  for (std::size_t index = 0; index < size; ++index) {
    result[index * 2U] = digits[(data[index] >> 4U) & 0x0fU];
    result[index * 2U + 1U] = digits[data[index] & 0x0fU];
  }
  return result;
}

bool IsSafeHost(const std::string& host) {
  if (host.empty() || host.size() > 253U) return false;
  for (std::string::const_iterator character = host.begin();
       character != host.end(); ++character) {
    const unsigned char value = static_cast<unsigned char>(*character);
    if (value <= 0x20U || value >= 0x7fU) return false;
  }
  return true;
}

void WipeString(std::string* value) {
  if (value != nullptr && !value->empty()) {
    SecureZeroMemory(&(*value)[0], value->size());
    value->clear();
  }
}

bool WaitSocket(SOCKET socket, bool write, int milliseconds) {
  fd_set sockets;
  FD_ZERO(&sockets);
  FD_SET(socket, &sockets);
  timeval timeout = {};
  timeout.tv_sec = milliseconds / 1000;
  timeout.tv_usec = (milliseconds % 1000) * 1000;
  const int result = select(0, write ? nullptr : &sockets,
                            write ? &sockets : nullptr, nullptr, &timeout);
  return result > 0 && FD_ISSET(socket, &sockets) != 0;
}

bool SendRaw(SOCKET socket, const unsigned char* data, std::size_t size,
             const std::function<bool()>& cancelled, std::string* error) {
  std::size_t offset = 0;
  const std::uint64_t deadline =
      MonotonicMilliseconds() + kSendTimeoutMilliseconds;
  while (offset < size) {
    if (cancelled()) return false;
    if (MonotonicMilliseconds() >= deadline) {
      if (error != nullptr) *error = "发送到 Broker 超时。";
      return false;
    }
    if (!WaitSocket(socket, true, kIoWaitMilliseconds)) continue;
    const int amount = send(socket,
                            reinterpret_cast<const char*>(data + offset),
                            static_cast<int>((std::min)(size - offset,
                                                       static_cast<std::size_t>(INT_MAX))),
                            0);
    if (amount <= 0) {
      if (error != nullptr) {
        *error = "发送到 Broker 失败（Winsock " +
                 std::to_string(WSAGetLastError()) + "）。";
      }
      return false;
    }
    offset += static_cast<std::size_t>(amount);
  }
  return true;
}

struct ResolvedAddress {
  sockaddr_storage storage;
  int length;
  int socketType;
  int protocol;
};

struct ResolveContext {
  OVERLAPPED overlapped;
  PADDRINFOEXW results;
  HANDLE event;
  volatile LONG references;
  volatile LONG completionError;
};

void ReleaseResolveContext(ResolveContext* context) {
  if (context != nullptr && InterlockedDecrement(&context->references) == 0) {
    if (context->results != nullptr) FreeAddrInfoExW(context->results);
    if (context->event != nullptr) CloseHandle(context->event);
    delete context;
  }
}

void CALLBACK ResolveCompleted(DWORD error, DWORD,
                               LPOVERLAPPED overlapped) {
  if (overlapped == nullptr) return;
  ResolveContext* context = reinterpret_cast<ResolveContext*>(overlapped);
  InterlockedExchange(&context->completionError, static_cast<LONG>(error));
  SetEvent(context->event);
  ReleaseResolveContext(context);
}

bool ResolveHost(const std::string& host, std::uint16_t port,
                 const std::function<bool()>& cancelled,
                 std::vector<ResolvedAddress>* output, std::string* error) {
  output->clear();
  const std::wstring wideHost = Utf8ToWide(host);
  const std::wstring service = std::to_wstring(port);
  if (wideHost.empty()) {
    if (error != nullptr) *error = "Broker 地址不是有效 UTF-8。";
    return false;
  }
  ResolveContext* context = new ResolveContext();
  std::memset(context, 0, sizeof(*context));
  context->event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  context->references = 2;
  if (context->event == nullptr) {
    context->references = 1;
    ReleaseResolveContext(context);
    if (error != nullptr) *error = "无法创建 Broker 解析任务。";
    return false;
  }
  ADDRINFOEXW hints = {};
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  hints.ai_protocol = IPPROTO_TCP;
  HANDLE cancelHandle = nullptr;
  int result = GetAddrInfoExW(
      wideHost.c_str(), service.c_str(), NS_ALL, nullptr, &hints,
      &context->results, nullptr, &context->overlapped, ResolveCompleted,
      &cancelHandle);
  if (result == WSA_IO_PENDING) {
    bool completed = false;
    const std::uint64_t deadline =
        MonotonicMilliseconds() + kConnectTimeoutMilliseconds;
    while (!cancelled() && MonotonicMilliseconds() < deadline) {
      if (WaitForSingleObject(context->event, kIoWaitMilliseconds) ==
          WAIT_OBJECT_0) {
        result = static_cast<int>(context->completionError);
        completed = true;
        break;
      }
    }
    if (!completed) {
      if (cancelHandle != nullptr) (void)GetAddrInfoExCancel(&cancelHandle);
      if (error != nullptr && !cancelled()) *error = "解析 Broker 地址超时。";
      ReleaseResolveContext(context);
      return false;
    }
  } else {
    // The asynchronous callback is not invoked for an immediate result.
    ReleaseResolveContext(context);
  }
  if (result != 0) {
    if (error != nullptr) *error = "无法解析 Broker 地址。";
    ReleaseResolveContext(context);
    return false;
  }
  for (PADDRINFOEXW address = context->results;
       address != nullptr && output->size() < 16U; address = address->ai_next) {
    if ((address->ai_family != AF_INET && address->ai_family != AF_INET6) ||
        address->ai_addr == nullptr ||
        address->ai_addrlen > sizeof(sockaddr_storage)) continue;
    ResolvedAddress resolved = {};
    std::memcpy(&resolved.storage, address->ai_addr, address->ai_addrlen);
    resolved.length = static_cast<int>(address->ai_addrlen);
    resolved.socketType = address->ai_socktype;
    resolved.protocol = address->ai_protocol;
    output->push_back(resolved);
  }
  ReleaseResolveContext(context);
  if (output->empty()) {
    if (error != nullptr) *error = "Broker 地址没有可用的 IPv4 或 IPv6 结果。";
    return false;
  }
  return true;
}

class Transport final {
 public:
  Transport() = default;
  ~Transport() { Close(); }

  bool Connect(const std::string& host, std::uint16_t port, bool tls,
               const std::function<bool()>& cancelled, std::string* error) {
    Close();
    std::vector<ResolvedAddress> addresses;
    if (!ResolveHost(host, port, cancelled, &addresses, error)) return false;
    const std::uint64_t deadline =
        MonotonicMilliseconds() + kConnectTimeoutMilliseconds;
    for (std::vector<ResolvedAddress>::const_iterator address = addresses.begin();
         address != addresses.end() && !cancelled(); ++address) {
      SOCKET candidate = socket(address->storage.ss_family,
                                address->socketType, address->protocol);
      if (candidate == INVALID_SOCKET) continue;
      u_long nonBlocking = 1;
      ioctlsocket(candidate, FIONBIO, &nonBlocking);
      const int connected = connect(
          candidate, reinterpret_cast<const sockaddr*>(&address->storage),
          address->length);
      bool ready = connected == 0;
      if (!ready && WSAGetLastError() == WSAEWOULDBLOCK) {
        while (!cancelled() && MonotonicMilliseconds() < deadline) {
          if (!WaitSocket(candidate, true, kIoWaitMilliseconds)) continue;
          int socketError = 0;
          int length = sizeof(socketError);
          if (getsockopt(candidate, SOL_SOCKET, SO_ERROR,
                         reinterpret_cast<char*>(&socketError), &length) == 0 &&
              socketError == 0) {
            ready = true;
          }
          break;
        }
      }
      if (ready) {
        socket_ = candidate;
        break;
      }
      closesocket(candidate);
    }
    if (socket_ == INVALID_SOCKET) {
      if (error != nullptr && !cancelled()) *error = "连接 Broker 超时或被拒绝。";
      return false;
    }
    tls_ = tls;
    if (tls_ && !StartTls(host, cancelled, error)) {
      Close();
      return false;
    }
    return true;
  }

  bool Send(const std::vector<unsigned char>& data,
            const std::function<bool()>& cancelled, std::string* error) {
    if (!tls_) return SendRaw(socket_, data.data(), data.size(), cancelled, error);
    std::size_t offset = 0;
    while (offset < data.size()) {
      const std::size_t amount = (std::min)(
          data.size() - offset,
          static_cast<std::size_t>(streamSizes_.cbMaximumMessage));
      std::vector<unsigned char> record(streamSizes_.cbHeader + amount +
                                        streamSizes_.cbTrailer);
      std::memcpy(record.data() + streamSizes_.cbHeader, data.data() + offset,
                  amount);
      SecBuffer buffers[4] = {};
      buffers[0].BufferType = SECBUFFER_STREAM_HEADER;
      buffers[0].pvBuffer = record.data();
      buffers[0].cbBuffer = streamSizes_.cbHeader;
      buffers[1].BufferType = SECBUFFER_DATA;
      buffers[1].pvBuffer = record.data() + streamSizes_.cbHeader;
      buffers[1].cbBuffer = static_cast<unsigned long>(amount);
      buffers[2].BufferType = SECBUFFER_STREAM_TRAILER;
      buffers[2].pvBuffer = record.data() + streamSizes_.cbHeader + amount;
      buffers[2].cbBuffer = streamSizes_.cbTrailer;
      buffers[3].BufferType = SECBUFFER_EMPTY;
      SecBufferDesc description = {SECBUFFER_VERSION, 4, buffers};
      const SECURITY_STATUS status = EncryptMessage(&context_, 0, &description, 0);
      if (status != SEC_E_OK) {
        if (error != nullptr) *error = "TLS 加密发送失败。";
        return false;
      }
      const std::size_t encrypted = static_cast<std::size_t>(buffers[0].cbBuffer) +
                                    buffers[1].cbBuffer + buffers[2].cbBuffer;
      if (!SendRaw(socket_, record.data(), encrypted, cancelled, error)) return false;
      offset += amount;
    }
    return true;
  }

  /* 1=data, 0=no data yet, -1=closed/error. */
  int Receive(std::vector<unsigned char>* output, std::string* error,
              const std::function<bool()>& cancelled) {
    output->clear();
    if (cancelled()) return 0;
    if (!tls_) {
      if (!WaitSocket(socket_, false, kIoWaitMilliseconds)) return 0;
      unsigned char buffer[16384];
      const int amount = recv(socket_, reinterpret_cast<char*>(buffer),
                              sizeof(buffer), 0);
      if (amount > 0) {
        output->assign(buffer, buffer + amount);
        return 1;
      }
      if (error != nullptr) *error = amount == 0 ? "Broker 已关闭连接。" :
          "接收 Broker 数据失败（Winsock " + std::to_string(WSAGetLastError()) + "）。";
      return -1;
    }
    if (!plainPending_.empty()) {
      output->swap(plainPending_);
      return 1;
    }
    const std::uint64_t processingDeadline =
        MonotonicMilliseconds() + 100U;
    for (;;) {
      if (cancelled()) return 0;
      if (MonotonicMilliseconds() >= processingDeadline) {
        return output->empty() ? 0 : 1;
      }
      if (encryptedPending_.empty() || needMoreEncrypted_) {
        if (!WaitSocket(socket_, false, kIoWaitMilliseconds)) return 0;
        unsigned char buffer[16384];
        const int amount = recv(socket_, reinterpret_cast<char*>(buffer),
                                sizeof(buffer), 0);
        if (amount <= 0) {
          if (error != nullptr) *error = amount == 0 ? "Broker 已关闭 TLS 连接。" :
              "接收 TLS 数据失败（Winsock " + std::to_string(WSAGetLastError()) + "）。";
          return -1;
        }
        encryptedPending_.insert(encryptedPending_.end(), buffer,
                                 buffer + amount);
        if (encryptedPending_.size() > kMaximumPacketBytes + 64U * 1024U) {
          if (error != nullptr) *error = "TLS 接收缓冲区超过安全上限。";
          return -1;
        }
        needMoreEncrypted_ = false;
      }
      SecBuffer buffers[4] = {};
      buffers[0].BufferType = SECBUFFER_DATA;
      buffers[0].pvBuffer = encryptedPending_.data();
      buffers[0].cbBuffer = static_cast<unsigned long>(encryptedPending_.size());
      for (int index = 1; index < 4; ++index) buffers[index].BufferType = SECBUFFER_EMPTY;
      SecBufferDesc description = {SECBUFFER_VERSION, 4, buffers};
      const SECURITY_STATUS status = DecryptMessage(&context_, &description, 0, nullptr);
      if (status == SEC_E_INCOMPLETE_MESSAGE) {
        needMoreEncrypted_ = true;
        continue;
      }
      if (status == SEC_I_CONTEXT_EXPIRED) {
        if (error != nullptr) *error = "Broker 已关闭 TLS 会话。";
        return -1;
      }
      if (status != SEC_E_OK && status != SEC_I_RENEGOTIATE) {
        if (error != nullptr) *error = "TLS 记录验证失败。";
        return -1;
      }
      std::vector<unsigned char> extra;
      for (int index = 0; index < 4; ++index) {
        if (buffers[index].BufferType == SECBUFFER_DATA &&
            buffers[index].cbBuffer != 0) {
          const unsigned char* begin =
              static_cast<const unsigned char*>(buffers[index].pvBuffer);
          output->insert(output->end(), begin, begin + buffers[index].cbBuffer);
        } else if (buffers[index].BufferType == SECBUFFER_EXTRA &&
                   buffers[index].cbBuffer != 0) {
          const std::size_t extraSize = buffers[index].cbBuffer;
          extra.assign(encryptedPending_.end() - extraSize,
                       encryptedPending_.end());
        }
      }
      encryptedPending_.swap(extra);
      if (status == SEC_I_RENEGOTIATE) {
        if (error != nullptr) *error = "Broker 请求了不受支持的 TLS 重新协商。";
        return -1;
      }
      if (!output->empty()) return 1;
      if (encryptedPending_.empty()) return 0;
    }
  }

  void Close() {
    plainPending_.clear();
    encryptedPending_.clear();
    needMoreEncrypted_ = false;
    if (hasContext_) {
      DeleteSecurityContext(&context_);
      hasContext_ = false;
    }
    if (hasCredentials_) {
      FreeCredentialsHandle(&credentials_);
      hasCredentials_ = false;
    }
    if (socket_ != INVALID_SOCKET) {
      shutdown(socket_, SD_BOTH);
      closesocket(socket_);
      socket_ = INVALID_SOCKET;
    }
    tls_ = false;
  }

 private:
  bool StartTls(const std::string& host,
                const std::function<bool()>& cancelled, std::string* error) {
    SCHANNEL_CRED settings = {};
    settings.dwVersion = SCHANNEL_CRED_VERSION;
    settings.dwFlags = SCH_CRED_AUTO_CRED_VALIDATION |
                       SCH_CRED_NO_DEFAULT_CREDS;
    settings.grbitEnabledProtocols = SP_PROT_TLS1_2_CLIENT;
#ifdef SP_PROT_TLS1_3_CLIENT
    settings.grbitEnabledProtocols |= SP_PROT_TLS1_3_CLIENT;
#endif
    TimeStamp expiry = {};
    SECURITY_STATUS status = AcquireCredentialsHandleW(
        nullptr, const_cast<wchar_t*>(UNISP_NAME_W), SECPKG_CRED_OUTBOUND,
        nullptr, &settings, nullptr, nullptr, &credentials_, &expiry);
    if (status != SEC_E_OK) {
      if (error != nullptr) *error = "无法初始化 Windows TLS 凭据。";
      return false;
    }
    hasCredentials_ = true;
    const std::wstring target = Utf8ToWide(host);
    if (target.empty()) {
      if (error != nullptr) *error = "TLS Broker 名称不是有效 UTF-8。";
      return false;
    }
    std::vector<unsigned char> incoming;
    bool first = true;
    const std::uint64_t deadline =
        MonotonicMilliseconds() + kConnectTimeoutMilliseconds;
    const unsigned long requestFlags = ISC_REQ_SEQUENCE_DETECT |
        ISC_REQ_REPLAY_DETECT | ISC_REQ_CONFIDENTIALITY |
        ISC_REQ_EXTENDED_ERROR | ISC_REQ_ALLOCATE_MEMORY | ISC_REQ_STREAM;
    for (;;) {
      if (cancelled()) return false;
      if (MonotonicMilliseconds() >= deadline) {
        if (error != nullptr) *error = "TLS 握手超时。";
        return false;
      }
      SecBuffer inputBuffers[2] = {};
      inputBuffers[0].BufferType = SECBUFFER_TOKEN;
      inputBuffers[0].pvBuffer = incoming.empty() ? nullptr : incoming.data();
      inputBuffers[0].cbBuffer = static_cast<unsigned long>(incoming.size());
      inputBuffers[1].BufferType = SECBUFFER_EMPTY;
      SecBufferDesc inputDescription = {SECBUFFER_VERSION, 2, inputBuffers};
      SecBuffer outputBuffer = {0, SECBUFFER_TOKEN, nullptr};
      SecBufferDesc outputDescription = {SECBUFFER_VERSION, 1, &outputBuffer};
      unsigned long attributes = 0;
      status = InitializeSecurityContextW(
          &credentials_, first ? nullptr : &context_,
          const_cast<wchar_t*>(target.c_str()), requestFlags, 0,
          SECURITY_NATIVE_DREP, first || incoming.empty() ? nullptr : &inputDescription,
          0, &context_, &outputDescription, &attributes, &expiry);
      if (first && (status == SEC_I_CONTINUE_NEEDED || status == SEC_E_OK ||
                    status == SEC_I_COMPLETE_NEEDED ||
                    status == SEC_I_COMPLETE_AND_CONTINUE)) {
        hasContext_ = true;
      }
      first = false;
      if (status == SEC_I_COMPLETE_NEEDED ||
          status == SEC_I_COMPLETE_AND_CONTINUE) {
        if (CompleteAuthToken(&context_, &outputDescription) != SEC_E_OK) {
          if (outputBuffer.pvBuffer != nullptr) {
            FreeContextBuffer(outputBuffer.pvBuffer);
          }
          if (error != nullptr) *error = "TLS 握手令牌无法完成。";
          return false;
        }
        status = status == SEC_I_COMPLETE_NEEDED
                     ? SEC_E_OK
                     : SEC_I_CONTINUE_NEEDED;
      }
      if (outputBuffer.pvBuffer != nullptr && outputBuffer.cbBuffer != 0) {
        const bool sent = SendRaw(
            socket_, static_cast<const unsigned char*>(outputBuffer.pvBuffer),
            outputBuffer.cbBuffer, cancelled, error);
        FreeContextBuffer(outputBuffer.pvBuffer);
        if (!sent) return false;
      }
      if (status == SEC_E_OK) {
        if (inputBuffers[1].BufferType == SECBUFFER_EXTRA) {
          const std::size_t extra = inputBuffers[1].cbBuffer;
          encryptedPending_.assign(incoming.end() - extra, incoming.end());
        }
        break;
      }
      if (status != SEC_I_CONTINUE_NEEDED &&
          status != SEC_I_COMPLETE_AND_CONTINUE &&
          status != SEC_E_INCOMPLETE_MESSAGE) {
        if (error != nullptr) {
          *error = "TLS 握手或系统证书验证失败（0x" +
                   EncodeHex(reinterpret_cast<const unsigned char*>(&status),
                             sizeof(status)) + "）。";
        }
        return false;
      }
      if (status != SEC_E_INCOMPLETE_MESSAGE &&
          inputBuffers[1].BufferType == SECBUFFER_EXTRA) {
        const std::size_t extra = inputBuffers[1].cbBuffer;
        std::vector<unsigned char> remaining(incoming.end() - extra,
                                             incoming.end());
        incoming.swap(remaining);
      } else if (status != SEC_E_INCOMPLETE_MESSAGE) {
        incoming.clear();
      }
      const bool needsMoreInput =
          status == SEC_E_INCOMPLETE_MESSAGE || incoming.empty();
      if (needsMoreInput) {
        while (!cancelled() && MonotonicMilliseconds() < deadline &&
               !WaitSocket(socket_, false, kIoWaitMilliseconds)) {
          // Do not call InitializeSecurityContext with an empty token. When
          // SECBUFFER_EXTRA already retained another record, the loop above
          // deliberately continues without waiting for the socket.
        }
        if (cancelled()) return false;
        if (MonotonicMilliseconds() >= deadline) {
          if (error != nullptr) *error = "TLS 握手超时。";
          return false;
        }
        unsigned char buffer[16384];
        const int amount = recv(socket_, reinterpret_cast<char*>(buffer),
                                sizeof(buffer), 0);
        if (amount <= 0) {
          if (error != nullptr) *error = "TLS 握手期间 Broker 关闭了连接。";
          return false;
        }
        incoming.insert(incoming.end(), buffer, buffer + amount);
        if (incoming.size() > 256U * 1024U) {
          if (error != nullptr) *error = "TLS 握手数据超过安全上限。";
          return false;
        }
      }
    }
    status = QueryContextAttributesW(&context_, SECPKG_ATTR_STREAM_SIZES,
                                     &streamSizes_);
    if (status != SEC_E_OK || streamSizes_.cbMaximumMessage == 0) {
      if (error != nullptr) *error = "无法读取 TLS 流参数。";
      return false;
    }
    return true;
  }

  SOCKET socket_{INVALID_SOCKET};
  bool tls_{};
  bool hasCredentials_{};
  bool hasContext_{};
  bool needMoreEncrypted_{};
  CredHandle credentials_{};
  CtxtHandle context_{};
  SecPkgContext_StreamSizes streamSizes_{};
  std::vector<unsigned char> encryptedPending_;
  std::vector<unsigned char> plainPending_;
};

struct StartOptions {
  std::string host;
  std::uint16_t port{};
  std::string clientId;
  std::string username;
  std::string password;
  std::uint16_t keepAlive{};
  bool cleanSession{};
  bool tls{};
};

struct Command {
  std::string type;
  std::uint64_t eventGeneration{};
  StartOptions start;
  std::string topic;
  std::uint8_t qos{};
  bool retain{};
  std::vector<unsigned char> payload;
  std::size_t StorageBytes() const {
    return sizeof(Command) + start.host.size() + start.clientId.size() +
           start.username.size() + start.password.size() + topic.size() +
           payload.size();
  }
};

struct PendingAction {
  std::string type;
  std::string topic;
  std::uint8_t qos{};
};

struct IncomingQos2 {
  std::string topic;
  std::uint8_t qos{};
  bool retain{};
  std::vector<unsigned char> payload;
};

std::uint16_t ReadU16(const unsigned char* data) {
  return static_cast<std::uint16_t>((data[0] << 8U) | data[1]);
}

bool ReadMqttString(const std::vector<unsigned char>& packet,
                    std::size_t* offset, std::string* output) {
  if (offset == nullptr || output == nullptr ||
      *offset + 2U > packet.size()) return false;
  const std::size_t size = ReadU16(packet.data() + *offset);
  *offset += 2U;
  if (size > packet.size() - *offset) return false;
  output->assign(reinterpret_cast<const char*>(packet.data() + *offset), size);
  *offset += size;
  if (output->find('\0') != std::string::npos) return false;
  if (output->empty()) return true;
  return MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, output->data(),
                             static_cast<int>(output->size()), nullptr, 0) > 0;
}

std::string ConnackError(unsigned char code) {
  switch (code) {
    case 1: return "Broker 不支持当前 MQTT 协议版本。";
    case 2: return "Broker 拒绝了客户端 ID。";
    case 3: return "Broker 服务不可用。";
    case 4: return "MQTT 用户名或密码错误。";
    case 5: return "Broker 未授权此客户端。";
    default: return "Broker 返回了未知 CONNACK 错误。";
  }
}

}  // namespace

class MqttDebugService::Impl final {
 public:
  Impl() { worker_ = std::thread(&Impl::WorkerEntry, this); }
  ~Impl() { Shutdown(); }

  nlohmann::json Handle(const std::string& action,
                        const nlohmann::json& payload) {
    if (!payload.is_object()) throw std::invalid_argument("MQTT 请求必须是对象。");
    if (action == "poll") return Poll();
    if (action == "start") return QueueStart(payload);
    if (action == "stop") return QueueStop();
    if (action == "subscribe" || action == "unsubscribe") {
      return QueueSubscription(action, payload);
    }
    if (action == "publish") return QueuePublish(payload);
    throw std::invalid_argument("不支持的 MQTT 操作。");
  }

  void Shutdown() {
    std::lock_guard<std::mutex> lifecycleLock(lifecycleMutex_);
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (shutdown_) return;
      shutdown_ = true;
      for (std::deque<Command>::iterator command = commands_.begin();
           command != commands_.end(); ++command) {
        WipeString(&command->start.password);
      }
      commands_.clear();
      pendingBytes_ = 0;
    }
    wake_.notify_all();
    if (worker_.joinable()) worker_.join();
    ResetSessionState();
    SetState("stopped");
  }

 private:
  nlohmann::json QueueStart(const nlohmann::json& payload) {
    StartOptions options;
    std::int64_t port = 0;
    std::int64_t keepAlive = 0;
    bool hasUsername = false;
    if (!ReadString(payload, "host", 253U, false, &options.host) ||
        !ReadInteger(payload, "port", 1, 65535, &port) ||
        !ReadString(payload, "clientId", 128U, false, &options.clientId) ||
        !ReadString(payload, "username", 512U, true, &options.username) ||
        !ReadString(payload, "password", 512U, true, &options.password) ||
        !ReadInteger(payload, "keepAlive", 5, 3600, &keepAlive) ||
        !ReadBoolean(payload, "cleanSession", &options.cleanSession) ||
        !ReadBoolean(payload, "tls", &options.tls) ||
        !IsSafeHost(options.host)) {
      throw std::invalid_argument("Broker、端口或会话参数无效。");
    }
    if (!options.cleanSession) {
      throw std::invalid_argument("首版 MQTT 客户端仅支持新会话连接。");
    }
    const nlohmann::json::const_iterator user = payload.find("username");
    hasUsername = user != payload.end() && user->is_string() &&
                  !user->get<std::string>().empty();
    if (!options.password.empty() && !hasUsername) {
      throw std::invalid_argument("填写密码时必须同时填写用户名。");
    }
    options.port = static_cast<std::uint16_t>(port);
    options.keepAlive = static_cast<std::uint16_t>(keepAlive);
    EnsureWorker();
    Command command;
    command.type = "start";
    command.start = std::move(options);
    {
      std::lock_guard<std::mutex> lock(mutex_);
      for (std::deque<Command>::iterator queued = commands_.begin();
           queued != commands_.end(); ++queued) {
        WipeString(&queued->start.password);
      }
      commands_.clear();
      // A newly requested session owns a new history. Close the old event
      // boundary while holding the same lock used by Poll/PushEvent.
      command.eventGeneration = ++eventGeneration_;
      events_.clear();
      eventBytes_ = 0;
      pendingBytes_ = command.StorageBytes();
      state_ = "connecting";
      lastError_.clear();
      brokerHost_ = command.start.host;
      brokerPort_ = command.start.port;
      clientId_ = command.start.clientId;
      tls_ = command.start.tls;
      sessionPresent_ = false;
      subscriptions_.clear();
      commands_.push_back(std::move(command));
    }
    wake_.notify_all();
    return Snapshot();
  }

  // Closing the dashboard stops and joins its worker. A later dashboard can
  // safely reuse the service; the next explicit start creates a fresh worker.
  void EnsureWorker() {
    std::lock_guard<std::mutex> lifecycleLock(lifecycleMutex_);
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (!shutdown_) return;
    }
    if (worker_.joinable()) worker_.join();
    {
      std::lock_guard<std::mutex> lock(mutex_);
      shutdown_ = false;
    }
    worker_ = std::thread(&Impl::WorkerEntry, this);
  }

  nlohmann::json QueueStop() {
    Command command;
    command.type = "stop";
    {
      std::lock_guard<std::mutex> lock(mutex_);
      for (std::deque<Command>::iterator queued = commands_.begin();
           queued != commands_.end(); ++queued) {
        WipeString(&queued->start.password);
      }
      commands_.clear();
      pendingBytes_ = command.StorageBytes();
      commands_.push_back(command);
      if (state_ != "stopped") state_ = "stopping";
    }
    wake_.notify_all();
    return Snapshot();
  }

  nlohmann::json QueueSubscription(const std::string& action,
                                   const nlohmann::json& payload) {
    Command command;
    command.type = action;
    std::int64_t qos = 0;
    if (!ReadString(payload, "topic", 65535U, false, &command.topic) ||
        !cy_mqtt_valid_topic_filter(command.topic.c_str()) ||
        (action == "subscribe" &&
         !ReadInteger(payload, "qos", 0, 2, &qos))) {
      throw std::invalid_argument("订阅主题或 QoS 无效。");
    }
    command.qos = static_cast<std::uint8_t>(qos);
    EnqueueConnected(command);
    return Snapshot();
  }

  nlohmann::json QueuePublish(const nlohmann::json& payload) {
    Command command;
    command.type = "publish";
    std::string dataHex;
    std::int64_t qos = 0;
    if (!ReadString(payload, "topic", 65535U, false, &command.topic) ||
        !cy_mqtt_valid_topic_name(command.topic.c_str()) ||
        !ReadString(payload, "dataHex", kMaximumPayloadBytes * 2U, true,
                    &dataHex) ||
        !DecodeHex(dataHex, &command.payload) ||
        !ReadInteger(payload, "qos", 0, 2, &qos) ||
        !ReadBoolean(payload, "retain", &command.retain)) {
      throw std::invalid_argument("发布主题、QoS 或载荷无效。");
    }
    command.qos = static_cast<std::uint8_t>(qos);
    EnqueueConnected(command);
    return Snapshot();
  }

  void EnqueueConnected(const Command& command) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (state_ != "connected") {
        throw std::runtime_error("MQTT 客户端尚未连接。");
      }
      if (command.type == "subscribe") {
        std::set<std::string> planned;
        for (std::map<std::string, int>::const_iterator subscription =
                 subscriptions_.begin(); subscription != subscriptions_.end();
             ++subscription) {
          planned.insert(subscription->first);
        }
        for (std::deque<Command>::const_iterator queued = commands_.begin();
             queued != commands_.end(); ++queued) {
          if (queued->type == "subscribe") planned.insert(queued->topic);
          if (queued->type == "unsubscribe") planned.erase(queued->topic);
        }
        if (planned.find(command.topic) == planned.end() &&
            planned.size() >= kMaximumSubscriptions) {
          throw std::runtime_error("MQTT 订阅数量已达到 128 个上限。");
        }
      }
      const std::size_t bytes = command.StorageBytes();
      if (commands_.size() >= 128U || bytes > kMaximumPendingBytes - pendingBytes_) {
        throw std::runtime_error("MQTT 待处理操作已达到上限。");
      }
      commands_.push_back(command);
      pendingBytes_ += bytes;
    }
    wake_.notify_all();
  }

  nlohmann::json Poll() {
    nlohmann::json result;
    std::lock_guard<std::mutex> lock(mutex_);
    result["snapshot"] = SnapshotLocked();
    result["events"] = nlohmann::json::array();
    std::size_t count = 0;
    while (!events_.empty() && count < kMaximumPollCount) {
      result["events"].push_back(events_.front());
      eventBytes_ -= events_.front().dump().size();
      events_.pop_front();
      ++count;
    }
    return result;
  }

  nlohmann::json Snapshot() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return nlohmann::json{{"snapshot", SnapshotLocked()}};
  }

  nlohmann::json SnapshotLocked() const {
    nlohmann::json subscriptions = nlohmann::json::array();
    for (std::map<std::string, int>::const_iterator item = subscriptions_.begin();
         item != subscriptions_.end(); ++item) {
      subscriptions.push_back({{"topic", item->first}, {"qos", item->second}});
    }
    return {{"state", state_}, {"brokerHost", brokerHost_},
            {"brokerPort", brokerPort_}, {"clientId", clientId_},
            {"tls", tls_}, {"sessionPresent", sessionPresent_},
            {"subscriptions", subscriptions}, {"rxMessages", rxMessages_},
            {"rxBytes", rxBytes_}, {"txMessages", txMessages_},
            {"txBytes", txBytes_}, {"lastError", lastError_}};
  }

  bool IsCancelled() const {
    std::lock_guard<std::mutex> lock(mutex_);
    if (shutdown_) return true;
    return !commands_.empty() &&
           (commands_.front().type == "stop" || commands_.front().type == "start");
  }

  bool PopCommand(Command* command) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (commands_.empty()) return false;
    *command = commands_.front();
    pendingBytes_ -= commands_.front().StorageBytes();
    commands_.pop_front();
    return true;
  }

  void SetState(const std::string& state, const std::string& error = std::string()) {
    std::lock_guard<std::mutex> lock(mutex_);
    state_ = state;
    lastError_ = error;
  }

  void PushEvent(const nlohmann::json& event) {
    nlohmann::json stored = event;
    stored["id"] = nextEventId_++;
    stored["timestamp"] = UnixMilliseconds();
    const std::size_t bytes = stored.dump().size();
    std::lock_guard<std::mutex> lock(mutex_);
    // The worker may still be consuming an old receive buffer after QueueStart
    // clears history. Its events must not leak into the pending new session.
    // Stop does not advance this generation, so its final frames remain readable.
    if (workerEventGeneration_ != eventGeneration_) return;
    while (!events_.empty() &&
           (events_.size() >= kMaximumEventCount ||
            bytes > kMaximumEventBytes - eventBytes_)) {
      eventBytes_ -= events_.front().dump().size();
      events_.pop_front();
    }
    if (bytes <= kMaximumEventBytes) {
      events_.push_back(stored);
      eventBytes_ += bytes;
    }
  }

  std::uint16_t NextPacketId() {
    ++nextPacketId_;
    if (nextPacketId_ == 0) ++nextPacketId_;
    while (pending_.find(nextPacketId_) != pending_.end()) {
      ++nextPacketId_;
      if (nextPacketId_ == 0) ++nextPacketId_;
    }
    return nextPacketId_;
  }

  bool SendPacket(Transport* transport, const std::vector<unsigned char>& packet,
                  std::string* error) {
    const std::function<bool()> cancelled = [this]() { return IsCancelled(); };
    const bool sent = transport->Send(packet, cancelled, error);
    if (sent) lastTransmitAt_ = MonotonicMilliseconds();
    return sent;
  }

  bool BuildPacket(const Command& command, std::vector<unsigned char>* packet,
                   std::string* error) {
    const std::size_t capacity = command.payload.size() + command.topic.size() + 32U;
    packet->assign(capacity, 0);
    cy_mqtt_buffer output = {packet->data(), packet->size(), 0};
    const std::uint16_t id = command.qos == 0 && command.type == "publish"
                                 ? 0 : NextPacketId();
    int encoded = 0;
    if (command.type == "subscribe") {
      encoded = cy_mqtt_encode_subscribe(id, command.topic.c_str(), command.qos,
                                         &output);
    } else if (command.type == "unsubscribe") {
      encoded = cy_mqtt_encode_unsubscribe(id, command.topic.c_str(), &output);
    } else if (command.type == "publish") {
      encoded = cy_mqtt_encode_publish(id, command.topic.c_str(),
          command.payload.data(), command.payload.size(), command.qos,
          command.retain ? 1 : 0, &output);
    }
    if (!encoded) {
      if (error != nullptr) *error = "无法编码 MQTT 数据包。";
      return false;
    }
    packet->resize(output.length);
    if (id != 0) {
      PendingAction pending;
      pending.type = command.type;
      pending.topic = command.topic;
      pending.qos = command.qos;
      pending_[id] = pending;
    }
    return true;
  }

  bool ProcessCommand(Transport* transport, const Command& command,
                      std::string* error) {
    if (command.type == "stop" || command.type == "start") return false;
    if (pending_.size() >= kMaximumInflight) {
      if (error != nullptr) *error = "MQTT 等待确认的数据包过多。";
      return false;
    }
    std::vector<unsigned char> packet;
    if (!BuildPacket(command, &packet, error) ||
        !SendPacket(transport, packet, error)) return false;
    if (command.type == "publish") {
      {
        std::lock_guard<std::mutex> lock(mutex_);
        ++txMessages_;
        txBytes_ += command.payload.size();
      }
      PushEvent({{"kind", "published"}, {"topic", command.topic},
                 {"qos", command.qos}, {"retain", command.retain},
                 {"byteLength", command.payload.size()},
                 {"payloadHex", EncodeHex(command.payload.data(), command.payload.size())}});
    }
    return true;
  }

  void ApplyAck(std::uint16_t id, unsigned char type, int grantedQos,
                Transport* transport, std::string* error) {
    std::map<std::uint16_t, PendingAction>::iterator pending = pending_.find(id);
    if (type == 5U && pending != pending_.end() &&
        (pending->second.type == "publish" ||
         pending->second.type == "pubrel") && pending->second.qos == 2U) {
      std::vector<unsigned char> packet(8U);
      cy_mqtt_buffer output = {packet.data(), packet.size(), 0};
      if (!cy_mqtt_encode_packet_id(0x62U, id, &output)) return;
      packet.resize(output.length);
      if (SendPacket(transport, packet, error)) pending->second.type = "pubrel";
      return;
    }
    if (type == 9U && pending != pending_.end() && pending->second.type == "subscribe") {
      if (grantedQos >= 0) pending->second.qos = static_cast<std::uint8_t>(grantedQos);
      {
        std::lock_guard<std::mutex> lock(mutex_);
        if (subscriptions_.find(pending->second.topic) == subscriptions_.end() &&
            subscriptions_.size() >= kMaximumSubscriptions) {
          if (error != nullptr) *error = "MQTT 订阅数量已达到 128 个上限。";
          return;
        }
        subscriptions_[pending->second.topic] = pending->second.qos;
      }
      PushEvent({{"kind", "status"},
                 {"message", "已订阅 " + pending->second.topic + "。"}});
      pending_.erase(pending);
    } else if (type == 11U && pending != pending_.end() &&
               pending->second.type == "unsubscribe") {
      {
        std::lock_guard<std::mutex> lock(mutex_);
        subscriptions_.erase(pending->second.topic);
      }
      PushEvent({{"kind", "status"},
                 {"message", "已取消订阅 " + pending->second.topic + "。"}});
      pending_.erase(pending);
    } else if (type == 4U && pending != pending_.end() &&
               pending->second.type == "publish" &&
               pending->second.qos == 1U) {
      pending_.erase(pending);
    } else if (type == 7U && pending != pending_.end() &&
               pending->second.type == "pubrel") {
      pending_.erase(pending);
    }
  }

  bool SendPacketId(Transport* transport, unsigned char firstByte,
                    std::uint16_t id, std::string* error) {
    std::vector<unsigned char> packet(8U);
    cy_mqtt_buffer output = {packet.data(), packet.size(), 0};
    if (!cy_mqtt_encode_packet_id(firstByte, id, &output)) return false;
    packet.resize(output.length);
    return SendPacket(transport, packet, error);
  }

  void DeliverMessage(const std::string& topic, unsigned char qos, bool retain,
                      const std::vector<unsigned char>& payload) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      ++rxMessages_;
      rxBytes_ += payload.size();
    }
    PushEvent({{"kind", "message"}, {"topic", topic}, {"qos", qos},
               {"retain", retain}, {"byteLength", payload.size()},
               {"payloadHex", EncodeHex(payload.data(), payload.size())}});
  }

  bool ProcessPacket(const std::vector<unsigned char>& packet,
                     std::size_t headerSize, Transport* transport,
                     bool waitingConnack, bool* connackReceived,
                     std::string* error) {
    const unsigned char first = packet[0];
    const unsigned char type = static_cast<unsigned char>(first >> 4U);
    if (waitingConnack) {
      if (first != 0x20U || packet.size() != headerSize + 2U ||
          packet[headerSize] != 0U) {
        *error = "Broker 返回了无效 CONNACK。";
        return false;
      }
      if (packet[headerSize + 1U] != 0U) {
        *error = ConnackError(packet[headerSize + 1U]);
        return false;
      }
      {
        std::lock_guard<std::mutex> lock(mutex_);
        state_ = "connected";
        sessionPresent_ = packet[headerSize] == 1U;
      }
      *connackReceived = true;
      PushEvent({{"kind", "status"}, {"message", "MQTT Broker 已连接。"}});
      return true;
    }
    if (type == 3U) {
      std::size_t offset = headerSize;
      std::string topic;
      if (!ReadMqttString(packet, &offset, &topic) ||
          !cy_mqtt_valid_topic_name(topic.c_str())) {
        *error = "Broker 返回了无效 PUBLISH 主题。";
        return false;
      }
      const unsigned char qos = static_cast<unsigned char>((first >> 1U) & 0x03U);
      if (qos == 3U) {
        *error = "Broker 返回了保留的 QoS 值。";
        return false;
      }
      std::uint16_t packetId = 0;
      if (qos != 0) {
        if (offset + 2U > packet.size()) {
          *error = "Broker 的 PUBLISH 缺少数据包标识。";
          return false;
        }
        packetId = ReadU16(packet.data() + offset);
        offset += 2U;
        if (packetId == 0) return false;
      }
      std::vector<unsigned char> payload(packet.begin() + offset, packet.end());
      if (payload.size() > kMaximumPayloadBytes) {
        *error = "收到的 MQTT 载荷超过 256 KiB 上限。";
        return false;
      }
      if (qos == 0) {
        DeliverMessage(topic, qos, (first & 1U) != 0, payload);
      } else if (qos == 1) {
        DeliverMessage(topic, qos, (first & 1U) != 0, payload);
        if (!SendPacketId(transport, 0x40U, packetId, error)) return false;
      } else {
        if ((incomingQos2_.size() >= kMaximumInflight ||
             payload.size() > kMaximumPendingBytes - incomingQos2Bytes_) &&
            incomingQos2_.find(packetId) == incomingQos2_.end()) {
          *error = "收到的 QoS 2 等待队列已满。";
          return false;
        }
        if (incomingQos2_.find(packetId) == incomingQos2_.end()) {
          IncomingQos2 incoming;
          incoming.topic = topic;
          incoming.qos = qos;
          incoming.retain = (first & 1U) != 0;
          incoming.payload.swap(payload);
          incomingQos2Bytes_ += incoming.payload.size();
          incomingQos2_[packetId] = incoming;
        }
        if (!SendPacketId(transport, 0x50U, packetId, error)) return false;
      }
      return true;
    }
    if (type == 6U) {
      if (packet.size() != headerSize + 2U || (first & 0x0fU) != 2U) {
        *error = "Broker 返回了无效 PUBREL。";
        return false;
      }
      const std::uint16_t id = ReadU16(packet.data() + headerSize);
      if (id == 0) {
        *error = "Broker 返回了无效 PUBREL 数据包标识。";
        return false;
      }
      std::map<std::uint16_t, IncomingQos2>::iterator incoming = incomingQos2_.find(id);
      if (incoming != incomingQos2_.end()) {
        DeliverMessage(incoming->second.topic, incoming->second.qos,
                       incoming->second.retain, incoming->second.payload);
        incomingQos2Bytes_ -= incoming->second.payload.size();
        incomingQos2_.erase(incoming);
      }
      return SendPacketId(transport, 0x70U, id, error);
    }
    if (type == 4U || type == 5U || type == 7U || type == 11U) {
      const unsigned char expected = static_cast<unsigned char>(type << 4U);
      if (first != expected || packet.size() != headerSize + 2U ||
          ReadU16(packet.data() + headerSize) == 0) {
        *error = "Broker 返回了无效确认包。";
        return false;
      }
      ApplyAck(ReadU16(packet.data() + headerSize), type, -1, transport, error);
      return error->empty();
    }
    if (type == 9U) {
      if (first != 0x90U || packet.size() != headerSize + 3U ||
          ReadU16(packet.data() + headerSize) == 0 ||
          packet[headerSize + 2U] > 2U) {
        *error = "Broker 拒绝订阅或返回了无效 SUBACK。";
        return false;
      }
      ApplyAck(ReadU16(packet.data() + headerSize), type,
               packet[headerSize + 2U], transport, error);
      return error->empty();
    }
    if (type == 13U) {
      if (first != 0xd0U || packet.size() != headerSize) {
        *error = "Broker 返回了无效 PINGRESP。";
        return false;
      }
      pingOutstanding_ = false;
      return true;
    }
    *error = "Broker 返回了当前客户端不支持的数据包。";
    return false;
  }

  bool ConsumeFrames(std::vector<unsigned char>* receiveBuffer,
                     Transport* transport, bool waitingConnack,
                     bool* connackReceived, std::string* error) {
    bool awaitingConnack = waitingConnack;
    while (!receiveBuffer->empty()) {
      std::size_t frameSize = 0;
      std::size_t headerSize = 0;
      const int result = cy_mqtt_frame_length(
          receiveBuffer->data(), receiveBuffer->size(), kMaximumPacketBytes,
          &frameSize, &headerSize);
      if (result == 0) return true;
      if (result < 0) {
        *error = "Broker 返回的 MQTT 数据包无效或过大。";
        return false;
      }
      std::vector<unsigned char> packet(receiveBuffer->begin(),
                                        receiveBuffer->begin() + frameSize);
      receiveBuffer->erase(receiveBuffer->begin(),
                           receiveBuffer->begin() + frameSize);
      bool receivedConnackNow = false;
      if (!ProcessPacket(packet, headerSize, transport, awaitingConnack,
                         &receivedConnackNow, error)) return false;
      if (receivedConnackNow) {
        awaitingConnack = false;
        *connackReceived = true;
      }
    }
    return true;
  }

  bool OpenSession(const StartOptions& requested, Transport* transport,
                   StartOptions* active) {
    *active = requested;
    const std::function<bool()> cancelled = [this]() { return IsCancelled(); };
    std::string error;
    if (!transport->Connect(active->host, active->port, active->tls,
                            cancelled, &error)) {
      if (!IsCancelled()) Fail(error);
      return false;
    }
    const std::size_t capacity = active->clientId.size() + active->username.size() +
                                 active->password.size() + 64U;
    std::vector<unsigned char> connectPacket(capacity);
    cy_mqtt_buffer output = {connectPacket.data(), connectPacket.size(), 0};
    cy_mqtt_connect_options options = {};
    options.client_id = active->clientId.c_str();
    options.username = active->username.empty() ? nullptr : active->username.c_str();
    options.password = active->password.empty() ? nullptr : active->password.c_str();
    options.keep_alive_seconds = active->keepAlive;
    options.clean_session = active->cleanSession ? 1 : 0;
    if (!cy_mqtt_encode_connect(&options, &output)) {
      std::fill(active->password.begin(), active->password.end(), '\0');
      Fail("无法编码 MQTT CONNECT。");
      return false;
    }
    connectPacket.resize(output.length);
    if (!transport->Send(connectPacket, cancelled, &error)) {
      std::fill(active->password.begin(), active->password.end(), '\0');
      if (!IsCancelled()) Fail(error);
      return false;
    }
    lastTransmitAt_ = MonotonicMilliseconds();
    std::fill(active->password.begin(), active->password.end(), '\0');
    return true;
  }

  void Fail(const std::string& error) {
    SetState("error", error.empty() ? "MQTT 会话失败。" : error);
    PushEvent({{"kind", "error"},
               {"message", error.empty() ? "MQTT 会话失败。" : error}});
  }

  void ResetSessionState() {
    pending_.clear();
    incomingQos2_.clear();
    incomingQos2Bytes_ = 0;
    pingOutstanding_ = false;
    std::lock_guard<std::mutex> lock(mutex_);
    subscriptions_.clear();
    sessionPresent_ = false;
  }

  void WorkerMain() {
    WSADATA winsock = {};
    if (WSAStartup(MAKEWORD(2, 2), &winsock) != 0) {
      Fail("无法初始化 Windows 网络组件。");
      return;
    }
    struct WinsockCleanup {
      ~WinsockCleanup() { WSACleanup(); }
    } winsockCleanup;
    Transport transport;
    StartOptions active;
    bool sessionOpen = false;
    bool mqttConnected = false;
    bool waitingConnack = false;
    std::uint64_t connackDeadline = 0;
    std::uint64_t pingSentAt = 0;
    std::vector<unsigned char> receiveBuffer;
    while (true) {
      {
        std::unique_lock<std::mutex> lock(mutex_);
        if (shutdown_) break;
        if (!sessionOpen && commands_.empty()) {
          wake_.wait(lock, [this]() { return shutdown_ || !commands_.empty(); });
          if (shutdown_) break;
        }
      }

      Command command;
      while (PopCommand(&command)) {
        if (command.type == "start") {
          workerEventGeneration_ = command.eventGeneration;
          transport.Close();
          ResetSessionState();
          receiveBuffer.clear();
          sessionOpen = OpenSession(command.start, &transport, &active);
          WipeString(&command.start.password);
          mqttConnected = false;
          waitingConnack = sessionOpen;
          connackDeadline = MonotonicMilliseconds() + kConnectTimeoutMilliseconds;
          break;
        }
        if (command.type == "stop") {
          // Stop is a hard cancellation boundary. Closing the socket is safe;
          // a best-effort DISCONNECT must never delay dashboard shutdown.
          transport.Close();
          ResetSessionState();
          sessionOpen = false;
          mqttConnected = false;
          waitingConnack = false;
          SetState("stopped");
          PushEvent({{"kind", "status"}, {"message", "MQTT 客户端已断开。"}});
          break;
        }
        if (!mqttConnected) continue;
        std::string error;
        if (!ProcessCommand(&transport, command, &error)) {
          transport.Close();
          sessionOpen = false;
          mqttConnected = false;
          waitingConnack = false;
          Fail(error);
          break;
        }
      }
      if (!sessionOpen) continue;

      std::vector<unsigned char> incoming;
      std::string error;
      const int received = transport.Receive(
          &incoming, &error, [this]() { return IsCancelled(); });
      if (received < 0) {
        transport.Close();
        sessionOpen = false;
        mqttConnected = false;
        waitingConnack = false;
        Fail(error);
        continue;
      }
      if (received > 0) {
        if (incoming.size() > kMaximumPacketBytes - receiveBuffer.size()) {
          transport.Close();
          sessionOpen = false;
          mqttConnected = false;
          waitingConnack = false;
          Fail("MQTT 接收缓冲区超过 1 MiB 上限。");
          continue;
        }
        receiveBuffer.insert(receiveBuffer.end(), incoming.begin(), incoming.end());
        bool connackReceived = false;
        if (!ConsumeFrames(&receiveBuffer, &transport, waitingConnack,
                           &connackReceived, &error)) {
          transport.Close();
          sessionOpen = false;
          mqttConnected = false;
          waitingConnack = false;
          Fail(error);
          continue;
        }
        if (connackReceived) {
          waitingConnack = false;
          mqttConnected = true;
        }
      }
      const std::uint64_t now = MonotonicMilliseconds();
      if (waitingConnack && now >= connackDeadline) {
        transport.Close();
        sessionOpen = false;
        waitingConnack = false;
        Fail("等待 MQTT CONNACK 超时。");
        continue;
      }
      if (mqttConnected) {
        const std::uint64_t keepAliveMs =
            static_cast<std::uint64_t>(active.keepAlive) * 1000U;
        if (pingOutstanding_ && now - pingSentAt >= keepAliveMs) {
          transport.Close();
          sessionOpen = false;
          mqttConnected = false;
          Fail("等待 MQTT PINGRESP 超时。");
          continue;
        }
        if (!pingOutstanding_ && now - lastTransmitAt_ >= keepAliveMs / 2U) {
          std::vector<unsigned char> ping(4U);
          cy_mqtt_buffer output = {ping.data(), ping.size(), 0};
          if (!cy_mqtt_encode_simple(0xc0U, &output)) continue;
          ping.resize(output.length);
          if (!SendPacket(&transport, ping, &error)) {
            transport.Close();
            sessionOpen = false;
            mqttConnected = false;
            Fail(error);
            continue;
          }
          pingOutstanding_ = true;
          pingSentAt = now;
        }
      }
    }
    transport.Close();
  }

  void WorkerEntry() noexcept {
    try {
      WorkerMain();
    } catch (const std::exception& error) {
      try { Fail(std::string("MQTT 后台任务异常：") + error.what()); }
      catch (...) { /* A worker exception must never terminate the process. */ }
    } catch (...) {
      try { Fail("MQTT 后台任务发生未知异常。"); }
      catch (...) { /* Preserve process lifetime even under allocation failure. */ }
    }
  }

  mutable std::mutex mutex_;
  std::mutex lifecycleMutex_;
  std::condition_variable wake_;
  std::thread worker_;
  bool shutdown_{};
  std::deque<Command> commands_;
  std::size_t pendingBytes_{};
  std::deque<nlohmann::json> events_;
  std::size_t eventBytes_{};
  std::uint64_t eventGeneration_{};  // mutex_ protects requested session boundary.
  std::uint64_t workerEventGeneration_{};  // Only read/written by the worker.
  std::uint64_t nextEventId_{1};
  std::string state_{"stopped"};
  std::string brokerHost_{"127.0.0.1"};
  std::uint16_t brokerPort_{1883};
  std::string clientId_{"cloudyi-client"};
  bool tls_{};
  bool sessionPresent_{};
  std::map<std::string, int> subscriptions_;
  std::uint64_t rxMessages_{};
  std::uint64_t rxBytes_{};
  std::uint64_t txMessages_{};
  std::uint64_t txBytes_{};
  std::string lastError_;
  std::uint16_t nextPacketId_{};
  std::map<std::uint16_t, PendingAction> pending_;
  std::map<std::uint16_t, IncomingQos2> incomingQos2_;
  std::size_t incomingQos2Bytes_{};
  bool pingOutstanding_{};
  std::uint64_t lastTransmitAt_{};
};

MqttDebugService::MqttDebugService() : impl_(new Impl()) {}
MqttDebugService::~MqttDebugService() = default;

nlohmann::json MqttDebugService::Handle(const std::string& action,
                                        const nlohmann::json& payload) {
  return impl_->Handle(action, payload);
}

void MqttDebugService::Stop() { impl_->Shutdown(); }

}  // namespace milo
