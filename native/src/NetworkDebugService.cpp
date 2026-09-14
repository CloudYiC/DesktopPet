#include "Milo/NetworkDebugService.h"

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cctype>
#include <cstring>
#include <deque>
#include <limits>
#include <mutex>
#include <sstream>
#include <thread>
#include <utility>

#include "cloudyi/network_debug.h"

namespace milo {
namespace {

const std::size_t kMaximumPayloadBytes = 64U * 1024U;
const std::size_t kMaximumUdpPayloadBytes = 65507U;
const std::size_t kMaximumPendingBytes = 4U * 1024U * 1024U;
const std::size_t kMaximumEventCount = 1024U;
const std::size_t kMaximumEventBytes = 8U * 1024U * 1024U;
const std::size_t kMaximumPollEventCount = 256U;
const std::size_t kMaximumPollEventBytes = 1U * 1024U * 1024U;
const std::size_t kReceiveBufferBytes = 16U * 1024U;
const std::size_t kMaximumServerPeers = 32U;
const int kPollMilliseconds = 20;
const std::uint64_t kConnectTimeoutMilliseconds = 10000U;

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

bool IsAllowedMode(const std::string& mode) {
  return mode == "tcp-client" || mode == "tcp-server" || mode == "udp";
}

bool IsSafeHostText(const std::string& host, bool allowEmpty) {
  if (host.empty()) return allowEmpty;
  if (host.size() > 253U) return false;
  for (std::string::const_iterator character = host.begin();
       character != host.end(); ++character) {
    const unsigned char value = static_cast<unsigned char>(*character);
    if (value <= 0x20U || value >= 0x7fU) return false;
  }
  return true;
}

std::string NormalizeHost(const std::string& host) {
  if (host.size() > 2U && host[0] == '[' && host[host.size() - 1U] == ']') {
    return host.substr(1U, host.size() - 2U);
  }
  return host;
}

std::string LowerAscii(std::string value) {
  for (std::string::iterator character = value.begin();
       character != value.end(); ++character) {
    *character = static_cast<char>(
        std::tolower(static_cast<unsigned char>(*character)));
  }
  return value;
}

bool IsObviousLoopbackHost(const std::string& rawHost) {
  const std::string host = LowerAscii(NormalizeHost(rawHost));
  if (host == "localhost" || host == "::1") return true;
  if (host.size() >= 4U && host.compare(0U, 4U, "127.") == 0) return true;
  return false;
}

std::string HexEncode(const unsigned char* data, std::size_t size) {
  static const char digits[] = "0123456789abcdef";
  std::string result(size * 2U, '0');
  for (std::size_t index = 0; index < size; ++index) {
    result[index * 2U] = digits[(data[index] >> 4U) & 0x0fU];
    result[index * 2U + 1U] = digits[data[index] & 0x0fU];
  }
  return result;
}

int HexNibble(char character) {
  if (character >= '0' && character <= '9') return character - '0';
  if (character >= 'a' && character <= 'f') return character - 'a' + 10;
  if (character >= 'A' && character <= 'F') return character - 'A' + 10;
  return -1;
}

bool HexDecode(const std::string& text, std::vector<unsigned char>* bytes,
               std::string* error) {
  if (bytes == nullptr) return false;
  bytes->clear();
  bytes->reserve((std::min)(kMaximumPayloadBytes, text.size() / 2U));
  int high = -1;
  bool atStart = true;
  for (std::size_t index = 0; index < text.size(); ++index) {
    const char character = text[index];
    if (std::isspace(static_cast<unsigned char>(character)) ||
        character == '_' || character == ':' || character == '-') {
      continue;
    }
    if (atStart && character == '0' && index + 1U < text.size() &&
        (text[index + 1U] == 'x' || text[index + 1U] == 'X')) {
      ++index;
      atStart = false;
      continue;
    }
    atStart = false;
    const int nibble = HexNibble(character);
    if (nibble < 0) {
      if (error != nullptr) *error = "十六进制数据包含无效字符。";
      return false;
    }
    if (high < 0) {
      high = nibble;
    } else {
      if (bytes->size() >= kMaximumPayloadBytes) {
        if (error != nullptr) *error = "单次发送不能超过 64 KiB。";
        bytes->clear();
        return false;
      }
      bytes->push_back(
          static_cast<unsigned char>((high << 4) | nibble));
      high = -1;
    }
  }
  if (high >= 0) {
    if (error != nullptr) *error = "十六进制数字数量必须为偶数。";
    bytes->clear();
    return false;
  }
  if (bytes->empty()) {
    if (error != nullptr) *error = "请输入需要发送的数据。";
    return false;
  }
  return true;
}

std::string SocketFailure(const std::string& action, int errorCode) {
  return action + "失败（Winsock " + std::to_string(errorCode) + "）。";
}

struct EndpointText {
  std::string host;
  std::uint16_t port{};
};

EndpointText DescribeAddress(const cy_net_address& address) {
  char host[128] = {};
  std::uint16_t port = 0;
  int error = 0;
  EndpointText result;
  if (cy_net_address_text(&address, host, sizeof(host), &port, &error)) {
    result.host = host;
    result.port = port;
  } else {
    result.host = "?";
  }
  return result;
}

std::string EndpointLabel(const EndpointText& endpoint) {
  if (endpoint.host.find(':') != std::string::npos) {
    return "[" + endpoint.host + "]:" + std::to_string(endpoint.port);
  }
  return endpoint.host + ":" + std::to_string(endpoint.port);
}

std::size_t EventStorageBytes(const NetworkDebugEvent& event) {
  return sizeof(NetworkDebugEvent) + event.kind.size() +
         event.peerLabel.size() + event.dataHex.size() + event.message.size();
}

}  // namespace

class NetworkDebugService::Impl final {
 public:
  Impl() = default;
  ~Impl() { Stop(); }

  bool Start(const NetworkDebugStartOptions& requested,
             std::string* error) {
    Stop();

    NetworkDebugStartOptions options = requested;
    options.localHost = NormalizeHost(options.localHost);
    options.remoteHost = NormalizeHost(options.remoteHost);
    if (!ValidateOptions(&options, error)) return false;

    {
      std::lock_guard<std::mutex> lock(mutex_);
      options_ = options;
      snapshot_ = NetworkDebugSnapshot();
      snapshot_.mode = options.mode;
      snapshot_.state = "starting";
      snapshot_.localHost = options.localHost;
      snapshot_.localPort = options.localPort;
      snapshot_.remoteHost = options.remoteHost;
      snapshot_.remotePort = options.remotePort;
      snapshot_.multicastInterface = options.multicastInterface;
      snapshot_.multicastGroup = options.multicastGroup;
      snapshot_.multicastTtl = options.multicastTtl;
      events_.clear();
      eventBytes_ = 0;
      overflowQueued_ = false;
      overflowEventId_ = 0;
      commands_.clear();
      pendingSendBytes_ = 0;
      nextEventId_ = 1;
      stopRequested_ = false;
      workerActive_ = true;
    }
    PushSimpleEvent("system", 0, std::string(), "正在启动网络会话。");

    try {
      worker_ = std::thread(&Impl::WorkerMain, this);
    } catch (const std::exception& exception) {
      {
        std::lock_guard<std::mutex> lock(mutex_);
        workerActive_ = false;
        snapshot_.state = "error";
        snapshot_.lastError = exception.what();
      }
      if (error != nullptr) *error = "无法创建网络工作线程。";
      return false;
    }
    return true;
  }

  void Stop() {
    bool shouldJoin = false;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      shouldJoin = worker_.joinable();
      if (shouldJoin) stopRequested_ = true;
    }
    commandWake_.notify_all();
    if (shouldJoin) worker_.join();

    bool publishStopped = false;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      workerActive_ = false;
      stopRequested_ = false;
      commands_.clear();
      pendingSendBytes_ = 0;
      snapshot_.peers.clear();
      snapshot_.multicastJoined = false;
      snapshot_.lastError.clear();
      if (snapshot_.state != "stopped") {
        snapshot_.state = "stopped";
        publishStopped = true;
      }
    }
    if (publishStopped) {
      PushSimpleEvent("system", 0, std::string(), "网络会话已停止。");
    }
  }

  bool SendHex(const std::string& dataHex, std::uint64_t targetPeerId,
               std::string* error) {
    std::vector<unsigned char> bytes;
    if (!HexDecode(dataHex, &bytes, error)) return false;
    return SendBytes(bytes, targetPeerId, error);
  }

  bool SendBytes(const std::vector<unsigned char>& bytes,
                 std::uint64_t targetPeerId, std::string* error) {
    if (bytes.empty()) {
      if (error != nullptr) *error = "请输入需要发送的数据。";
      return false;
    }
    if (bytes.size() > kMaximumPayloadBytes) {
      if (error != nullptr) *error = "单次发送不能超过 64 KiB。";
      return false;
    }

    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (!workerActive_ || snapshot_.state == "stopped" ||
          snapshot_.state == "error") {
        if (error != nullptr) *error = "网络会话尚未启动。";
        return false;
      }
      if (snapshot_.mode == "udp" &&
          bytes.size() > kMaximumUdpPayloadBytes) {
        if (error != nullptr) *error = "UDP 数据报不能超过 65507 字节。";
        return false;
      }
      if (snapshot_.mode == "udp" && targetPeerId != 0) {
        if (error != nullptr) *error = "UDP 模式使用已配置的目标地址。";
        return false;
      }
      if (pendingSendBytes_ > kMaximumPendingBytes - bytes.size()) {
        if (error != nullptr) *error = "待发送数据已达到 4 MiB 上限。";
        return false;
      }
      Command command;
      command.bytes = bytes;
      command.targetPeerId = targetPeerId;
      commands_.push_back(std::move(command));
      pendingSendBytes_ += bytes.size();
    }
    commandWake_.notify_all();
    return true;
  }

  NetworkDebugPollResult Poll() {
    NetworkDebugPollResult result;
    std::lock_guard<std::mutex> lock(mutex_);
    result.snapshot = snapshot_;
    std::size_t deliveredBytes = 0;
    while (!events_.empty() &&
           result.events.size() < kMaximumPollEventCount) {
      const std::size_t bytes = EventStorageBytes(events_.front());
      if (!result.events.empty() &&
          bytes > kMaximumPollEventBytes - deliveredBytes) {
        break;
      }
      deliveredBytes += bytes;
      eventBytes_ -= bytes;
      if (events_.front().id == overflowEventId_) {
        overflowQueued_ = false;
        overflowEventId_ = 0;
      }
      result.events.push_back(std::move(events_.front()));
      events_.pop_front();
    }
    return result;
  }

  NetworkDebugSnapshot Snapshot() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return snapshot_;
  }

 private:
  struct PendingSend {
    std::vector<unsigned char> bytes;
    std::size_t offset{};
  };

  struct PeerSocket {
    std::uint64_t id{};
    cy_net_socket socket{CY_NET_INVALID_SOCKET};
    EndpointText endpoint;
    std::deque<PendingSend> sends;
  };

  struct Command {
    std::vector<unsigned char> bytes;
    std::uint64_t targetPeerId{};
  };

  enum WatchKind { WatchListener, WatchPrimary, WatchServerPeer };

  struct WatchRef {
    WatchKind kind{WatchPrimary};
    std::uint64_t peerId{};
  };

  bool ValidateOptions(NetworkDebugStartOptions* options,
                       std::string* error) const {
    if (options == nullptr || !IsAllowedMode(options->mode)) {
      if (error != nullptr) *error = "网络模式无效。";
      return false;
    }
    if (options->localHost.empty() && options->mode != "tcp-client") {
      options->localHost = "127.0.0.1";
    }
    if (!IsSafeHostText(options->localHost, true) ||
        !IsSafeHostText(options->remoteHost,
                        options->mode == "tcp-server")) {
      if (error != nullptr) *error = "主机地址无效或过长。";
      return false;
    }
    if (options->mode != "tcp-server" &&
        (options->remoteHost.empty() || options->remotePort == 0)) {
      if (error != nullptr) *error = "TCP 客户端和 UDP 需要目标地址与端口。";
      return false;
    }
    if (!options->localHost.empty() && !options->allowLan &&
        !IsObviousLoopbackHost(options->localHost)) {
      if (error != nullptr) {
        *error = "绑定非回环地址前必须明确允许局域网访问。";
      }
      return false;
    }
    if (options->multicastTtl < 0 || options->multicastTtl > 255) {
      if (error != nullptr) *error = "组播 TTL 必须为 0 到 255。";
      return false;
    }
    if (options->mode != "udp" && (!options->multicastInterface.empty() ||
        !options->multicastGroup.empty() || options->multicastTtl != 1)) {
      if (error != nullptr) *error = "组播设置仅适用于 UDP。";
      return false;
    }
    if (!options->multicastGroup.empty() &&
        !cy_net_ipv4_is_multicast(options->multicastGroup.c_str())) {
      if (error != nullptr) *error = "接收组必须为 224.0.0.0 到 239.255.255.255 的 IPv4 组播地址。";
      return false;
    }
    if (!options->multicastGroup.empty() && options->localHost != "0.0.0.0") {
      if (error != nullptr) *error = "加入组播接收组需要绑定 0.0.0.0，并单独选择收发网卡。";
      return false;
    }
    const bool multicast = !options->multicastGroup.empty() ||
        cy_net_ipv4_is_multicast(options->remoteHost.c_str());
    if (multicast && !options->allowLan &&
        (!IsObviousLoopbackHost(options->localHost) ||
         !IsObviousLoopbackHost(options->multicastInterface))) {
      if (error != nullptr) *error = "使用组播网卡或加入接收组前必须明确允许局域网访问。";
      return false;
    }
    int interfaceError = 0;
    if (!options->multicastInterface.empty() &&
        !cy_net_validate_multicast_interface(options->multicastInterface.c_str(),
                                              &interfaceError)) {
      if (error != nullptr) *error = SocketFailure("校验本机组播网卡 IPv4", interfaceError);
      return false;
    }
    return true;
  }

  bool ShouldStop() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return stopRequested_;
  }

  void SetWorkerInactive() {
    std::lock_guard<std::mutex> lock(mutex_);
    workerActive_ = false;
  }

  void PushEvent(NetworkDebugEvent event) {
    if (event.timestamp == 0) event.timestamp = UnixMilliseconds();
    std::lock_guard<std::mutex> lock(mutex_);
    const std::size_t needed = EventStorageBytes(event);
    bool dropped = false;
    while (!events_.empty() &&
           (events_.size() >= kMaximumEventCount ||
            eventBytes_ > kMaximumEventBytes -
                              (std::min)(needed, kMaximumEventBytes))) {
      PopFrontEventLocked();
      dropped = true;
    }
    if (dropped && !overflowQueued_) {
      NetworkDebugEvent overflow;
      overflow.id = nextEventId_++;
      overflow.kind = "system";
      overflow.timestamp = UnixMilliseconds();
      overflow.message = "接收事件过多，较早的显示记录已丢弃。";
      const std::size_t overflowBytes = EventStorageBytes(overflow);
      while (!events_.empty() &&
             (events_.size() + 1U >= kMaximumEventCount ||
              eventBytes_ > kMaximumEventBytes - overflowBytes)) {
        PopFrontEventLocked();
      }
      events_.push_back(overflow);
      eventBytes_ += overflowBytes;
      overflowQueued_ = true;
      overflowEventId_ = overflow.id;
    }
    while (!events_.empty() &&
           (events_.size() >= kMaximumEventCount ||
            eventBytes_ > kMaximumEventBytes -
                              (std::min)(needed, kMaximumEventBytes))) {
      PopFrontEventLocked();
    }
    event.id = nextEventId_++;
    events_.push_back(std::move(event));
    eventBytes_ += needed;
  }

  void PushSimpleEvent(const std::string& kind, std::uint64_t peerId,
                       const std::string& peerLabel,
                       const std::string& message) {
    NetworkDebugEvent event;
    event.kind = kind;
    event.peerId = peerId;
    event.peerLabel = peerLabel;
    event.message = message;
    PushEvent(std::move(event));
  }

  void PopFrontEventLocked() {
    if (events_.empty()) return;
    if (events_.front().id == overflowEventId_) {
      overflowQueued_ = false;
      overflowEventId_ = 0;
    }
    eventBytes_ -= EventStorageBytes(events_.front());
    events_.pop_front();
  }

  void PushDataEvent(const std::string& kind, std::uint64_t peerId,
                     const std::string& peerLabel,
                     const unsigned char* data, std::size_t size) {
    NetworkDebugEvent event;
    event.kind = kind;
    event.peerId = peerId;
    event.peerLabel = peerLabel;
    event.byteLength = size;
    event.dataHex = HexEncode(data, size);
    PushEvent(std::move(event));
  }

  void ChangeState(const std::string& state, const std::string& message) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      snapshot_.state = state;
      if (state != "error") snapshot_.lastError.clear();
    }
    PushSimpleEvent("system", 0, std::string(), message);
  }

  void FailSession(const std::string& message) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      snapshot_.state = "error";
      snapshot_.lastError = message;
    }
    PushSimpleEvent("error", 0, std::string(), message);
  }

  void SetLocalEndpoint(const EndpointText& endpoint) {
    std::lock_guard<std::mutex> lock(mutex_);
    snapshot_.localHost = endpoint.host;
    snapshot_.localPort = endpoint.port;
  }

  void PublishPeers() {
    std::vector<NetworkDebugPeer> result;
    if (options_.mode == "tcp-server") {
      for (std::vector<PeerSocket>::const_iterator peer = serverPeers_.begin();
           peer != serverPeers_.end(); ++peer) {
        NetworkDebugPeer value;
        value.id = peer->id;
        value.address = peer->endpoint.host;
        value.port = peer->endpoint.port;
        result.push_back(value);
      }
    } else if (options_.mode == "tcp-client" && clientConnected_) {
      NetworkDebugPeer value;
      value.id = clientPeerId_;
      value.address = clientEndpoint_.host;
      value.port = clientEndpoint_.port;
      result.push_back(value);
    }
    std::lock_guard<std::mutex> lock(mutex_);
    snapshot_.peers.swap(result);
  }

  void RecordReceive(std::size_t size) {
    std::lock_guard<std::mutex> lock(mutex_);
    ++snapshot_.rxPackets;
    snapshot_.rxBytes += size;
  }

  void RecordSentBytes(std::size_t size) {
    std::lock_guard<std::mutex> lock(mutex_);
    snapshot_.txBytes += size;
    pendingSendBytes_ = pendingSendBytes_ >= size
                            ? pendingSendBytes_ - size
                            : 0;
  }

  void RecordSentPacket() {
    std::lock_guard<std::mutex> lock(mutex_);
    ++snapshot_.txPackets;
  }

  void ReleasePending(std::size_t size) {
    std::lock_guard<std::mutex> lock(mutex_);
    pendingSendBytes_ = pendingSendBytes_ >= size
                            ? pendingSendBytes_ - size
                            : 0;
  }

  bool ReserveAdditionalPending(std::size_t size) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (size > kMaximumPendingBytes - pendingSendBytes_) return false;
    pendingSendBytes_ += size;
    return true;
  }

  std::size_t Remaining(const std::deque<PendingSend>& sends) const {
    std::size_t result = 0;
    for (std::deque<PendingSend>::const_iterator item = sends.begin();
         item != sends.end(); ++item) {
      result += item->bytes.size() - item->offset;
    }
    return result;
  }

  void WorkerMain() {
    int error = 0;
    if (!cy_net_startup(&error)) {
      FailSession(SocketFailure("初始化 Winsock", error));
      SetWorkerInactive();
      return;
    }
    winsockStarted_ = true;

    bool initialized = false;
    if (options_.mode == "tcp-server") {
      initialized = OpenTcpServer();
    } else if (options_.mode == "tcp-client") {
      initialized = OpenTcpClient();
    } else {
      initialized = OpenUdp();
    }
    if (!initialized) {
      CleanupSockets();
      SetWorkerInactive();
      return;
    }

    while (!ShouldStop()) {
      ProcessCommands();
      if (ShouldStop()) break;
      if (!PollSockets()) break;
      if (clientConnecting_ &&
          MonotonicMilliseconds() - connectStartedMilliseconds_ >=
              kConnectTimeoutMilliseconds) {
        FailSession("连接目标超时（10 秒）。");
        break;
      }
    }

    CleanupSockets();
    SetWorkerInactive();
  }

  bool Resolve(const std::string& host, std::uint16_t port, int socketType,
               bool passive, cy_net_address* addresses, int* count,
               int* error) {
    const int resolved = cy_net_resolve(
        host.empty() ? nullptr : host.c_str(), port, socketType,
        passive ? 1 : 0, addresses, CY_NET_MAX_RESOLVED_ADDRESSES, error);
    if (resolved < 1) return false;
    *count = resolved;
    return true;
  }

  bool BindingAllowed(const cy_net_address& address) const {
    return options_.allowLan || cy_net_address_is_loopback(&address);
  }

  bool BindMatchingAddress(cy_net_socket socketValue, int family,
                           const cy_net_address* addresses, int count,
                           int* lastError) {
    for (int index = 0; index < count; ++index) {
      if (cy_net_address_family(&addresses[index]) != family) continue;
      if (!BindingAllowed(addresses[index])) {
        *lastError = 10013;
        continue;
      }
      if (cy_net_bind(socketValue, &addresses[index], lastError)) return true;
    }
    return false;
  }

  bool PrepareSocket(cy_net_socket socketValue, bool exclusive,
                     int* error) {
    if (!cy_net_set_nonblocking(socketValue, 1, error)) return false;
    if (exclusive &&
        !cy_net_set_exclusive_address_use(socketValue, error)) return false;
    return true;
  }

  bool OpenTcpServer() {
    cy_net_address addresses[CY_NET_MAX_RESOLVED_ADDRESSES];
    int count = 0;
    int error = 0;
    std::memset(addresses, 0, sizeof(addresses));
    if (!Resolve(options_.localHost, options_.localPort,
                 CY_NET_SOCKET_STREAM, true, addresses, &count, &error)) {
      FailSession(SocketFailure("解析本地地址", error));
      return false;
    }

    for (int index = 0; index < count; ++index) {
      if (!BindingAllowed(addresses[index])) {
        error = 10013;
        continue;
      }
      cy_net_socket candidate = cy_net_open_socket(&addresses[index], &error);
      if (candidate == CY_NET_INVALID_SOCKET) continue;
      if (!PrepareSocket(candidate, true, &error) ||
          !cy_net_bind(candidate, &addresses[index], &error) ||
          !cy_net_listen(candidate, static_cast<int>(kMaximumServerPeers),
                         &error)) {
        cy_net_close(candidate);
        continue;
      }
      listener_ = candidate;
      cy_net_address local;
      std::memset(&local, 0, sizeof(local));
      if (cy_net_local_address(listener_, &local, &error)) {
        SetLocalEndpoint(DescribeAddress(local));
      }
      ChangeState("listening", "TCP 服务端正在监听。");
      return true;
    }
    FailSession(SocketFailure("监听本地端口", error));
    return false;
  }

  bool OpenTcpClient() {
    cy_net_address remoteAddresses[CY_NET_MAX_RESOLVED_ADDRESSES];
    cy_net_address localAddresses[CY_NET_MAX_RESOLVED_ADDRESSES];
    int remoteCount = 0;
    int localCount = 0;
    int error = 0;
    std::memset(remoteAddresses, 0, sizeof(remoteAddresses));
    std::memset(localAddresses, 0, sizeof(localAddresses));
    if (!Resolve(options_.remoteHost, options_.remotePort,
                 CY_NET_SOCKET_STREAM, false, remoteAddresses, &remoteCount,
                 &error)) {
      FailSession(SocketFailure("解析目标地址", error));
      return false;
    }
    if (!options_.localHost.empty() &&
        !Resolve(options_.localHost, options_.localPort,
                 CY_NET_SOCKET_STREAM, true, localAddresses, &localCount,
                 &error)) {
      FailSession(SocketFailure("解析本地地址", error));
      return false;
    }

    for (int index = 0; index < remoteCount; ++index) {
      cy_net_socket candidate =
          cy_net_open_socket(&remoteAddresses[index], &error);
      if (candidate == CY_NET_INVALID_SOCKET) continue;
      if (!PrepareSocket(candidate, false, &error)) {
        cy_net_close(candidate);
        continue;
      }
      if (localCount > 0 &&
          !BindMatchingAddress(candidate,
                               cy_net_address_family(&remoteAddresses[index]),
                               localAddresses, localCount, &error)) {
        cy_net_close(candidate);
        continue;
      }
      const int result =
          cy_net_connect(candidate, &remoteAddresses[index], &error);
      if (result == CY_NET_RESULT_ERROR) {
        cy_net_close(candidate);
        continue;
      }
      primary_ = candidate;
      clientEndpoint_ = DescribeAddress(remoteAddresses[index]);
      clientPeerId_ = nextPeerId_++;
      clientConnecting_ = result == CY_NET_RESULT_IN_PROGRESS;
      connectStartedMilliseconds_ = MonotonicMilliseconds();
      if (clientConnecting_) {
        ChangeState("connecting", "正在连接 TCP 目标。");
      } else {
        CompleteClientConnection();
      }
      return true;
    }
    FailSession(SocketFailure("连接目标", error));
    return false;
  }

  bool OpenUdp() {
    cy_net_address remoteAddresses[CY_NET_MAX_RESOLVED_ADDRESSES];
    cy_net_address localAddresses[CY_NET_MAX_RESOLVED_ADDRESSES];
    int remoteCount = 0;
    int localCount = 0;
    int error = 0;
    std::string failedAction = "绑定 UDP 端点";
    std::memset(remoteAddresses, 0, sizeof(remoteAddresses));
    std::memset(localAddresses, 0, sizeof(localAddresses));
    if (!Resolve(options_.remoteHost, options_.remotePort,
                 CY_NET_SOCKET_DATAGRAM, false, remoteAddresses, &remoteCount,
                 &error) ||
        !Resolve(options_.localHost, options_.localPort,
                 CY_NET_SOCKET_DATAGRAM, true, localAddresses, &localCount,
                 &error)) {
      FailSession(SocketFailure("解析 UDP 地址", error));
      return false;
    }

    for (int remoteIndex = 0; remoteIndex < remoteCount; ++remoteIndex) {
      const int family = cy_net_address_family(&remoteAddresses[remoteIndex]);
      const bool multicast = !options_.multicastGroup.empty() ||
          cy_net_ipv4_is_multicast(DescribeAddress(remoteAddresses[remoteIndex]).host.c_str());
      if (multicast && !options_.allowLan &&
          (!IsObviousLoopbackHost(options_.localHost) ||
           !IsObviousLoopbackHost(options_.multicastInterface))) {
        FailSession("组播目标解析成功，但尚未明确允许局域网访问。");
        return false;
      }
      for (int localIndex = 0; localIndex < localCount; ++localIndex) {
        if (cy_net_address_family(&localAddresses[localIndex]) != family ||
            !BindingAllowed(localAddresses[localIndex])) {
          continue;
        }
        cy_net_socket candidate =
            cy_net_open_socket(&remoteAddresses[remoteIndex], &error);
        if (candidate == CY_NET_INVALID_SOCKET) continue;
        if (!PrepareSocket(candidate, true, &error) ||
            !cy_net_bind(candidate, &localAddresses[localIndex], &error)) {
          cy_net_close(candidate);
          continue;
        }
        if (multicast && !cy_net_set_multicast_route(candidate,
              options_.multicastInterface.c_str(), options_.multicastTtl, &error)) {
          failedAction = "配置组播发送网卡或 TTL";
          cy_net_close(candidate);
          continue;
        }
        if (!options_.multicastGroup.empty() &&
            !cy_net_multicast_membership(candidate, options_.multicastGroup.c_str(),
                options_.multicastInterface.c_str(), 1, &error)) {
          failedAction = "加入组播接收组";
          cy_net_close(candidate);
          continue;
        }
        multicastJoined_ = !options_.multicastGroup.empty();
        {
          std::lock_guard<std::mutex> lock(mutex_);
          snapshot_.multicastJoined = multicastJoined_;
        }
        primary_ = candidate;
        udpTarget_ = remoteAddresses[remoteIndex];
        hasUdpTarget_ = true;
        cy_net_address local;
        std::memset(&local, 0, sizeof(local));
        if (cy_net_local_address(primary_, &local, &error)) {
          SetLocalEndpoint(DescribeAddress(local));
        }
        ChangeState("ready", "UDP 端点已打开。");
        if (multicast) {
          const std::string interfaceName = options_.multicastInterface.empty() ||
              options_.multicastInterface == "0.0.0.0" ? "系统路由" : options_.multicastInterface;
          PushSimpleEvent("system", 0, std::string(), "组播发送网卡：" + interfaceName +
              "，TTL " + std::to_string(options_.multicastTtl) + "。");
        }
        if (multicastJoined_) {
          PushSimpleEvent("system", 0, std::string(), "已加入组播接收组 " +
              options_.multicastGroup + "。尚未发送数据。");
        }
        return true;
      }
    }
    FailSession(SocketFailure(failedAction, error));
    return false;
  }

  void CompleteClientConnection() {
    clientConnecting_ = false;
    clientConnected_ = true;
    int error = 0;
    cy_net_address local;
    cy_net_address remote;
    std::memset(&local, 0, sizeof(local));
    std::memset(&remote, 0, sizeof(remote));
    if (cy_net_local_address(primary_, &local, &error)) {
      SetLocalEndpoint(DescribeAddress(local));
    }
    if (cy_net_peer_address(primary_, &remote, &error)) {
      clientEndpoint_ = DescribeAddress(remote);
    }
    PublishPeers();
    const std::string label = EndpointLabel(clientEndpoint_);
    PushSimpleEvent("system", clientPeerId_, label,
                    "TCP 连接已建立。");
    ChangeState("connected", "TCP 客户端已连接。");
  }

  void ProcessCommands() {
    std::deque<Command> commands;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      commands.swap(commands_);
    }
    while (!commands.empty()) {
      Command command = std::move(commands.front());
      commands.pop_front();
      if (options_.mode == "tcp-server") {
        QueueServerSend(std::move(command));
      } else if (options_.mode == "tcp-client") {
        if (primary_ == CY_NET_INVALID_SOCKET ||
            (!clientConnecting_ && !clientConnected_)) {
          ReleasePending(command.bytes.size());
          PushSimpleEvent("error", 0, std::string(),
                          "TCP 客户端当前未连接。");
        } else {
          PendingSend pending;
          pending.bytes = std::move(command.bytes);
          clientSends_.push_back(std::move(pending));
        }
      } else if (primary_ == CY_NET_INVALID_SOCKET || !hasUdpTarget_) {
        ReleasePending(command.bytes.size());
        PushSimpleEvent("error", 0, std::string(), "UDP 端点尚未打开。");
      } else {
        PendingSend pending;
        pending.bytes = std::move(command.bytes);
        udpSends_.push_back(std::move(pending));
      }
    }
  }

  void QueueServerSend(Command command) {
    if (serverPeers_.empty()) {
      ReleasePending(command.bytes.size());
      PushSimpleEvent("error", command.targetPeerId, std::string(),
                      "TCP 服务端当前没有可发送的连接。");
      return;
    }
    if (command.targetPeerId != 0) {
      PeerSocket* peer = FindServerPeer(command.targetPeerId);
      if (peer == nullptr) {
        ReleasePending(command.bytes.size());
        PushSimpleEvent("error", command.targetPeerId, std::string(),
                        "目标 TCP 连接已经断开。");
        return;
      }
      PendingSend pending;
      pending.bytes = std::move(command.bytes);
      peer->sends.push_back(std::move(pending));
      return;
    }

    const std::size_t extraCopies = serverPeers_.size() - 1U;
    if (extraCopies != 0U &&
        (command.bytes.size() >
             (std::numeric_limits<std::size_t>::max)() / extraCopies ||
         !ReserveAdditionalPending(command.bytes.size() * extraCopies))) {
      ReleasePending(command.bytes.size());
      PushSimpleEvent("error", 0, std::string(),
                      "广播会超过 4 MiB 待发送上限。");
      return;
    }
    for (std::size_t index = 0; index < serverPeers_.size(); ++index) {
      PendingSend pending;
      pending.bytes = command.bytes;
      serverPeers_[index].sends.push_back(std::move(pending));
    }
  }

  bool PollSockets() {
    std::vector<cy_net_poll_entry> entries;
    std::vector<WatchRef> watches;
    AddWatch(&entries, &watches, listener_, WatchListener, 0,
             listener_ != CY_NET_INVALID_SOCKET &&
                 serverPeers_.size() < kMaximumServerPeers,
             false);
    AddWatch(&entries, &watches, primary_, WatchPrimary, 0,
             primary_ != CY_NET_INVALID_SOCKET && !clientConnecting_,
             clientConnecting_ || !clientSends_.empty() ||
                 !udpSends_.empty());
    for (std::vector<PeerSocket>::const_iterator peer = serverPeers_.begin();
         peer != serverPeers_.end(); ++peer) {
      AddWatch(&entries, &watches, peer->socket, WatchServerPeer, peer->id,
               true, !peer->sends.empty());
    }

    if (entries.empty()) {
      std::unique_lock<std::mutex> lock(mutex_);
      commandWake_.wait_for(lock, std::chrono::milliseconds(kPollMilliseconds));
      return true;
    }
    int error = 0;
    const int result =
        cy_net_wait(entries.data(), entries.size(), kPollMilliseconds, &error);
    if (result == CY_NET_RESULT_ERROR) {
      FailSession(SocketFailure("等待网络事件", error));
      return false;
    }
    if (result == 0) return true;

    for (std::size_t index = 0; index < entries.size(); ++index) {
      if (watches[index].kind == WatchListener && entries[index].readable) {
        AcceptPeers();
      } else if (watches[index].kind == WatchPrimary) {
        if (entries[index].exceptional) {
          int socketError = 0;
          cy_net_socket_error(primary_, &socketError, &error);
          FailSession(SocketFailure("网络连接", socketError));
          return false;
        }
        if (clientConnecting_ && entries[index].writable) {
          int socketError = 0;
          if (!cy_net_socket_error(primary_, &socketError, &error) ||
              socketError != 0) {
            FailSession(SocketFailure(
                "连接目标", socketError != 0 ? socketError : error));
            return false;
          }
          CompleteClientConnection();
        }
        if (entries[index].readable) {
          if (options_.mode == "udp") {
            if (!ReceiveUdp()) return false;
          } else if (!ReceiveClient()) {
            return false;
          }
        }
        if (entries[index].writable && !clientConnecting_) {
          if (options_.mode == "udp") {
            if (!FlushUdp()) return false;
          } else if (!FlushTcp(primary_, clientPeerId_,
                               EndpointLabel(clientEndpoint_),
                               &clientSends_)) {
            FailSession("发送 TCP 数据失败，连接已关闭。");
            return false;
          }
        }
      } else if (watches[index].kind == WatchServerPeer) {
        const std::uint64_t peerId = watches[index].peerId;
        if (entries[index].exceptional) {
          DisconnectServerPeer(peerId, "TCP 连接发生套接字错误。");
          continue;
        }
        if (entries[index].readable) ReceiveServerPeer(peerId);
        PeerSocket* peer = FindServerPeer(peerId);
        if (peer != nullptr && entries[index].writable) {
          const std::string label = EndpointLabel(peer->endpoint);
          if (!FlushTcp(peer->socket, peer->id, label, &peer->sends)) {
            DisconnectServerPeer(peerId, "向 TCP 连接发送数据失败。");
          }
        }
      }
    }
    return true;
  }

  void AddWatch(std::vector<cy_net_poll_entry>* entries,
                std::vector<WatchRef>* watches, cy_net_socket socketValue,
                WatchKind kind, std::uint64_t peerId, bool read, bool write) {
    if (socketValue == CY_NET_INVALID_SOCKET) return;
    cy_net_poll_entry entry;
    std::memset(&entry, 0, sizeof(entry));
    entry.socket = socketValue;
    entry.want_read = read ? 1 : 0;
    entry.want_write = write ? 1 : 0;
    entries->push_back(entry);
    WatchRef watch;
    watch.kind = kind;
    watch.peerId = peerId;
    watches->push_back(watch);
  }

  void AcceptPeers() {
    while (serverPeers_.size() < kMaximumServerPeers) {
      cy_net_address address;
      int result = CY_NET_RESULT_ERROR;
      int error = 0;
      std::memset(&address, 0, sizeof(address));
      cy_net_socket accepted =
          cy_net_accept(listener_, &address, &result, &error);
      if (accepted == CY_NET_INVALID_SOCKET) {
        if (result != CY_NET_RESULT_WOULD_BLOCK) {
          PushSimpleEvent("error", 0, std::string(),
                          SocketFailure("接受 TCP 连接", error));
        }
        return;
      }
      if (!cy_net_set_nonblocking(accepted, 1, &error)) {
        cy_net_close(accepted);
        continue;
      }
      PeerSocket peer;
      peer.id = nextPeerId_++;
      peer.socket = accepted;
      peer.endpoint = DescribeAddress(address);
      const std::string label = EndpointLabel(peer.endpoint);
      const std::uint64_t peerId = peer.id;
      serverPeers_.push_back(std::move(peer));
      PublishPeers();
      PushSimpleEvent("system", peerId, label,
                      "TCP 客户端已接入。");
    }
  }

  PeerSocket* FindServerPeer(std::uint64_t peerId) {
    for (std::vector<PeerSocket>::iterator peer = serverPeers_.begin();
         peer != serverPeers_.end(); ++peer) {
      if (peer->id == peerId) return &*peer;
    }
    return nullptr;
  }

  void DisconnectServerPeer(std::uint64_t peerId,
                            const std::string& reason) {
    for (std::vector<PeerSocket>::iterator peer = serverPeers_.begin();
         peer != serverPeers_.end(); ++peer) {
      if (peer->id != peerId) continue;
      const std::string label = EndpointLabel(peer->endpoint);
      ReleasePending(Remaining(peer->sends));
      cy_net_shutdown(peer->socket);
      cy_net_close(peer->socket);
      serverPeers_.erase(peer);
      PublishPeers();
      PushSimpleEvent("system", peerId, label, reason);
      return;
    }
  }

  bool ReceiveClient() {
    unsigned char buffer[kReceiveBufferBytes];
    const std::string label = EndpointLabel(clientEndpoint_);
    for (;;) {
      std::size_t received = 0;
      int error = 0;
      const int result = cy_net_receive(primary_, buffer, sizeof(buffer),
                                        &received, &error);
      if (result == CY_NET_RESULT_WOULD_BLOCK) return true;
      if (result == CY_NET_RESULT_CLOSED) {
        PushSimpleEvent("system", clientPeerId_, label,
                        "TCP 目标已关闭连接。");
        FailSession("TCP 目标已关闭连接。");
        return false;
      }
      if (result == CY_NET_RESULT_ERROR) {
        FailSession(SocketFailure("接收 TCP 数据", error));
        return false;
      }
      RecordReceive(received);
      PushDataEvent("received", clientPeerId_, label, buffer, received);
    }
  }

  void ReceiveServerPeer(std::uint64_t peerId) {
    unsigned char buffer[kReceiveBufferBytes];
    for (;;) {
      PeerSocket* peer = FindServerPeer(peerId);
      if (peer == nullptr) return;
      const std::string label = EndpointLabel(peer->endpoint);
      std::size_t received = 0;
      int error = 0;
      const int result = cy_net_receive(peer->socket, buffer, sizeof(buffer),
                                        &received, &error);
      if (result == CY_NET_RESULT_WOULD_BLOCK) return;
      if (result == CY_NET_RESULT_CLOSED) {
        DisconnectServerPeer(peerId, "TCP 客户端已关闭连接。");
        return;
      }
      if (result == CY_NET_RESULT_ERROR) {
        DisconnectServerPeer(peerId, SocketFailure("接收 TCP 数据", error));
        return;
      }
      RecordReceive(received);
      PushDataEvent("received", peerId, label, buffer, received);
    }
  }

  bool ReceiveUdp() {
    unsigned char buffer[65536U];
    for (;;) {
      cy_net_address sender;
      std::size_t received = 0;
      int error = 0;
      std::memset(&sender, 0, sizeof(sender));
      const int result = cy_net_receive_from(
          primary_, buffer, sizeof(buffer), &received, &sender, &error);
      if (result == CY_NET_RESULT_WOULD_BLOCK) return true;
      if (result == CY_NET_RESULT_ERROR) {
        FailSession(SocketFailure("接收 UDP 数据", error));
        return false;
      }
      const std::string label = EndpointLabel(DescribeAddress(sender));
      RecordReceive(received);
      PushDataEvent("received", 0, label, buffer, received);
    }
  }

  bool FlushTcp(cy_net_socket socketValue, std::uint64_t peerId,
                const std::string& peerLabel,
                std::deque<PendingSend>* sends) {
    while (sends != nullptr && !sends->empty()) {
      PendingSend& pending = sends->front();
      const std::size_t remaining = pending.bytes.size() - pending.offset;
      std::size_t sent = 0;
      int error = 0;
      const int result = cy_net_send(socketValue,
          pending.bytes.data() + pending.offset, remaining, &sent, &error);
      if (result == CY_NET_RESULT_WOULD_BLOCK) return true;
      if (result != CY_NET_RESULT_OK) {
        PushSimpleEvent("error", peerId, peerLabel,
                        SocketFailure("发送 TCP 数据", error));
        return false;
      }
      pending.offset += sent;
      RecordSentBytes(sent);
      if (pending.offset == pending.bytes.size()) {
        PushDataEvent("sent", peerId, peerLabel, pending.bytes.data(),
                      pending.bytes.size());
        RecordSentPacket();
        sends->pop_front();
      }
    }
    return true;
  }

  bool FlushUdp() {
    const std::string label = EndpointLabel(DescribeAddress(udpTarget_));
    while (!udpSends_.empty()) {
      PendingSend& pending = udpSends_.front();
      std::size_t sent = 0;
      int error = 0;
      const int result = cy_net_send_to(
          primary_, pending.bytes.data(), pending.bytes.size(), &udpTarget_,
          &sent, &error);
      if (result == CY_NET_RESULT_WOULD_BLOCK) return true;
      if (result != CY_NET_RESULT_OK || sent != pending.bytes.size()) {
        FailSession(SocketFailure("发送 UDP 数据", error));
        return false;
      }
      RecordSentBytes(sent);
      RecordSentPacket();
      PushDataEvent("sent", 0, label, pending.bytes.data(),
                    pending.bytes.size());
      udpSends_.pop_front();
    }
    return true;
  }

  void CleanupSockets() {
    if (listener_ != CY_NET_INVALID_SOCKET) {
      cy_net_shutdown(listener_);
      cy_net_close(listener_);
      listener_ = CY_NET_INVALID_SOCKET;
    }
    if (primary_ != CY_NET_INVALID_SOCKET) {
      if (multicastJoined_) {
        int leaveError = 0;
        // Closing below also releases membership if the adapter disappeared.
        (void)cy_net_multicast_membership(primary_, options_.multicastGroup.c_str(),
            options_.multicastInterface.c_str(), 0, &leaveError);
        PushSimpleEvent("system", 0, std::string(), "组播接收已停止，正在关闭端点。");
      }
      cy_net_shutdown(primary_);
      cy_net_close(primary_);
      primary_ = CY_NET_INVALID_SOCKET;
    }
    for (std::vector<PeerSocket>::iterator peer = serverPeers_.begin();
         peer != serverPeers_.end(); ++peer) {
      cy_net_shutdown(peer->socket);
      cy_net_close(peer->socket);
    }
    serverPeers_.clear();
    clientSends_.clear();
    udpSends_.clear();
    clientConnecting_ = false;
    clientConnected_ = false;
    hasUdpTarget_ = false;
    multicastJoined_ = false;
    PublishPeers();
    {
      std::lock_guard<std::mutex> lock(mutex_);
      commands_.clear();
      pendingSendBytes_ = 0;
      snapshot_.multicastJoined = false;
    }
    if (winsockStarted_) {
      cy_net_cleanup();
      winsockStarted_ = false;
    }
  }

  mutable std::mutex mutex_;
  std::condition_variable commandWake_;
  std::thread worker_;
  NetworkDebugStartOptions options_;
  NetworkDebugSnapshot snapshot_;
  std::deque<NetworkDebugEvent> events_;
  std::deque<Command> commands_;
  std::size_t eventBytes_{};
  std::size_t pendingSendBytes_{};
  std::uint64_t nextEventId_{1};
  std::uint64_t overflowEventId_{};
  bool overflowQueued_{};
  bool stopRequested_{};
  bool workerActive_{};

  cy_net_socket listener_{CY_NET_INVALID_SOCKET};
  cy_net_socket primary_{CY_NET_INVALID_SOCKET};
  cy_net_address udpTarget_{};
  std::vector<PeerSocket> serverPeers_;
  std::deque<PendingSend> clientSends_;
  std::deque<PendingSend> udpSends_;
  EndpointText clientEndpoint_;
  std::uint64_t clientPeerId_{};
  std::uint64_t nextPeerId_{1};
  std::uint64_t connectStartedMilliseconds_{};
  bool clientConnecting_{};
  bool clientConnected_{};
  bool hasUdpTarget_{};
  bool multicastJoined_{};
  bool winsockStarted_{};
};

NetworkDebugService::NetworkDebugService() : impl_(new Impl()) {}

NetworkDebugService::~NetworkDebugService() = default;

bool NetworkDebugService::Start(const NetworkDebugStartOptions& options,
                                std::string* error) {
  return impl_->Start(options, error);
}

void NetworkDebugService::Stop() {
  impl_->Stop();
}

bool NetworkDebugService::Send(const std::string& dataHex,
                               std::uint64_t targetPeerId,
                               std::string* error) {
  return impl_->SendHex(dataHex, targetPeerId, error);
}

bool NetworkDebugService::Send(const std::vector<unsigned char>& bytes,
                               std::uint64_t targetPeerId,
                               std::string* error) {
  return impl_->SendBytes(bytes, targetPeerId, error);
}

NetworkDebugPollResult NetworkDebugService::Poll() {
  return impl_->Poll();
}

NetworkDebugSnapshot NetworkDebugService::Snapshot() const {
  return impl_->Snapshot();
}

std::vector<NetworkDebugInterface> NetworkDebugService::Interfaces(std::string* error) {
  std::vector<NetworkDebugInterface> result;
  std::vector<cy_net_interface> native(CY_NET_MAX_INTERFACES);
  int errorCode = 0;
  const int count = cy_net_interfaces(native.data(), native.size(), &errorCode);
  if (count < 0) {
    if (error != nullptr) *error = SocketFailure("读取本机 IPv4 网卡", errorCode);
    return result;
  }
  if (error != nullptr) error->clear();
  for (int index = 0; index < count; ++index) {
    NetworkDebugInterface item;
    item.name = native[index].name;
    item.address = native[index].address;
    item.index = native[index].index;
    item.loopback = native[index].loopback != 0;
    result.push_back(item);
  }
  return result;
}

}  // namespace milo
