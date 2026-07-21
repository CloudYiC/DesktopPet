#include "Milo/Application.h"

#include <shellapi.h>
#include <strsafe.h>

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <stdexcept>

#include "Milo/Utils.h"

namespace milo {
namespace {

constexpr UINT kTrayIconId = 1;
constexpr UINT kTrayMessage = WM_APP + 42;
constexpr UINT kOpenDashboardCommand = 1001;
constexpr UINT kHidePetCommand = 1002;
constexpr UINT kQuitCommand = 1003;

nlohmann::json ReminderToJson(const Reminder& reminder) {
  return {{"id", reminder.id},
          {"title", reminder.title},
          {"dueAt", reminder.dueAt},
          {"completed", reminder.completed},
          {"notified", reminder.notified},
          {"repeatRule", reminder.repeatRule},
          {"priority", reminder.priority}};
}

bool IsValidPetName(const std::string& name) {
  if (name.empty() || name.size() > 64) {
    return false;
  }
  bool hasVisibleCharacter = false;
  std::size_t characterCount = 0;
  for (const unsigned char character : name) {
    if (character < 0x20 || character == 0x7f) {
      return false;
    }
    if (character >= 0x80 || !std::isspace(character)) {
      hasVisibleCharacter = true;
    }
    if ((character & 0xc0) != 0x80) {
      ++characterCount;
    }
  }
  return hasVisibleCharacter && characterCount <= 16;
}

}  // namespace

Application::Application(HINSTANCE instance) : instance_(instance) {
  const std::filesystem::path executableDirectory = ExecutableDirectory();
  uiDirectory_ = (executableDirectory / L"ui").wstring();

  const std::filesystem::path appData = AppDataDirectory();
  webViewDataDirectory_ = (appData / L"WebView2").wstring();
  onboardingMarker_ = (appData / L"onboarding.complete").wstring();
  showDashboardOnStart_ = !std::filesystem::exists(onboardingMarker_);
  std::filesystem::create_directories(webViewDataDirectory_);
  reminders_.Open((appData / L"yiyi.db").wstring());
  try {
    if (const auto savedName = reminders_.GetSetting("pet.name");
        savedName.has_value() && IsValidPetName(*savedName)) {
      petName_ = *savedName;
    }
    if (const auto sound = reminders_.GetSetting("audio.sound");
        sound.has_value()) {
      soundEnabled_ = *sound != "0";
    }
    if (const auto speech = reminders_.GetSetting("audio.speech");
        speech.has_value()) {
      speechEnabled_ = *speech == "1";
    }
    const auto x = reminders_.GetSetting("pet.x");
    const auto y = reminders_.GetSetting("pet.y");
    if (x.has_value() && y.has_value()) {
      petPosition_ = POINT{std::stoi(*x), std::stoi(*y)};
    }
  } catch (const std::exception&) {
    petPosition_.reset();
  }
}

Application::~Application() { RemoveTrayIcon(); }

int Application::Run(int) {
  if (!std::filesystem::exists(
          std::filesystem::path(uiDirectory_) / L"index.html")) {
    throw std::runtime_error(
        "React UI was not found. Run scripts/build.ps1 to build the app.");
  }

  petWindow_ = std::make_unique<WebViewWindow>(*this, WindowKind::Pet);

  if (!petWindow_->Create(instance_)) {
    throw std::runtime_error("Unable to create the application windows.");
  }

  AddTrayIcon();
  petWindow_->Show();
  if (showDashboardOnStart_) {
    ShowDashboard();
    std::ofstream marker(std::filesystem::path(onboardingMarker_),
                         std::ios::binary | std::ios::trunc);
    marker << "CuteYiyiDesktopPet 0.5.0";
  }

  MSG message{};
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
  return static_cast<int>(message.wParam);
}

void Application::HandleWebMessage(WebViewWindow& source,
                                   const std::string& rawMessage) {
  try {
    const nlohmann::json message = nlohmann::json::parse(rawMessage);
    const std::string type = message.value("type", "");
    const nlohmann::json payload =
        message.contains("payload") ? message.at("payload")
                                    : nlohmann::json::object();

    if (type == "app.ready" || type == "reminder.list") {
      SendState(&source);
      return;
    }
    if (type == "window.drag") {
      source.BeginDrag();
      return;
    }
    if (type == "window.openDashboard") {
      ShowDashboard();
      return;
    }
    if (type == "window.hideDashboard") {
      if (dashboardWindow_ != nullptr) {
        dashboardWindow_->Hide();
      }
      return;
    }
    if (type == "window.hidePet") {
      petWindow_->Hide();
      return;
    }
    if (type == "app.quit") {
      Quit();
      return;
    }
    if (type == "pet.action") {
      const std::string action = payload.value("action", "");
      constexpr const char* kAllowedActions[] = {
          "idle", "walkLeft", "walkRight", "wave", "hop", "sleepy",
          "petted"};
      const bool validAction = std::find(
          std::begin(kAllowedActions), std::end(kAllowedActions), action) !=
                               std::end(kAllowedActions);
      if (!validAction) {
        SendError(source, "这个动作暂时还不会哦。");
        return;
      }
      Broadcast({{"type", "pet.action"},
                 {"payload", {{"action", action}}}});
      return;
    }
    if (type == "settings.update") {
      const std::string petName = payload.value("petName", petName_);
      if (!IsValidPetName(petName)) {
        SendError(source, "名字需要是 1 到 16 个左右的可见字符。");
        return;
      }
      petName_ = petName;
      soundEnabled_ = payload.value("soundEnabled", soundEnabled_);
      speechEnabled_ = payload.value("speechEnabled", speechEnabled_);
      reminders_.SetSetting("pet.name", petName_);
      reminders_.SetSetting("audio.sound", soundEnabled_ ? "1" : "0");
      reminders_.SetSetting("audio.speech", speechEnabled_ ? "1" : "0");
      UpdateBranding();
      SendState();
      return;
    }
    if (type == "reminder.create") {
      const std::string title = payload.value("title", "");
      const std::int64_t dueAt = payload.value("dueAt", std::int64_t{});
      const std::string repeatRule = payload.value("repeatRule", "none");
      const std::string priority = payload.value("priority", "normal");
      const bool validRule =
          repeatRule == "none" || repeatRule == "daily" ||
          repeatRule == "weekdays" || repeatRule == "weekly";
      const bool validPriority = priority == "normal" ||
                                 priority == "important" ||
                                 priority == "urgent";
      if (title.empty() || title.size() > 160 || dueAt <= 0 || !validRule ||
          !validPriority) {
        SendError(source, "请填写有效的事项名称和提醒时间。");
        return;
      }
      reminders_.Create(title, dueAt, repeatRule, priority);
      SendState();
      Broadcast({{"type", "pet.action"},
                 {"payload", {{"action", "wave"}}}});
      return;
    }
    if (type == "reminder.complete") {
      const auto id = payload.value("id", std::int64_t{});
      reminders_.Complete(id, UnixTimeMilliseconds());
      Broadcast({{"type", "reminder.completed"},
                 {"payload", {{"id", id}}}});
      if (soundEnabled_) {
        MessageBeep(MB_OK);
      }
      if (presentedReminderId_ == id) {
        petWindow_->EndReminderPresentation();
        presentedReminderId_.reset();
        Broadcast({{"type", "reminder.dismissed"}, {"payload", {{"id", id}}}});
      }
      SendState();
      return;
    }
    if (type == "reminder.delete") {
      const auto id = payload.value("id", std::int64_t{});
      reminders_.Remove(id);
      if (presentedReminderId_ == id) {
        petWindow_->EndReminderPresentation();
        presentedReminderId_.reset();
        Broadcast({{"type", "reminder.dismissed"}, {"payload", {{"id", id}}}});
      }
      SendState();
      return;
    }
    if (type == "reminder.snooze") {
      const auto id = payload.value("id", std::int64_t{});
      const auto minutes =
          std::clamp(payload.value("minutes", 5), 1, 24 * 60);
      reminders_.Snooze(id,
                        UnixTimeMilliseconds() + minutes * 60LL * 1000LL);
      if (presentedReminderId_ == id) {
        petWindow_->EndReminderPresentation();
        presentedReminderId_.reset();
      }
      SendState();
      Broadcast({{"type", "reminder.dismissed"}, {"payload", {{"id", id}}}});
      return;
    }

    SendError(source, "暂不支持这个操作。");
  } catch (const nlohmann::json::exception&) {
    SendError(source, "界面发送的数据格式不正确。");
  } catch (const std::exception& error) {
    SendError(source, error.what());
  }
}

void Application::HandleTimer() {
  try {
    const std::vector<Reminder> due =
        reminders_.TakeDue(UnixTimeMilliseconds());
    for (const Reminder& reminder : due) {
      petWindow_->Show();
      petWindow_->BeginReminderPresentation(reminder.priority);
      presentedReminderId_ = reminder.id;
      PlayReminderAlert(reminder);
      ShowNativeNotification(reminder);
      Broadcast({{"type", "reminder.triggered"},
                 {"payload", ReminderToJson(reminder)}});
    }
    if (!due.empty()) {
      SendState();
    }
  } catch (const std::exception& error) {
    Broadcast({{"type", "app.error"},
               {"payload", {{"message", error.what()}}}});
  }
}

void Application::HandleTrayMessage(LPARAM event) {
  const UINT notification = LOWORD(event);
  if (notification == WM_LBUTTONDBLCLK ||
      notification == NIN_BALLOONUSERCLICK) {
    ShowDashboard();
  } else if (notification == WM_RBUTTONUP ||
             notification == WM_CONTEXTMENU) {
    ShowTrayMenu();
  }
}

void Application::ShowDashboard() {
  EnsureDashboard();
  dashboardWindow_->Show();
  SendState(dashboardWindow_.get());
}

void Application::SavePetPosition(HWND window) {
  RECT bounds{};
  if (!GetWindowRect(window, &bounds)) {
    return;
  }
  petPosition_ = POINT{bounds.left, bounds.top};
  reminders_.SetSetting("pet.x", std::to_string(bounds.left));
  reminders_.SetSetting("pet.y", std::to_string(bounds.top));
}

void Application::Quit() {
  RemoveTrayIcon();
  if (dashboardWindow_ != nullptr &&
      IsWindow(dashboardWindow_->Handle())) {
    DestroyWindow(dashboardWindow_->Handle());
  }
  if (petWindow_ != nullptr && IsWindow(petWindow_->Handle())) {
    DestroyWindow(petWindow_->Handle());
  }
}

void Application::AddTrayIcon() {
  trayIcon_ = {};
  trayIcon_.cbSize = sizeof(trayIcon_);
  trayIcon_.hWnd = petWindow_->Handle();
  trayIcon_.uID = kTrayIconId;
  trayIcon_.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
  trayIcon_.uCallbackMessage = kTrayMessage;
  trayIcon_.hIcon = LoadIconW(nullptr, IDI_INFORMATION);
  const std::wstring tooltip = Utf8ToWide(petName_) + L"桌面宠物";
  StringCchCopyW(trayIcon_.szTip, ARRAYSIZE(trayIcon_.szTip),
                 tooltip.c_str());
  trayIconAdded_ = Shell_NotifyIconW(NIM_ADD, &trayIcon_) == TRUE;
  if (trayIconAdded_) {
    trayIcon_.uVersion = NOTIFYICON_VERSION_4;
    Shell_NotifyIconW(NIM_SETVERSION, &trayIcon_);
  }
}

void Application::RemoveTrayIcon() {
  if (trayIconAdded_) {
    Shell_NotifyIconW(NIM_DELETE, &trayIcon_);
    trayIconAdded_ = false;
  }
}

void Application::ShowTrayMenu() {
  POINT cursor{};
  GetCursorPos(&cursor);

  HMENU menu = CreatePopupMenu();
  AppendMenuW(menu, MF_STRING, kOpenDashboardCommand, L"打开事项中心");
  const std::wstring petName = Utf8ToWide(petName_);
  const std::wstring visibilityLabel =
      IsWindowVisible(petWindow_->Handle()) ? L"暂时隐藏" + petName
                                            : L"显示" + petName;
  AppendMenuW(menu, MF_STRING, kHidePetCommand, visibilityLabel.c_str());
  AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
  AppendMenuW(menu, MF_STRING, kQuitCommand, L"退出");

  SetForegroundWindow(petWindow_->Handle());
  const UINT command = TrackPopupMenu(
      menu, TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_NONOTIFY, cursor.x,
      cursor.y, 0, petWindow_->Handle(), nullptr);
  DestroyMenu(menu);

  switch (command) {
    case kOpenDashboardCommand:
      ShowDashboard();
      break;
    case kHidePetCommand:
      if (IsWindowVisible(petWindow_->Handle())) {
        petWindow_->Hide();
      } else {
        petWindow_->Show();
      }
      break;
    case kQuitCommand:
      Quit();
      break;
    default:
      break;
  }
}

void Application::ShowNativeNotification(const Reminder& reminder) {
  if (!trayIconAdded_) {
    return;
  }
  trayIcon_.uFlags = NIF_INFO;
  trayIcon_.dwInfoFlags =
      NIIF_INFO | NIIF_RESPECT_QUIET_TIME | NIIF_NOSOUND;
  const std::wstring title = Utf8ToWide(petName_) + L"提醒你";
  const std::wstring body = Utf8ToWide(reminder.title);
  StringCchCopyW(trayIcon_.szInfoTitle, ARRAYSIZE(trayIcon_.szInfoTitle),
                 title.c_str());
  StringCchCopyW(trayIcon_.szInfo, ARRAYSIZE(trayIcon_.szInfo), body.c_str());
  Shell_NotifyIconW(NIM_MODIFY, &trayIcon_);
}

void Application::PlayReminderAlert(const Reminder& reminder) {
  if (soundEnabled_) {
    MessageBeep(reminder.priority == "urgent" ? MB_ICONEXCLAMATION
                                               : MB_ICONINFORMATION);
  }
  if (!speechEnabled_) {
    return;
  }
  if (speechVoice_ == nullptr) {
    CoCreateInstance(CLSID_SpVoice, nullptr, CLSCTX_INPROC_SERVER,
                     IID_PPV_ARGS(&speechVoice_));
  }
  if (speechVoice_ != nullptr) {
    const std::wstring speech = Utf8ToWide(petName_) + L"提醒你，" +
                                Utf8ToWide(reminder.title);
    speechVoice_->Speak(speech.c_str(),
                        SPF_ASYNC | SPF_PURGEBEFORESPEAK, nullptr);
  }
}

void Application::UpdateBranding() {
  const std::wstring petName = Utf8ToWide(petName_);
  if (petWindow_ != nullptr) {
    petWindow_->SetTitle(petName);
  }
  if (dashboardWindow_ != nullptr) {
    dashboardWindow_->SetTitle(petName + L" · 事项中心");
  }
  if (trayIconAdded_) {
    trayIcon_.uFlags = NIF_TIP;
    const std::wstring tooltip = petName + L"桌面宠物";
    StringCchCopyW(trayIcon_.szTip, ARRAYSIZE(trayIcon_.szTip),
                   tooltip.c_str());
    Shell_NotifyIconW(NIM_MODIFY, &trayIcon_);
  }
}

void Application::EnsureDashboard() {
  if (dashboardWindow_ != nullptr) {
    return;
  }
  dashboardWindow_ =
      std::make_unique<WebViewWindow>(*this, WindowKind::Dashboard);
  if (!dashboardWindow_->Create(instance_)) {
    dashboardWindow_.reset();
    throw std::runtime_error("Unable to create the dashboard window.");
  }
}

void Application::Broadcast(const nlohmann::json& message) {
  const std::string serialized = message.dump();
  if (petWindow_ != nullptr && petWindow_->IsReady()) {
    petWindow_->PostJson(serialized);
  }
  if (dashboardWindow_ != nullptr && dashboardWindow_->IsReady()) {
    dashboardWindow_->PostJson(serialized);
  }
}

void Application::SendState(WebViewWindow* target) {
  const nlohmann::json message =
      {{"type", "state.sync"}, {"payload", BuildState()}};
  if (target != nullptr) {
    target->PostJson(message.dump());
  } else {
    Broadcast(message);
  }
}

nlohmann::json Application::BuildState() {
  nlohmann::json items = nlohmann::json::array();
  for (const Reminder& reminder : reminders_.List()) {
    items.push_back(ReminderToJson(reminder));
  }
  return {{"reminders", std::move(items)},
          {"now", UnixTimeMilliseconds()},
          {"petName", petName_},
          {"soundEnabled", soundEnabled_},
          {"speechEnabled", speechEnabled_}};
}

void Application::SendError(WebViewWindow& target,
                            const std::string& message) {
  target.PostJson(
      nlohmann::json{{"type", "app.error"},
                     {"payload", {{"message", message}}}}
          .dump());
}

}  // namespace milo
