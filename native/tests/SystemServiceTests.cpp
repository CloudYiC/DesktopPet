#include "Milo/SystemService.h"

#include <iostream>

int main() {
  try {
    const milo::SystemSnapshot snapshot = milo::QuerySystemSnapshot();
    if (snapshot.operatingSystem.empty() || snapshot.architecture.empty() ||
        snapshot.logicalProcessors == 0 || snapshot.totalMemoryBytes == 0 ||
        snapshot.availableMemoryBytes > snapshot.totalMemoryBytes ||
        snapshot.memoryLoadPercent > 100 ||
        snapshot.availablePageFileBytes > snapshot.totalPageFileBytes ||
        snapshot.systemDiskFreeBytes > snapshot.systemDiskTotalBytes ||
        (snapshot.physicalCores != 0 &&
         snapshot.physicalCores > snapshot.logicalProcessors) ||
        (snapshot.batteryPercent > 100 && snapshot.batteryPercent != 255)) {
      std::cerr << "System snapshot contains invalid values.\n";
      return 1;
    }
    const std::vector<milo::PortEntry> ports = milo::ListPortEntries();
    for (std::vector<milo::PortEntry>::const_iterator port = ports.begin();
         port != ports.end(); ++port) {
      if ((port->protocol != "TCP" && port->protocol != "UDP") ||
          port->localPort == 0 || port->processName.empty()) {
        std::cerr << "Port enumeration returned an invalid row.\n";
        return 1;
      }
    }
    const milo::ProcessOperationResult protectedResult =
        milo::TerminatePortOwner(4, "System");
    if (protectedResult.succeeded || protectedResult.message.empty()) {
      std::cerr << "Protected process termination was not rejected.\n";
      return 1;
    }
    const milo::ProcessOperationResult forgedResult =
        milo::TerminatePortOwner(0xffffffffU, "not-a-real-process.exe");
    if (forgedResult.succeeded || forgedResult.message.empty()) {
      std::cerr << "Forged port-owner termination was not rejected.\n";
      return 1;
    }
    std::cout << "System service tests passed: " << snapshot.operatingSystem
              << ", " << snapshot.physicalCores << " cores / "
              << snapshot.logicalProcessors << " threads, " << ports.size()
              << " port rows.\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << "\n";
    return 1;
  }
}
