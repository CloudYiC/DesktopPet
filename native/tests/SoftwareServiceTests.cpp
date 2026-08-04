#include "Milo/SoftwareService.h"

#include <iostream>

int main() {
  try {
    milo::SoftwareService service;
    const std::vector<milo::InstalledSoftware> entries =
        service.ListInstalled();
    for (std::vector<milo::InstalledSoftware>::const_iterator entry =
             entries.begin();
         entry != entries.end(); ++entry) {
      if (entry->id.empty() || entry->displayName.empty() ||
          entry->registryPath.empty() ||
          entry->systemComponent) {
        std::cerr << "Software inventory returned an invalid row.\n";
        return 1;
      }
    }
    if (!entries.empty()) {
      const milo::SoftwareCleanupPlan plan = service.ScanResiduals(
          entries.front().id, entries.front().displayName);
      if (plan.token.size() != 32 ||
          plan.softwareId != entries.front().id) {
        std::cerr << "Generic cleanup scan returned an invalid plan.\n";
        return 1;
      }
      for (std::vector<milo::SoftwareResidual>::const_iterator residual =
               plan.residuals.begin();
           residual != plan.residuals.end(); ++residual) {
        if (residual->path.empty() || residual->evidence.empty() ||
            (residual->confidence != "high" &&
             residual->confidence != "medium") ||
            (residual->personalData && residual->defaultSelected)) {
          std::cerr << "Generic cleanup scan returned unsafe metadata.\n";
          return 1;
        }
      }
    }
    const milo::SoftwareOperationResult forgedUninstall =
        service.LaunchRegisteredUninstaller("missing", "missing", true);
    if (forgedUninstall.succeeded || forgedUninstall.message.empty()) {
      std::cerr << "Forged uninstall request was not rejected.\n";
      return 1;
    }
    const milo::SoftwareOperationResult forgedCleanup =
        service.CleanupResiduals("missing", "missing",
                                 std::vector<std::string>(1, "C:\\Windows"),
                                 true);
    if (forgedCleanup.succeeded || forgedCleanup.message.empty()) {
      std::cerr << "Forged cleanup request was not rejected.\n";
      return 1;
    }
    std::cout << "Software service tests passed: " << entries.size()
              << " registered applications.\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << "\n";
    return 1;
  }
}
