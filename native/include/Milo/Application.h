#pragma once

#include <windows.h>
#include <shellapi.h>
#include <sapi.h>
#include <wrl/client.h>

#include <memory>
#include <optional>
#include <string>

#include <nlohmann/json.hpp>

#include "Milo/ReminderStore.h"
#include "Milo/WebViewWindow.h"

namespace milo {

class Application final {
 public:
  explicit Application(HINSTANCE instance);
  ~Application();

  Application(const Application&) = delete;
  Application& operator=(const Application&) = delete;

  int Run(int showCommand);
  void HandleWebMessage(WebViewWindow& source, const std::string& rawMessage);
  void HandleTimer();
  void HandleTrayMessage(LPARAM event);
  void ShowDashboard();
  void SavePetPosition(HWND window);
  void Quit();

  [[nodiscard]] const std::wstring& UiDirectory() const { return uiDirectory_; }
  [[nodiscard]] const std::wstring& WebViewDataDirectory() const {
    return webViewDataDirectory_;
  }
  [[nodiscard]] const std::optional<POINT>& PetPosition() const {
    return petPosition_;
  }
  [[nodiscard]] const std::string& PetName() const { return petName_; }

 private:
  void AddTrayIcon();
  void RemoveTrayIcon();
  void ShowTrayMenu();
  void ShowNativeNotification(const Reminder& reminder);
  void PlayReminderAlert(const Reminder& reminder);
  void UpdateBranding();
  void EnsureDashboard();
  void Broadcast(const nlohmann::json& message);
  void SendState(WebViewWindow* target = nullptr);
  nlohmann::json BuildState();
  void SendError(WebViewWindow& target, const std::string& message);

  HINSTANCE instance_{};
  std::unique_ptr<WebViewWindow> petWindow_;
  std::unique_ptr<WebViewWindow> dashboardWindow_;
  ReminderStore reminders_;
  std::wstring uiDirectory_;
  std::wstring webViewDataDirectory_;
  std::wstring onboardingMarker_;
  std::optional<POINT> petPosition_;
  std::optional<std::int64_t> presentedReminderId_;
  std::string petName_{"可爱依依"};
  bool soundEnabled_{true};
  bool speechEnabled_{};
  Microsoft::WRL::ComPtr<ISpVoice> speechVoice_;
  NOTIFYICONDATA trayIcon_{};
  bool trayIconAdded_{};
  bool showDashboardOnStart_{};
};

}  // namespace milo
