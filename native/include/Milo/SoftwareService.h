#pragma once

/// @file
/// @brief Installed-software inventory, standard uninstall and safe cleanup.

#include <cstdint>
#include <string>
#include <vector>

namespace milo {

/// One uninstallable record read from Windows' registered application list.
struct InstalledSoftware {
  std::string id;
  std::string displayName;
  std::string displayVersion;
  std::string publisher;
  std::string installLocation;
  std::string registryPath;
  std::uint64_t estimatedSizeBytes{};
  bool installLocationInferred{};
  bool currentUser{};
  bool systemComponent{};
  bool noRemove{};
  bool windowsInstaller{};
};

/// An exact existing path associated with the selected application.
struct SoftwareResidual {
  std::string path;
  std::string label;
  std::string kind;
  std::string evidence;
  std::string confidence;
  std::uint64_t sizeBytes{};
  std::uint32_t itemCount{};
  bool sizeTruncated{};
  bool defaultSelected{};
  bool personalData{};
};

/// Server-side cleanup session; only these exact paths may later be removed.
struct SoftwareCleanupPlan {
  std::string token;
  std::string softwareId;
  std::string displayName;
  std::vector<SoftwareResidual> residuals;
};

/// Result returned by standard-uninstall and residual-cleanup operations.
struct SoftwareOperationResult {
  bool succeeded{};
  std::string message;
  std::vector<std::string> removedPaths;
  std::vector<std::string> failedPaths;
};

/**
 * Stateful service that revalidates every destructive request. A cleanup call
 * can only reference paths from the most recent native scan and therefore
 * cannot turn a forged WebView message into an arbitrary file deletion.
 */
class SoftwareService final {
 public:
  std::vector<InstalledSoftware> ListInstalled() const;
  SoftwareCleanupPlan ScanResiduals(const std::string& softwareId,
                                    const std::string& expectedName);
  SoftwareOperationResult LaunchRegisteredUninstaller(
      const std::string& softwareId, const std::string& expectedName,
      bool confirmed) const;
  SoftwareOperationResult CleanupResiduals(
      const std::string& planToken, const std::string& typedName,
      const std::vector<std::string>& selectedPaths, bool confirmed);

 private:
  SoftwareCleanupPlan activePlan_;
};

}  // namespace milo
