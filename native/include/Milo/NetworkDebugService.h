#pragma once

/// @file
/// @brief Asynchronous C++11 owner for the Win32 network debugging engine.

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace milo {

/// User-selected endpoint settings for one network debugging session.
struct NetworkDebugStartOptions {
  /// `tcp-client`, `tcp-server` or `udp`.
  std::string mode;
  /// Local numeric address or host name; empty selects a safe default.
  std::string localHost;
  /// Zero lets Windows select an available local port.
  std::uint16_t localPort{};
  /// Required for TCP client and UDP modes.
  std::string remoteHost;
  /// Required for TCP client and UDP modes.
  std::uint16_t remotePort{};
  /// Explicit consent required before binding outside loopback.
  bool allowLan{};
};

/// One connected TCP peer visible to the debugger.
struct NetworkDebugPeer {
  std::uint64_t id{};
  std::string address;
  std::uint16_t port{};
};

/// Thread-safe point-in-time state returned to the desktop UI.
struct NetworkDebugSnapshot {
  std::string mode{"tcp-client"};
  std::string state{"stopped"};
  std::string localHost{"127.0.0.1"};
  std::uint16_t localPort{};
  std::string remoteHost{"127.0.0.1"};
  std::uint16_t remotePort{9000};
  std::vector<NetworkDebugPeer> peers;
  std::uint64_t rxPackets{};
  std::uint64_t rxBytes{};
  std::uint64_t txPackets{};
  std::uint64_t txBytes{};
  std::string lastError;
};

/// Ordered state, connection or data event emitted by the worker thread.
struct NetworkDebugEvent {
  std::uint64_t id{};
  std::string kind;
  std::int64_t timestamp{};
  std::uint64_t peerId{};
  std::string peerLabel;
  /// Lower-case hexadecimal bytes; empty for non-data events.
  std::string dataHex;
  std::size_t byteLength{};
  std::string message;
};

/// Atomic snapshot plus all currently queued events.
struct NetworkDebugPollResult {
  NetworkDebugSnapshot snapshot;
  std::vector<NetworkDebugEvent> events;
};

/**
 * Owns one non-blocking network session. All Winsock handles are created,
 * used and closed by a single worker thread; callers only enqueue commands.
 */
class NetworkDebugService final {
 public:
  NetworkDebugService();
  ~NetworkDebugService();

  NetworkDebugService(const NetworkDebugService&) = delete;
  NetworkDebugService& operator=(const NetworkDebugService&) = delete;

  /** Starts a new session after stopping any previous one. */
  bool Start(const NetworkDebugStartOptions& options,
             std::string* error = nullptr);

  /** Stops the worker, closes every socket and waits for it to finish. */
  void Stop();

  /** Queues bytes decoded from a hexadecimal string. */
  bool Send(const std::string& dataHex, std::uint64_t targetPeerId = 0,
            std::string* error = nullptr);

  /** Queues at most 64 KiB of binary data. Peer zero broadcasts on a server. */
  bool Send(const std::vector<unsigned char>& bytes,
            std::uint64_t targetPeerId = 0,
            std::string* error = nullptr);

  /** Returns a consistent state copy and drains the bounded event queue. */
  NetworkDebugPollResult Poll();

  /** Returns the current state without draining queued events. */
  NetworkDebugSnapshot Snapshot() const;

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace milo
