#pragma once

/// @file
/// @brief Bounded asynchronous MQTT 3.1.1 client for the desktop workbench.

#include <memory>
#include <string>

#include <nlohmann/json.hpp>

namespace milo {

/**
 * Owns one MQTT client worker. Handle only validates/enqueues UI commands;
 * DNS, TCP, TLS and MQTT I/O remain on the cancellable background thread.
 */
class MqttDebugService final {
 public:
  MqttDebugService();
  ~MqttDebugService();

  MqttDebugService(const MqttDebugService&) = delete;
  MqttDebugService& operator=(const MqttDebugService&) = delete;

  /** Handles `start`, `stop`, `poll`, `subscribe`, `unsubscribe`, `publish`. */
  nlohmann::json Handle(const std::string& action,
                        const nlohmann::json& payload);

  /** Cancels pending work, closes transport handles and joins the worker. */
  void Stop();

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace milo
