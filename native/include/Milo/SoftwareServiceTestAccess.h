#pragma once

// Fixture-only seam: production discovery uses KnownFolders and registered
// identities. Tests supply isolated local roots and never enumerate installed apps.
#include "Milo/SoftwareService.h"

namespace milo {
struct SoftwareServiceTestAccess {
  static SoftwareCleanupPlan ScanShortcuts(
      const InstalledSoftware& software, const std::wstring& executable,
      const std::vector<std::wstring>& roots,
      const std::function<bool()>& cancelled = {}, unsigned maximumDepth = 6,
      unsigned maximumEntries = 16000, unsigned maximumResults = 40);
  static bool Revalidate(const SoftwareResidual& residual);
  static std::wstring UninstallerExecutable(const std::wstring& command);
  static void InstallPlan(SoftwareService& service, const SoftwareCleanupPlan& plan);
  static void SetRegistered(SoftwareService& service, bool registered);
  static bool ProductNameMatches(const InstalledSoftware& software,
                                const std::wstring& executable,
                                const std::wstring& directoryName);
  static bool SharedDirectory(const std::wstring& directory,
                              const std::vector<std::wstring>& otherLocations);
  static bool CanSafelyCleanup(const SoftwareResidual& residual);
};
}
