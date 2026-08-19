#pragma once

/// @file
/// @brief Coordinates persistence, windows, reminders, characters and tray UI.

#include <windows.h>
#include <shellapi.h>
#include <sapi.h>
#include <wrl/client.h>

#include <memory>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "Milo/ReminderStore.h"
#include "Milo/SoftwareService.h"
#include "Milo/WebViewWindow.h"

namespace milo {

/// Persisted metadata for a user-imported character image.
struct CharacterProfile {
  /// Stable identifier used by the frontend/native message protocol.
  std::string id;
  /// User-facing wardrobe label.
  std::string name;
  /// File name relative to the private character directory.
  std::string fileName;
  /// Rendering layout: `single` or `sheet`.
  std::string layout;
};

/// Owns the desktop assistant process and mediates frontend/native communication.
class Application final {
 public:
  /// Creates the application services and opens the local data store.
  explicit Application(HINSTANCE instance);
  ~Application();

  Application(const Application&) = delete;
  Application& operator=(const Application&) = delete;

  /// Creates the windows and tray icon, then runs the Win32 message loop.
  int Run(int showCommand);
  /// Validates and dispatches a JSON message received from a WebView.
  void HandleWebMessage(WebViewWindow& source, const std::string& rawMessage);
  /// Processes due reminders and checks whether the pet should auto-hide.
  void HandleTimer();
  /// Handles notification-area callbacks for the application tray icon.
  void HandleTrayMessage(LPARAM event);
  /// Opens or foregrounds the reminder dashboard.
  void ShowDashboard();
  /// Closes the dashboard surface and restores the pet when it opened it.
  void CloseDashboard();
  /// Persists the pet window position after a drag or display change.
  void SavePetPosition(HWND window);
  /// Closes all windows and exits the process.
  void Quit();

  /// Directory containing the packaged React build.
  const std::wstring& UiDirectory() const { return uiDirectory_; }
  /// Private WebView2 profile directory.
  const std::wstring& WebViewDataDirectory() const {
    return webViewDataDirectory_;
  }
  /// Private directory that stores imported character images.
  const std::wstring& CharacterDirectory() const {
    return characterDirectory_;
  }
  /// Returns whether a persisted pet position is available.
  bool HasPetPosition() const { return hasPetPosition_; }
  /// Returns the last persisted top-left point for the pet window.
  const POINT& PetPosition() const {
    return petPosition_;
  }
  /// Current user-defined pet name encoded as UTF-8.
  const std::string& PetName() const { return petName_; }

 private:
  // Notification-area lifecycle and native notifications.
  void AddTrayIcon();
  void RemoveTrayIcon();
  void ShowTrayMenu();
  void ShowNativeNotification(const Reminder& reminder);
  void PlayReminderAlert(const Reminder& reminder);

  // Window lifecycle and state synchronization.
  void UpdateBranding();
  void ApplyCharacterIcon(const std::wstring& iconPath);
  void EnsureDashboard();
  void Broadcast(const nlohmann::json& message);
  void SendState(WebViewWindow* target = nullptr);
  nlohmann::json BuildState();
  void SendError(WebViewWindow& target, const std::string& message);

  // Character wardrobe persistence.
  void LoadCharacters();
  void SaveCharacters();
  bool HasCharacter(const std::string& id) const;
  bool HasPackagedGirl() const;
  std::string DefaultCharacterId() const;

  HINSTANCE instance_{};
  std::unique_ptr<WebViewWindow> petWindow_;
  std::unique_ptr<WebViewWindow> dashboardWindow_;
  ReminderStore reminders_;
  /// Revalidates registered uninstallers and cleanup paths across requests.
  SoftwareService softwareService_;
  std::wstring uiDirectory_;
  std::wstring webViewDataDirectory_;
  std::wstring characterDirectory_;
  std::wstring onboardingMarker_;
  std::wstring activeCharacterIconPath_;
  /// Database Studio can only operate on a path selected by a native dialog.
  std::wstring activeDatabasePath_;
  POINT petPosition_{};
  bool hasPetPosition_{};
  std::int64_t presentedReminderId_{};
  bool hasPresentedReminder_{};
  /// Priority retained when a reminder arrives while the dashboard is open.
  std::string presentedReminderPriority_{"normal"};
  std::string petName_{"可爱依依"};
  std::vector<CharacterProfile> characters_;
  std::string activeCharacterId_{"builtin"};
  bool soundEnabled_{true};
  bool speechEnabled_{};
  bool autoHideEnabled_{true};
  int autoHideMinutes_{10};
  std::string workspaceTheme_{"warm"};
  std::string workspaceTextSize_{"comfortable"};
  bool openLastView_{true};
  std::string lastDashboardView_{"today"};
  std::string lastToolCategory_;
  Microsoft::WRL::ComPtr<ISpVoice> speechVoice_;
  /// Shell_NotifyIcon state must remain alive while the tray icon exists.
  NOTIFYICONDATA trayIcon_{};
  bool trayIconAdded_{};
  /// Runtime icons are regenerated from the selected wardrobe character.
  HICON activeLargeIcon_{};
  HICON activeSmallIcon_{};
  bool showDashboardOnStart_{};
  /// Remembers whether opening the dashboard temporarily displaced the pet.
  bool restorePetAfterDashboard_{};
  /// Prevents window-close callbacks from reviving the pet during shutdown.
  bool quitting_{};
};

}  // namespace milo
