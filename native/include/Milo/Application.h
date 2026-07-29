#pragma once

/// @file
/// @brief Coordinates persistence, windows, reminders, characters and tray UI.

#include <windows.h>
#include <shellapi.h>
#include <sapi.h>
#include <wrl/client.h>

#include <memory>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "Milo/ReminderStore.h"
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

/// Owns the desktop pet process and mediates all frontend/native communication.
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
  /// Persists the pet window position after a drag or display change.
  void SavePetPosition(HWND window);
  /// Closes all windows and exits the process.
  void Quit();

  /// Directory containing the packaged React build.
  [[nodiscard]] const std::wstring& UiDirectory() const { return uiDirectory_; }
  /// Private WebView2 profile directory.
  [[nodiscard]] const std::wstring& WebViewDataDirectory() const {
    return webViewDataDirectory_;
  }
  /// Private directory that stores imported character images.
  [[nodiscard]] const std::wstring& CharacterDirectory() const {
    return characterDirectory_;
  }
  /// Last persisted top-left point for the pet window, if available.
  [[nodiscard]] const std::optional<POINT>& PetPosition() const {
    return petPosition_;
  }
  /// Current user-defined pet name encoded as UTF-8.
  [[nodiscard]] const std::string& PetName() const { return petName_; }

 private:
  // Notification-area lifecycle and native notifications.
  void AddTrayIcon();
  void RemoveTrayIcon();
  void ShowTrayMenu();
  void ShowNativeNotification(const Reminder& reminder);
  void PlayReminderAlert(const Reminder& reminder);

  // Window lifecycle and state synchronization.
  void UpdateBranding();
  void EnsureDashboard();
  void Broadcast(const nlohmann::json& message);
  void SendState(WebViewWindow* target = nullptr);
  nlohmann::json BuildState();
  void SendError(WebViewWindow& target, const std::string& message);

  // Character wardrobe persistence.
  void LoadCharacters();
  void SaveCharacters();
  bool HasCharacter(const std::string& id) const;

  HINSTANCE instance_{};
  std::unique_ptr<WebViewWindow> petWindow_;
  std::unique_ptr<WebViewWindow> dashboardWindow_;
  ReminderStore reminders_;
  std::wstring uiDirectory_;
  std::wstring webViewDataDirectory_;
  std::wstring characterDirectory_;
  std::wstring onboardingMarker_;
  std::optional<POINT> petPosition_;
  std::optional<std::int64_t> presentedReminderId_;
  std::string petName_{"可爱依依"};
  std::vector<CharacterProfile> characters_;
  std::string activeCharacterId_{"builtin"};
  bool soundEnabled_{true};
  bool speechEnabled_{};
  bool autoHideEnabled_{true};
  int autoHideMinutes_{10};
  Microsoft::WRL::ComPtr<ISpVoice> speechVoice_;
  /// Shell_NotifyIcon state must remain alive while the tray icon exists.
  NOTIFYICONDATA trayIcon_{};
  bool trayIconAdded_{};
  bool showDashboardOnStart_{};
};

}  // namespace milo
