#pragma once
#include <memory>
#include <string>
#include <nlohmann/json.hpp>

namespace milo {
/** Single-owner Modbus client. UI calls only validate/enqueue; a persistent
 * worker owns TCP/COM handles. Stop() waits for a close barrier, while
 * Handle("stop") is asynchronous and immediately invalidates pending IO. */
class ModbusDebugService final {
 public:
  ModbusDebugService();
  ~ModbusDebugService();
  ModbusDebugService(const ModbusDebugService&) = delete;
  ModbusDebugService& operator=(const ModbusDebugService&) = delete;
  nlohmann::json Handle(const std::string& action, const nlohmann::json& payload);
  void Stop();
 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};
}  // namespace milo
