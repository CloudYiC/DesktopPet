#pragma once
#include <memory>
#include <string>
#include <nlohmann/json.hpp>
namespace milo {
/** One exclusive COM session. Handle only queues IO; the worker owns every device handle. */
class SerialDebugService final {
 public:
  SerialDebugService();
  ~SerialDebugService();
  SerialDebugService(const SerialDebugService&) = delete;
  SerialDebugService& operator=(const SerialDebugService&) = delete;
  nlohmann::json Handle(const std::string& action, const nlohmann::json& payload);
  /** Host shutdown boundary: cancel pending IO, release COM and join its worker. */
  void Stop();
 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};
}
