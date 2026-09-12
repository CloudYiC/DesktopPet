#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include "Milo/ModbusDebugService.h"
#include "cloudyi/modbus_protocol.h"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <thread>
#include <vector>

namespace milo {
namespace {
using nlohmann::json;
long long Now() { return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count(); }
unsigned long long Tick() { return GetTickCount64(); }
int Integer(const json& p, const char* key, int fallback, int low, int high) {
  if (!p.contains(key)) return fallback;
  if (!p[key].is_number_integer()) throw std::runtime_error(std::string(key) + " 必须是整数。");
  const long long n = p[key].get<long long>();
  if (n < low || n > high) throw std::runtime_error(std::string(key) + " 超出范围。");
  return static_cast<int>(n);
}
std::string Hex(const unsigned char* p, size_t n) {
  const char* digits = "0123456789ABCDEF"; std::string s;
  for (size_t i = 0; i < n; ++i) { if (i) s += ' '; s += digits[p[i] >> 4]; s += digits[p[i] & 15]; }
  return s;
}
std::string WinError(const char* operation, int error) { return std::string(operation) + "失败（系统代码 " + std::to_string(error) + "）。"; }
const char* ExceptionName(unsigned code) {
  switch (code) { case 1: return "非法功能"; case 2: return "非法数据地址"; case 3: return "非法数据值";
    case 4: return "设备故障"; case 5: return "设备已确认，处理尚未完成"; case 6: return "设备忙";
    case 8: return "存储器奇偶校验错误"; case 10: return "网关路径不可用"; case 11: return "网关目标无响应"; default: return "设备拒绝请求"; }
}
struct Options {
  bool tcp;
  std::string host, serial, parity;
  int port, baud, stopBits, unit, timeout, retries;
};
Options ParseOptions(const json& p) {
  Options o;
  const std::string transport = p.value("transport", "tcp");
  if (transport != "tcp" && transport != "rtu") throw std::runtime_error("请选择 Modbus TCP 或 RTU。");
  o.tcp = transport == "tcp";
  o.host = p.value("host", "127.0.0.1"); o.serial = p.value("serialPort", "COM1"); o.parity = p.value("parity", "even");
  o.port = Integer(p, "port", 502, 1, 65535); o.baud = Integer(p, "baudRate", 9600, 1200, 230400);
  o.stopBits = Integer(p, "stopBits", 1, 1, 2); o.unit = Integer(p, "unitId", 1, 1, 247);
  o.timeout = Integer(p, "timeoutMs", 1000, 100, 10000); o.retries = Integer(p, "retries", 0, 0, 2);
  Integer(p, "dataBits", 8, 8, 8);
  if (o.tcp) {
    IN_ADDR ipv4; IN6_ADDR ipv6;
    if (InetPtonA(AF_INET, o.host.c_str(), &ipv4) != 1 && InetPtonA(AF_INET6, o.host.c_str(), &ipv6) != 1)
      throw std::runtime_error("TCP 主机请填写 IPv4 或 IPv6 数字地址，不支持域名。");
  } else {
    if (o.serial.size() < 4 || o.serial.size() > 8 || o.serial.compare(0, 3, "COM") != 0 || o.serial[3] == '0')
      throw std::runtime_error("串口必须是 COM1、COM2 等端口名称。");
    for (size_t i = 3; i < o.serial.size(); ++i) if (o.serial[i] < '0' || o.serial[i] > '9') throw std::runtime_error("串口名称不正确。");
    if (o.parity != "none" && o.parity != "even" && o.parity != "odd") throw std::runtime_error("校验位不正确。");
  }
  return o;
}
json Ports() {
  json list = json::array(); HKEY key = nullptr;
  if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"HARDWARE\\DEVICEMAP\\SERIALCOMM", 0, KEY_READ, &key) != ERROR_SUCCESS) return list;
  for (DWORD index = 0; index < 1024; ++index) {
    wchar_t name[512], value[512]; DWORD names = 512, bytes = sizeof(value), type = 0;
    const LONG result = RegEnumValueW(key, index, name, &names, nullptr, &type, reinterpret_cast<BYTE*>(value), &bytes);
    if (result == ERROR_NO_MORE_ITEMS) break;
    if (result != ERROR_SUCCESS || type != REG_SZ || bytes < sizeof(wchar_t) || bytes > sizeof(value)) continue;
    value[std::min<size_t>(bytes / sizeof(wchar_t), 511)] = 0;
    std::string port;
    for (size_t c = 0; value[c] && c < 511; ++c) {
      if (value[c] > 0x7f) { port.clear(); break; }
      port.push_back(static_cast<char>(value[c]));
    }
    if (port.compare(0, 3, "COM") == 0) list.push_back(port);
  }
  RegCloseKey(key); return list;
}
}  // namespace

class ModbusDebugService::Impl {
 public:
  Impl() : generation_(0), quitting_(false), socket_(INVALID_SOCKET), serial_(INVALID_HANDLE_VALUE), transaction_(0), sequence_(0) {
    WSADATA data; if (WSAStartup(MAKEWORD(2, 2), &data)) throw std::runtime_error("无法初始化 Modbus TCP。");
    snapshot_ = {{"state", "stopped"}, {"transport", "tcp"}, {"pending", false}, {"error", ""}, {"result", nullptr}};
    worker_ = std::thread(&Impl::Run, this);
  }
  ~Impl() { Shutdown(); WSACleanup(); }
  void Shutdown() {
    { std::lock_guard<std::mutex> lock(mutex_); quitting_ = true; ++generation_; commands_.clear(); }
    wake_.notify_all(); if (worker_.joinable()) worker_.join();
  }
  void StopSync() {
    std::unique_lock<std::mutex> lock(mutex_);
    if (quitting_) return;
    const unsigned long long target = ++generation_;
    commands_.clear(); commands_.push_back(Command("stop", target));
    snapshot_["state"] = "stopping"; snapshot_["pending"] = false; snapshot_["result"] = nullptr; snapshot_["error"] = "";
    wake_.notify_all();
    // No DNS or unbounded socket waits run in the worker; IO checks cancellation
    // every 2–50ms. The close barrier guarantees no more device traffic on return.
    stopped_.wait(lock, [this, target] { return stoppedGeneration_ >= target || quitting_; });
  }
  json Handle(const std::string& action, const json& payload) {
    if (action == "ports") return {{"ports", Ports()}};
    std::lock_guard<std::mutex> lock(mutex_);
    if (quitting_) throw std::runtime_error("Modbus 服务已经关闭。");
    if (action == "poll") { json logs = json::array(); while (!logs_.empty()) { logs.push_back(logs_.front()); logs_.pop_front(); } return {{"snapshot", snapshot_}, {"logs", logs}}; }
    if (action == "stop") {
      ++generation_; commands_.clear(); commands_.push_back(Command("stop", generation_));
      snapshot_["state"] = "stopping"; snapshot_["pending"] = false; snapshot_["result"] = nullptr; snapshot_["error"] = "";
      wake_.notify_all(); return {{"snapshot", snapshot_}};
    }
    if (action == "start") {
      if (snapshot_["state"] != "stopped" && snapshot_["state"] != "error") throw std::runtime_error("请先断开当前连接。");
      Command c("start", ++generation_); c.options = ParseOptions(payload); commands_.clear(); commands_.push_back(c);
      snapshot_ = {{"state", "connecting"}, {"pending", false}, {"error", ""}, {"result", nullptr}, {"transport", c.options.tcp ? "tcp" : "rtu"}, {"unitId", c.options.unit}, {"endpoint", c.options.tcp ? c.options.host + ":" + std::to_string(c.options.port) : c.options.serial}};
      wake_.notify_all(); return {{"snapshot", snapshot_}};
    }
    if (action == "request") {
      if (snapshot_["state"] != "connected") throw std::runtime_error("请先连接设备。");
      if (snapshot_["pending"].get<bool>()) throw std::runtime_error("上一条请求尚未完成。");
      Command c("request", generation_); c.request = {};
      c.request.unit = static_cast<uint8_t>(snapshot_["unitId"].get<int>());
      c.request.function = static_cast<uint8_t>(Integer(payload, "functionCode", 3, 1, 16));
      c.request.address = static_cast<uint16_t>(Integer(payload, "address", 0, 0, 65535));
      c.request.quantity = static_cast<uint16_t>(Integer(payload, "quantity", 1, 1, 2000));
      if (payload.contains("values")) {
        if (!payload["values"].is_array() || payload["values"].size() > CY_MB_MAX_VALUES) throw std::runtime_error("写入值列表不正确。");
        for (const auto& v : payload["values"]) {
          if (!v.is_number_integer() || v.get<long long>() < 0 || v.get<long long>() > 65535) throw std::runtime_error("寄存器值必须是 0–65535 的整数。");
          c.request.values[c.request.value_count++] = v.get<uint16_t>();
        }
      }
      const char* error = cy_mb_validate(&c.request); if (error) throw std::runtime_error(error);
      if (cy_mb_is_write(c.request.function) && (!payload.contains("confirmed") || !payload["confirmed"].is_boolean() || !payload["confirmed"].get<bool>()))
        throw std::runtime_error("每次写入都必须先明确确认目标地址及全部值。");
      snapshot_["pending"] = true; snapshot_["error"] = ""; snapshot_["result"] = nullptr;
      commands_.push_back(c); wake_.notify_all(); return {{"snapshot", snapshot_}};
    }
    throw std::runtime_error("未知 Modbus 操作。");
  }
 private:
  struct Command {
    std::string action; unsigned long long generation; Options options; cy_mb_request request;
    Command(const std::string& a, unsigned long long g) : action(a), generation(g), options(), request() {}
  };
  bool Cancelled(unsigned long long g) const { return quitting_ || generation_ != g; }
  void Close() { if (socket_ != INVALID_SOCKET) { closesocket(socket_); socket_ = INVALID_SOCKET; } if (serial_ != INVALID_HANDLE_VALUE) { CloseHandle(serial_); serial_ = INVALID_HANDLE_VALUE; } }
  void Log(unsigned long long g, const char* direction, const unsigned char* bytes, size_t size, const std::string& message = "") {
    std::lock_guard<std::mutex> lock(mutex_); if (Cancelled(g)) return;
    logs_.push_back({{"id", ++sequence_}, {"timestamp", Now()}, {"direction", direction}, {"hex", Hex(bytes, size)}, {"message", message}});
    while (logs_.size() > 256) logs_.pop_front();
  }
  void Pause(unsigned milliseconds, unsigned long long g) { const auto end = Tick() + milliseconds; while (!Cancelled(g) && Tick() < end) Sleep(1); }
  void Open(const Options& o, unsigned long long g) {
    Close(); if (Cancelled(g)) throw std::runtime_error("操作已取消。");
    if (o.tcp) {
      sockaddr_storage address = {}; int length; IN_ADDR ipv4;
      if (InetPtonA(AF_INET, o.host.c_str(), &ipv4) == 1) {
        sockaddr_in* v4 = reinterpret_cast<sockaddr_in*>(&address); v4->sin_family = AF_INET; v4->sin_port = htons(static_cast<u_short>(o.port)); v4->sin_addr = ipv4; length = sizeof(*v4);
      } else { sockaddr_in6* v6 = reinterpret_cast<sockaddr_in6*>(&address); v6->sin6_family = AF_INET6; v6->sin6_port = htons(static_cast<u_short>(o.port)); InetPtonA(AF_INET6, o.host.c_str(), &v6->sin6_addr); length = sizeof(*v6); }
      socket_ = socket(address.ss_family, SOCK_STREAM, IPPROTO_TCP); if (socket_ == INVALID_SOCKET) throw std::runtime_error(WinError("创建 TCP", WSAGetLastError()));
      u_long nonblocking = 1; if (ioctlsocket(socket_, FIONBIO, &nonblocking)) throw std::runtime_error(WinError("设置 TCP", WSAGetLastError()));
      if (connect(socket_, reinterpret_cast<sockaddr*>(&address), length) == SOCKET_ERROR && WSAGetLastError() != WSAEWOULDBLOCK) throw std::runtime_error(WinError("连接 TCP", WSAGetLastError()));
      const auto deadline = Tick() + o.timeout;
      while (!Cancelled(g) && Tick() < deadline) {
        fd_set writable, failed; FD_ZERO(&writable); FD_ZERO(&failed); FD_SET(socket_, &writable); FD_SET(socket_, &failed); timeval wait = {0, 20000};
        int ready = select(0, nullptr, &writable, &failed, &wait);
        if (ready < 0) throw std::runtime_error(WinError("等待 TCP", WSAGetLastError()));
        if (ready > 0) {
          int status = 0, n = sizeof(status);
          if (getsockopt(socket_, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&status), &n)) throw std::runtime_error(WinError("检查 TCP 连接", WSAGetLastError()));
          if (status) throw std::runtime_error(WinError("连接 TCP", status)); return;
        }
      }
      throw std::runtime_error(Cancelled(g) ? "操作已取消。" : "TCP 连接超时。");
    }
    const std::string device = "\\\\.\\" + o.serial;
    serial_ = CreateFileA(device.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (serial_ == INVALID_HANDLE_VALUE) throw std::runtime_error(WinError("打开串口", GetLastError()));
    DCB dcb = {}; dcb.DCBlength = sizeof(dcb);
    if (!GetCommState(serial_, &dcb)) throw std::runtime_error(WinError("读取串口设置", GetLastError()));
    dcb.BaudRate = o.baud; dcb.ByteSize = 8; dcb.Parity = o.parity == "even" ? EVENPARITY : o.parity == "odd" ? ODDPARITY : NOPARITY;
    dcb.StopBits = o.stopBits == 2 ? TWOSTOPBITS : ONESTOPBIT; dcb.fBinary = TRUE; dcb.fParity = o.parity != "none";
    dcb.fOutxCtsFlow = FALSE; dcb.fOutxDsrFlow = FALSE; dcb.fDtrControl = DTR_CONTROL_DISABLE; dcb.fDsrSensitivity = FALSE;
    dcb.fOutX = FALSE; dcb.fInX = FALSE; dcb.fErrorChar = FALSE; dcb.fNull = FALSE; dcb.fRtsControl = RTS_CONTROL_DISABLE; dcb.fAbortOnError = FALSE;
    COMMTIMEOUTS timeouts = {}; timeouts.ReadIntervalTimeout = MAXDWORD; timeouts.ReadTotalTimeoutConstant = 20; timeouts.WriteTotalTimeoutConstant = 50;
    if (!SetCommState(serial_, &dcb) || !SetCommTimeouts(serial_, &timeouts)) throw std::runtime_error(WinError("配置串口", GetLastError()));
    PurgeComm(serial_, PURGE_RXCLEAR | PURGE_TXCLEAR);
  }
  std::vector<unsigned char> Exchange(const Options& o, const cy_mb_request& request, uint16_t tid, unsigned long long g) {
    unsigned char frame[CY_MB_MAX_ADU]; const size_t size = cy_mb_build(&request, o.tcp, tid, frame, sizeof(frame));
    if (!o.tcp) { PurgeComm(serial_, PURGE_RXCLEAR); Pause(o.baud > 19200 ? 2 : static_cast<unsigned>((38500 + o.baud - 1) / o.baud), g); }
    const auto deadline = Tick() + o.timeout; size_t sent = 0;
    while (!Cancelled(g) && Tick() < deadline && sent < size) {
      int count;
      if (o.tcp) { count = send(socket_, reinterpret_cast<const char*>(frame + sent), static_cast<int>(size - sent), 0); if (count == SOCKET_ERROR && WSAGetLastError() == WSAEWOULDBLOCK) { Sleep(2); continue; } }
      else { DWORD written = 0; if (!WriteFile(serial_, frame + sent, static_cast<DWORD>(size - sent), &written, nullptr)) throw std::runtime_error(WinError("串口发送", GetLastError())); count = static_cast<int>(written); }
      if (count < 0) throw std::runtime_error(WinError("TCP 发送", WSAGetLastError()));
      if (count == 0) { Sleep(2); continue; } sent += count;
    }
    if (Cancelled(g)) throw std::runtime_error("操作已取消。");
    if (sent != size) throw std::runtime_error("发送超时，设备可能已收到部分数据。");
    Log(g, "TX", frame, size);
    std::vector<unsigned char> response;
    while (!Cancelled(g) && Tick() < deadline) {
      unsigned char chunk[CY_MB_MAX_ADU]; int count;
      if (o.tcp) {
        size_t required = response.size() < 6 ? 6 : static_cast<size_t>(cy_mb_frame_size(response.data(), response.size(), 1));
        if (required < response.size() || required > CY_MB_MAX_ADU) throw std::runtime_error("MBAP 长度或协议标识不正确。");
        count = recv(socket_, reinterpret_cast<char*>(chunk), static_cast<int>(required - response.size()), 0);
        if (count == SOCKET_ERROR && WSAGetLastError() == WSAEWOULDBLOCK) { Sleep(2); continue; }
        if (count <= 0) throw std::runtime_error("TCP 连接已断开或接收失败。");
      } else {
        DWORD read = 0; if (!ReadFile(serial_, chunk, sizeof(chunk), &read, nullptr)) throw std::runtime_error(WinError("串口接收", GetLastError()));
        count = static_cast<int>(read); if (!count) continue;
      }
      response.insert(response.end(), chunk, chunk + count);
      if (response.size() > CY_MB_MAX_ADU) throw std::runtime_error("响应长度超过 Modbus 上限。");
      const int expected = cy_mb_frame_size(response.data(), response.size(), o.tcp);
      if (expected < 0) { Log(g, "RX", response.data(), response.size()); throw std::runtime_error("响应帧头无效。"); }
      if (expected && response.size() >= static_cast<size_t>(expected)) { Log(g, "RX", response.data(), response.size()); return response; }
    }
    if (!response.empty()) Log(g, "RX", response.data(), response.size(), "不完整响应");
    throw std::runtime_error(Cancelled(g) ? "操作已取消。" : "设备响应超时。");
  }
  void Run() {
    Options options = {};
    for (;;) {
      Command command("", 0);
      { std::unique_lock<std::mutex> lock(mutex_); wake_.wait(lock, [this] { return quitting_ || !commands_.empty(); }); if (quitting_) break; command = commands_.front(); commands_.pop_front(); }
      if (Cancelled(command.generation)) continue;
      try {
        if (command.action == "stop") { Close(); std::lock_guard<std::mutex> lock(mutex_); stoppedGeneration_ = command.generation; if (!Cancelled(command.generation)) snapshot_["state"] = "stopped"; stopped_.notify_all(); continue; }
        if (command.action == "start") { options = command.options; Open(options, command.generation); std::lock_guard<std::mutex> lock(mutex_); if (!Cancelled(command.generation)) snapshot_["state"] = "connected"; continue; }
        const auto start = Tick(); cy_mb_response response = {}; std::string failure;
        const bool write = cy_mb_is_write(command.request.function) != 0;
        for (int attempt = 0; attempt <= (write ? 0 : options.retries); ++attempt) {
          if (Cancelled(command.generation)) break;
          try {
            if (attempt) { Open(options, command.generation); Log(command.generation, "INFO", nullptr, 0, "只读请求重试 " + std::to_string(attempt)); }
            const uint16_t tid = ++transaction_; const auto bytes = Exchange(options, command.request, tid, command.generation);
            const char* error = cy_mb_parse(&command.request, options.tcp, tid, bytes.data(), bytes.size(), &response);
            if (error) throw std::runtime_error(error);
            failure.clear(); break;
          } catch (const std::exception& e) { failure = e.what(); Close(); }
        }
        if (Cancelled(command.generation)) { Close(); continue; }
        if (!failure.empty()) throw std::runtime_error(failure + (write ? " 写入结果不确定；不会自动重试，请先读取核对。" : ""));
        json values = json::array(); for (size_t i = 0; i < response.count; ++i) values.push_back(response.values[i]);
        std::lock_guard<std::mutex> lock(mutex_); if (Cancelled(command.generation)) continue;
        snapshot_["pending"] = false;
        if (response.exception) snapshot_["error"] = "Modbus 异常码 " + std::to_string(response.exception) + "（" + ExceptionName(response.exception) + "）。";
        else snapshot_["result"] = {{"id", ++sequence_}, {"functionCode", command.request.function}, {"address", command.request.address}, {"quantity", command.request.quantity}, {"values", values}, {"timestamp", Now()}, {"elapsedMs", Tick() - start}, {"written", write}};
      } catch (const std::exception& e) {
        Close(); std::lock_guard<std::mutex> lock(mutex_); if (!Cancelled(command.generation)) { snapshot_["state"] = "error"; snapshot_["pending"] = false; snapshot_["error"] = e.what(); snapshot_["result"] = nullptr; }
      }
    }
    Close();
  }
  std::mutex mutex_; std::condition_variable wake_, stopped_; std::thread worker_; std::atomic<unsigned long long> generation_; std::atomic<bool> quitting_;
  unsigned long long stoppedGeneration_ = 0;
  std::deque<Command> commands_; std::deque<json> logs_; json snapshot_; SOCKET socket_; HANDLE serial_; uint16_t transaction_; unsigned long long sequence_;
};
ModbusDebugService::ModbusDebugService() : impl_(new Impl()) {}
ModbusDebugService::~ModbusDebugService() {}
json ModbusDebugService::Handle(const std::string& action, const json& payload) { return impl_->Handle(action, payload); }
void ModbusDebugService::Stop() { impl_->StopSync(); }
}  // namespace milo
