#pragma once

/// @file
/// @brief Read-only system inspection and guarded port-owner operations.

#include <cstdint>
#include <string>
#include <vector>

namespace milo {

/// Snapshot displayed by the system center.
struct SystemSnapshot {
  std::string operatingSystem;
  std::string osEdition;
  std::string osDisplayVersion;
  std::string architecture;
  std::string computerName;
  std::string userName;
  std::string processorName;
  std::string systemDrive;
  std::string manufacturer;
  std::string model;
  std::string biosVersion;
  std::string biosDate;
  std::string primaryGraphics;
  std::string timeZone;
  std::string localeName;
  std::string primaryNetworkAdapter;
  std::string primaryIpv4;
  std::uint32_t osBuild{};
  std::uint32_t logicalProcessors{};
  std::uint32_t physicalCores{};
  std::uint32_t processorPackages{};
  std::uint32_t processorMaxMegahertz{};
  std::uint32_t memoryLoadPercent{};
  std::uint32_t primaryDisplayWidth{};
  std::uint32_t primaryDisplayHeight{};
  std::uint32_t primaryDisplayDpi{};
  std::uint32_t activeNetworkAdapters{};
  std::uint32_t batteryPercent{};
  std::uint32_t acLineStatus{};
  bool virtualizationEnabled{};
  std::uint64_t totalMemoryBytes{};
  std::uint64_t availableMemoryBytes{};
  std::uint64_t totalPageFileBytes{};
  std::uint64_t availablePageFileBytes{};
  std::uint64_t systemDiskTotalBytes{};
  std::uint64_t systemDiskFreeBytes{};
  std::uint64_t uptimeMilliseconds{};
  std::uint64_t installUnixSeconds{};
};

/// One local IPv4 TCP or UDP endpoint and its owning process.
struct PortEntry {
  std::string protocol;
  std::string localAddress;
  std::uint16_t localPort{};
  std::string remoteAddress;
  std::uint16_t remotePort{};
  std::string state;
  std::uint32_t processId{};
  std::string processName;
};

/// Result of a guarded process-termination request.
struct ProcessOperationResult {
  bool succeeded{};
  std::string message;
};

/// Reads the current machine's non-sensitive, read-only system metrics.
SystemSnapshot QuerySystemSnapshot();

/// Enumerates IPv4 TCP and UDP endpoints with owning process identifiers.
std::vector<PortEntry> ListPortEntries();

/**
 * Terminates a current port owner after revalidating PID and process name.
 * Critical Windows processes, the application itself and protected targets
 * are always rejected even if the WebView sends a forged confirmation.
 */
ProcessOperationResult TerminatePortOwner(std::uint32_t processId,
                                          const std::string& expectedName);

}  // namespace milo
