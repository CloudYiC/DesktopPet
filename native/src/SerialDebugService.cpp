#include "Milo/SerialDebugService.h"
#include "Milo/SerialPortWin32.h"
#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <deque>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <utility>
#include <vector>

namespace milo {
namespace {
typedef nlohmann::json Json;
long long Now() { return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count(); }
std::string Hex(const unsigned char* bytes, std::size_t count) {
  const char* digits = "0123456789abcdef";
  std::string result; result.reserve(count * 2);
  for (std::size_t i = 0; i < count; ++i) { result.push_back(digits[bytes[i] >> 4]); result.push_back(digits[bytes[i] & 15]); }
  return result;
}
std::vector<unsigned char> Decode(const Json& payload) {
  const std::string hex = payload.at("dataHex").get<std::string>();
  if (hex.empty() || hex.size() % 2 || hex.size() > 131072) throw std::runtime_error("每次发送须为 1–65536 字节的完整 Hex。");
  std::vector<unsigned char> data(hex.size() / 2);
  std::size_t written = 0;
  if (!cy_serial_decode_hex(hex.data(), hex.size(), data.data(), data.size(), &written)) throw std::runtime_error("串口发送内容包含无效 Hex。");
  return data;
}
int Integer(const Json& payload, const char* name, int fallback) {
  if (!payload.contains(name)) return fallback;
  if (!payload[name].is_number_integer()) throw std::runtime_error("串口参数必须为整数。");
  const long long value = payload[name].get<long long>();
  if (value < 0 || value > 4000000) throw std::runtime_error("串口参数超出范围。");
  return static_cast<int>(value);
}
cy_serial_options Options(const Json& payload) {
  cy_serial_options options = {};
  const std::string port = payload.at("port").get<std::string>();
  if (port.size() >= sizeof(options.port) || port.find('\0') != std::string::npos) throw std::runtime_error("请选择有效 COM 端口。");
  std::memcpy(options.port, port.c_str(), port.size() + 1);
  options.baud = static_cast<unsigned long>(Integer(payload, "baud", 115200));
  options.data_bits = Integer(payload, "dataBits", 8);
  options.parity = Integer(payload, "parity", 0);
  options.stop_bits = Integer(payload, "stopBits", 0);
  options.flow = Integer(payload, "flowControl", 0);
  options.dtr = payload.value("dtr", true) ? 1 : 0;
  options.rts = payload.value("rts", true) ? 1 : 0;
  if (!cy_serial_valid_options(&options)) throw std::runtime_error("串口参数无效；1.5 停止位仅适用于 5 数据位，5 数据位不支持 2 停止位。");
  return options;
}
}

class SerialDebugService::Impl {
 public:
  std::mutex mutex;
  std::condition_variable wake;
  std::thread worker;
  bool shutdown = false, stop = false, opening = false;
  cy_serial_options options = {};
  std::string state = "stopped", lastError;
  unsigned long long rx = 0, tx = 0, sequence = 0, dropped = 0;
  std::deque<Json> events;
  std::size_t eventBytes = 0, queuedBytes = 0;
  std::deque<std::vector<unsigned char> > outgoing;

  Json Snapshot() const {
    return Json{{"state", state}, {"port", options.port}, {"baud", options.baud}, {"dataBits", options.data_bits},
      {"parity", options.parity}, {"stopBits", options.stop_bits}, {"flowControl", options.flow},
      {"rxBytes", rx}, {"txBytes", tx}, {"lastError", lastError}};
  }
  void Event(const std::string& kind, const std::string& message, const unsigned char* data = NULL, std::size_t count = 0) {
    const std::string hex = data ? Hex(data, count) : "";
    while (!events.empty() && (events.size() >= 512 || eventBytes + hex.size() > 2 * 1024 * 1024)) {
      eventBytes -= events.front()["dataHex"].get_ref<const std::string&>().size(); events.pop_front(); ++dropped;
    }
    eventBytes += hex.size();
    events.push_back(Json{{"id", ++sequence}, {"kind", kind}, {"timestamp", Now()}, {"dataHex", hex}, {"byteLength", count}, {"message", message}});
  }
  void Failure(const std::string& operation, unsigned long code) {
    std::lock_guard<std::mutex> lock(mutex);
    state = "error"; lastError = operation + "失败（Win32 " + std::to_string(code) + "）。请检查设备连接、端口占用和驱动。";
    outgoing.clear(); queuedBytes = 0; Event("error", lastError);
  }
  void Loop() {
    cy_serial_port* port = NULL;
    std::vector<unsigned char> current;
    std::size_t sent = 0;
    bool writing = false;
    std::chrono::steady_clock::time_point writeStarted;
    for (;;) {
      cy_serial_options next = {};
      bool shouldOpen = false, shouldStop = false, shouldExit = false;
      {
        std::unique_lock<std::mutex> lock(mutex);
        if (!port && !opening && !stop && !shutdown) wake.wait(lock, [this] { return opening || stop || shutdown; });
        shouldExit = shutdown; shouldStop = stop || shutdown;
        if (shouldStop) { stop = false; opening = false; outgoing.clear(); queuedBytes = 0; }
        else if (opening) { next = options; opening = false; shouldOpen = true; }
      }
      if (shouldStop) {
        cy_serial_close(port); port = NULL; current.clear(); writing = false;
        std::lock_guard<std::mutex> lock(mutex); state = "stopped"; Event("status", "串口已关闭。");
        if (shouldExit) return;
      }
      if (shouldOpen) {
        unsigned long code = 0;
        port = cy_serial_open(&next, &code);
        if (!port) { Failure("打开串口", code); continue; }
        std::lock_guard<std::mutex> lock(mutex);
        // A close request issued while the driver was opening is handled next iteration.
        if (!stop && !shutdown) { state = "open"; Event("status", std::string(next.port) + " 已打开。"); }
      }
      if (!port) continue;
      unsigned long code = 0;
      unsigned char buffer[16384];
      const int received = cy_serial_read(port, buffer, sizeof(buffer), &code);
      if (received < 0) { cy_serial_close(port); port = NULL; current.clear(); writing = false; Failure("读取串口", code); continue; }
      if (received > 0) { std::lock_guard<std::mutex> lock(mutex); rx += received; Event("rx", "", buffer, static_cast<std::size_t>(received)); }
      if (current.empty()) {
        std::lock_guard<std::mutex> lock(mutex);
        if (!outgoing.empty()) { current.swap(outgoing.front()); outgoing.pop_front(); queuedBytes -= current.size(); sent = 0; writeStarted = std::chrono::steady_clock::now(); }
      }
      if (!current.empty()) {
        if (!writing) {
          if (!cy_serial_write_begin(port, current.data() + sent, current.size() - sent, &code)) {
            cy_serial_close(port); port = NULL; current.clear(); Failure("写入串口", code); continue;
          }
          writing = true;
        }
        std::size_t written = 0;
        const int result = cy_serial_write_poll(port, &written, &code);
        if (result < 0 || std::chrono::steady_clock::now() - writeStarted > std::chrono::seconds(3)) {
          cy_serial_close(port); port = NULL; current.clear(); writing = false; Failure("写入串口", result < 0 ? code : 1460); continue;
        }
        if (result > 0) {
          writing = false;
          if (written > current.size() - sent) { cy_serial_close(port); port = NULL; current.clear(); Failure("写入计数", 13); continue; }
          if (written) { std::lock_guard<std::mutex> lock(mutex); tx += written; Event("tx", "", current.data() + sent, written); }
          sent += written; if (sent == current.size()) current.clear();
        }
      }
      std::unique_lock<std::mutex> lock(mutex);
      wake.wait_for(lock, std::chrono::milliseconds(10), [this] { return stop || shutdown; });
    }
  }
};

SerialDebugService::SerialDebugService() : impl_(new Impl) {}
SerialDebugService::~SerialDebugService() { Stop(); }
void SerialDebugService::Stop() {
  { std::lock_guard<std::mutex> lock(impl_->mutex); impl_->shutdown = true; impl_->wake.notify_all(); }
  if (impl_->worker.joinable()) impl_->worker.join();
  std::lock_guard<std::mutex> lock(impl_->mutex);
  impl_->state = "stopped"; impl_->opening = false; impl_->outgoing.clear(); impl_->queuedBytes = 0;
}

nlohmann::json SerialDebugService::Handle(const std::string& action, const nlohmann::json& payload) {
  if (!payload.is_object()) throw std::runtime_error("串口请求参数必须为对象。");
  if (action == "enumerate") {
    cy_serial_port_entry entries[256]; unsigned long code = 0;
    const int count = cy_serial_enumerate(entries, 256, &code);
    if (count < 0) throw std::runtime_error("枚举 COM 端口失败（Win32 " + std::to_string(code) + "）。");
    Json ports = Json::array();
    for (int i = 0; i < count; ++i) ports.push_back(Json{{"port", entries[i].port}, {"label", entries[i].device}});
    return Json{{"ports", ports}};
  }
  std::unique_lock<std::mutex> lock(impl_->mutex);
  if (action == "start") {
    if (impl_->state != "stopped" && impl_->state != "error") throw std::runtime_error("请先关闭当前串口。");
    const cy_serial_options options = Options(payload);
    impl_->options = options; impl_->rx = impl_->tx = 0; impl_->lastError.clear(); impl_->events.clear(); impl_->eventBytes = 0; impl_->dropped = 0;
    impl_->outgoing.clear(); impl_->queuedBytes = 0; impl_->stop = false; impl_->shutdown = false; impl_->state = "opening"; impl_->opening = true;
    if (!impl_->worker.joinable()) {
      try { impl_->worker = std::thread(&Impl::Loop, impl_.get()); }
      catch (...) { impl_->opening = false; impl_->state = "error"; throw; }
    }
    impl_->Event("status", "正在打开串口…"); impl_->wake.notify_all();
  } else if (action == "stop") {
    if (impl_->state != "stopped" && impl_->state != "error") { impl_->state = "stopping"; impl_->stop = true; impl_->wake.notify_all(); }
  } else if (action == "send") {
    if (impl_->state != "open") throw std::runtime_error("请先打开串口。");
    std::vector<unsigned char> bytes = Decode(payload);
    if (impl_->outgoing.size() >= 128 || impl_->queuedBytes + bytes.size() > 262144) throw std::runtime_error("串口发送队列已满，请降低循环频率。");
    impl_->queuedBytes += bytes.size(); impl_->outgoing.push_back(std::move(bytes)); impl_->wake.notify_all();
  } else if (action == "poll") {
    Json events = Json::array();
    if (impl_->dropped) {
      const unsigned long long noticeId = impl_->events.empty() ? impl_->sequence : impl_->events.front()["id"].get<unsigned long long>() - 1;
      events.push_back(Json{{"id", noticeId}, {"kind", "status"}, {"timestamp", Now()}, {"dataHex", ""}, {"byteLength", 0}, {"message", "日志缓冲已满，已移除 " + std::to_string(impl_->dropped) + " 条较早记录；字节统计仍累计。"}}); impl_->dropped = 0;
    }
    for (int i = 0; i < 128 && !impl_->events.empty(); ++i) { impl_->eventBytes -= impl_->events.front()["dataHex"].get_ref<const std::string&>().size(); events.push_back(std::move(impl_->events.front())); impl_->events.pop_front(); }
    return Json{{"snapshot", impl_->Snapshot()}, {"events", events}};
  } else throw std::runtime_error("未知串口操作。");
  return Json{{"snapshot", impl_->Snapshot()}};
}
}
