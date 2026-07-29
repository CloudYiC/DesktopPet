#include "Milo/Application.h"

#include <shellapi.h>
#include <strsafe.h>

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <stdexcept>
#include <utility>

#include "Milo/CharacterImage.h"
#include "Milo/Utils.h"
#include "resource.h"

namespace milo {
namespace {

constexpr UINT kTrayIconId = 1;
constexpr UINT kTrayMessage = WM_APP + 42;
constexpr UINT kOpenDashboardCommand = 1001;
constexpr UINT kHidePetCommand = 1002;
constexpr UINT kQuitCommand = 1003;
constexpr int kAutoHideMinuteOptions[] = {1, 2, 5, 10, 20, 30, 60};

/** Converts the persistence model to the protocol shape consumed by React. */
nlohmann::json ReminderToJson(const Reminder& reminder) {
  return {{"id", reminder.id},
          {"title", reminder.title},
          {"dueAt", reminder.dueAt},
          {"completed", reminder.completed},
          {"notified", reminder.notified},
          {"repeatRule", reminder.repeatRule},
          {"priority", reminder.priority}};
}

bool IsValidLabel(const std::string& name, std::size_t maximumCharacters) {
  if (name.empty() || name.size() > 64) {
    return false;
  }
  bool hasVisibleCharacter = false;
  std::size_t characterCount = 0;
  // Count UTF-8 code points by counting non-continuation bytes. This is a
  // compact display-length guard, not a general Unicode grapheme algorithm.
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
  return hasVisibleCharacter && characterCount <= maximumCharacters;
}

bool IsValidPetName(const std::string& name) {
  return IsValidLabel(name, 16);
}

bool IsValidCharacterName(const std::string& name) {
  return IsValidLabel(name, 20);
}

bool IsValidAutoHideMinutes(int minutes) {
  return std::find(std::begin(kAutoHideMinuteOptions),
                   std::end(kAutoHideMinuteOptions),
                   minutes) != std::end(kAutoHideMinuteOptions);
}

bool IsSafeCharacterId(const std::string& value) {
  // Character ids are later embedded in filenames, so allow a strict subset.
  return !value.empty() && value.size() <= 64 &&
         std::all_of(value.begin(), value.end(), [](const unsigned char value) {
           return std::isalnum(value) || value == '-' || value == '_';
         });
}

}  // namespace

Application::Application(HINSTANCE instance) : instance_(instance) {
  const std::filesystem::path executableDirectory = ExecutableDirectory();
  uiDirectory_ = (executableDirectory / L"ui").wstring();

  const std::filesystem::path appData = AppDataDirectory();
  webViewDataDirectory_ = (appData / L"WebView2").wstring();
  characterDirectory_ = (appData / L"Characters").wstring();
  onboardingMarker_ = (appData / L"onboarding.complete").wstring();
  showDashboardOnStart_ = !std::filesystem::exists(onboardingMarker_);
  std::filesystem::create_directories(webViewDataDirectory_);
  std::filesystem::create_directories(characterDirectory_);
  reminders_.Open((appData / L"yiyi.db").wstring());
  // User preferences are recoverable. A malformed legacy setting must not keep
  // the application from starting with safe defaults.
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
    if (const auto autoHide = reminders_.GetSetting("pet.autoHide");
        autoHide.has_value()) {
      autoHideEnabled_ = *autoHide != "0";
    }
    if (const auto autoHideMinutes =
            reminders_.GetSetting("pet.autoHideMinutes");
        autoHideMinutes.has_value()) {
      const int savedMinutes = std::stoi(*autoHideMinutes);
      if (IsValidAutoHideMinutes(savedMinutes)) {
        autoHideMinutes_ = savedMinutes;
      }
    }
    const auto x = reminders_.GetSetting("pet.x");
    const auto y = reminders_.GetSetting("pet.y");
    if (x.has_value() && y.has_value()) {
      petPosition_ = POINT{std::stoi(*x), std::stoi(*y)};
    }
    LoadCharacters();
  } catch (const std::exception&) {
    petPosition_.reset();
    characters_.clear();
    activeCharacterId_ = "builtin";
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
    marker << "CuteYiyiDesktopPet 0.8.0";
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
    // The WebView is a trust boundary: every message is parsed and validated
    // before it reaches persistence, the filesystem, or native window APIs.
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
    if (type == "character.upload") {
      if (characters_.size() >= 12) {
        SendError(source, "角色衣柜最多保存 12 个自定义角色。");
        return;
      }
      const std::string name = payload.value("name", "");
      const std::string layout = payload.value("layout", "single");
      const std::string dataUrl = payload.value("dataUrl", "");
      if (!IsValidCharacterName(name)) {
        SendError(source, "角色名称需要是 1 到 20 个左右的可见字符。");
        return;
      }
      if (layout != "single" && layout != "sheet") {
        SendError(source, "请选择单图或 4×2 动作精灵图。");
        return;
      }

      DecodedCharacterImage image = DecodeCharacterImage(dataUrl);
      std::string id = "character-" + std::to_string(UnixTimeMilliseconds());
      int suffix = 1;
      while (HasCharacter(id)) {
        id = "character-" + std::to_string(UnixTimeMilliseconds()) + "-" +
             std::to_string(suffix++);
      }
      const std::string fileName = id + image.extension;
      const std::filesystem::path imagePath =
          std::filesystem::path(characterDirectory_) / Utf8ToWide(fileName);
      const std::filesystem::path temporaryPath =
          imagePath.wstring() + L".uploading";

      // Write-then-rename prevents half-written character files from appearing
      // in the virtual host if the process is interrupted.
      {
        std::ofstream stream(temporaryPath,
                             std::ios::binary | std::ios::trunc);
        if (!stream) {
          throw std::runtime_error("无法创建角色图片文件。");
        }
        stream.write(reinterpret_cast<const char*>(image.bytes.data()),
                     static_cast<std::streamsize>(image.bytes.size()));
        if (!stream) {
          throw std::runtime_error("保存角色图片时发生错误。");
        }
      }

      std::error_code fileError;
      std::filesystem::rename(temporaryPath, imagePath, fileError);
      if (fileError) {
        std::filesystem::remove(temporaryPath, fileError);
        throw std::runtime_error("无法完成角色图片保存。");
      }

      // Keep the in-memory wardrobe and persisted JSON transaction-like: revert
      // both metadata and image file when saving the settings fails.
      const std::vector<CharacterProfile> previousCharacters = characters_;
      const std::string previousActiveId = activeCharacterId_;
      characters_.push_back({id, name, fileName, layout});
      activeCharacterId_ = id;
      try {
        SaveCharacters();
      } catch (...) {
        characters_ = previousCharacters;
        activeCharacterId_ = previousActiveId;
        std::filesystem::remove(imagePath, fileError);
        throw;
      }
      SendState();
      return;
    }
    if (type == "character.activate") {
      const std::string id = payload.value("id", "");
      if (!HasCharacter(id)) {
        SendError(source, "找不到这个角色，可能已经被删除。");
        return;
      }
      activeCharacterId_ = id;
      SaveCharacters();
      SendState();
      Broadcast({{"type", "pet.action"},
                 {"payload", {{"action", "wave"}}}});
      return;
    }
    if (type == "character.rename") {
      const std::string id = payload.value("id", "");
      const std::string name = payload.value("name", "");
      if (!IsValidCharacterName(name)) {
        SendError(source, "角色名称需要是 1 到 20 个左右的可见字符。");
        return;
      }
      auto character = std::find_if(
          characters_.begin(), characters_.end(),
          [&id](const CharacterProfile& item) { return item.id == id; });
      if (character == characters_.end()) {
        SendError(source, "内置角色不能改名，或角色已经不存在。");
        return;
      }
      const std::string previousName = character->name;
      character->name = name;
      try {
        SaveCharacters();
      } catch (...) {
        character->name = previousName;
        throw;
      }
      SendState();
      return;
    }
    if (type == "character.delete") {
      const std::string id = payload.value("id", "");
      auto character = std::find_if(
          characters_.begin(), characters_.end(),
          [&id](const CharacterProfile& item) { return item.id == id; });
      if (character == characters_.end()) {
        SendError(source, "内置角色不能删除，或角色已经不存在。");
        return;
      }
      const CharacterProfile removed = *character;
      const std::size_t removedIndex =
          static_cast<std::size_t>(std::distance(characters_.begin(), character));
      const std::string previousActiveId = activeCharacterId_;
      characters_.erase(character);
      if (activeCharacterId_ == id) {
        activeCharacterId_ = "builtin";
      }
      try {
        SaveCharacters();
      } catch (...) {
        characters_.insert(characters_.begin() +
                               static_cast<std::ptrdiff_t>(removedIndex),
                           removed);
        activeCharacterId_ = previousActiveId;
        throw;
      }
      std::error_code removeError;
      std::filesystem::remove(
          std::filesystem::path(characterDirectory_) /
              Utf8ToWide(removed.fileName),
          removeError);
      SendState();
      return;
    }
    if (type == "settings.update") {
      const std::string petName = payload.value("petName", petName_);
      if (!IsValidPetName(petName)) {
        SendError(source, "名字需要是 1 到 16 个左右的可见字符。");
        return;
      }
      const int autoHideMinutes =
          payload.value("autoHideMinutes", autoHideMinutes_);
      if (!IsValidAutoHideMinutes(autoHideMinutes)) {
        SendError(source, "自动收起时间只支持 1、2、5、10、20、30 或 60 分钟。");
        return;
      }
      petName_ = petName;
      soundEnabled_ = payload.value("soundEnabled", soundEnabled_);
      speechEnabled_ = payload.value("speechEnabled", speechEnabled_);
      autoHideEnabled_ =
          payload.value("autoHideEnabled", autoHideEnabled_);
      autoHideMinutes_ = autoHideMinutes;
      reminders_.SetSetting("pet.name", petName_);
      reminders_.SetSetting("audio.sound", soundEnabled_ ? "1" : "0");
      reminders_.SetSetting("audio.speech", speechEnabled_ ? "1" : "0");
      reminders_.SetSetting("pet.autoHide", autoHideEnabled_ ? "1" : "0");
      reminders_.SetSetting("pet.autoHideMinutes",
                            std::to_string(autoHideMinutes_));
      if (!autoHideEnabled_) {
        petWindow_->SetAutoTucked(false);
      }
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
    // TakeDue atomically claims occurrences before any UI or audio side effect.
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

    // Windows' system-wide last-input tick includes activity outside this app,
    // matching the user's expectation of "no computer operation".
    LASTINPUTINFO lastInput{sizeof(lastInput)};
    const bool dashboardVisible =
        dashboardWindow_ != nullptr &&
        IsWindowVisible(dashboardWindow_->Handle());
    if (GetLastInputInfo(&lastInput)) {
      const DWORD idleMilliseconds = GetTickCount() - lastInput.dwTime;
      const bool shouldTuck =
          autoHideEnabled_ && !presentedReminderId_.has_value() &&
          !dashboardVisible &&
          idleMilliseconds >=
              static_cast<DWORD>(autoHideMinutes_ * 60 * 1000);
      petWindow_->SetAutoTucked(shouldTuck);
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
  // Load the small resource explicitly so Windows does not downscale the
  // executable's largest frame for the notification area.
  trayIcon_.hIcon = static_cast<HICON>(LoadImageW(
      instance_, MAKEINTRESOURCEW(IDI_CUTE_YIYI_APP), IMAGE_ICON,
      GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON),
      LR_DEFAULTCOLOR | LR_SHARED));
  if (trayIcon_.hIcon == nullptr) {
    trayIcon_.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
  }
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
  // Audio is handled centrally by PlayReminderAlert to avoid two overlapping
  // sounds when Windows displays the tray notification.
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
  nlohmann::json characters = nlohmann::json::array(
      {{{"id", "builtin"},
        {"name", "经典小鼠"},
        {"imageUrl", "https://milo.local/assets/milo-sprite.png"},
        {"layout", "sheet"},
        {"builtIn", true}}});
  for (const CharacterProfile& character : characters_) {
    characters.push_back(
        {{"id", character.id},
         {"name", character.name},
         {"imageUrl", "https://characters.local/" + character.fileName},
         {"layout", character.layout},
         {"builtIn", false}});
  }

  return {{"reminders", std::move(items)},
          {"now", UnixTimeMilliseconds()},
          {"petName", petName_},
          {"soundEnabled", soundEnabled_},
          {"speechEnabled", speechEnabled_},
          {"autoHideEnabled", autoHideEnabled_},
          {"autoHideMinutes", autoHideMinutes_},
          {"characters", std::move(characters)},
          {"activeCharacterId", activeCharacterId_}};
}

void Application::LoadCharacters() {
  characters_.clear();
  const auto serialized = reminders_.GetSetting("characters.list");
  if (serialized.has_value() && !serialized->empty()) {
    const nlohmann::json saved = nlohmann::json::parse(*serialized);
    if (saved.is_array()) {
      for (const nlohmann::json& item : saved) {
        if (!item.is_object()) {
          continue;
        }
        const CharacterProfile character{
            item.value("id", ""),
            item.value("name", ""),
            item.value("fileName", ""),
            item.value("layout", "single")};
        if (!IsSafeCharacterId(character.id) ||
            !IsValidCharacterName(character.name) ||
            (character.layout != "single" && character.layout != "sheet") ||
            character.fileName.empty()) {
          continue;
        }
        // Reject absolute paths and traversal before mapping a saved filename
        // into the character directory.
        const std::filesystem::path relativeName =
            Utf8ToWide(character.fileName);
        if (relativeName.filename() != relativeName ||
            !std::filesystem::exists(
                std::filesystem::path(characterDirectory_) / relativeName)) {
          continue;
        }
        characters_.push_back(character);
        if (characters_.size() >= 12) {
          break;
        }
      }
    }
  }

  if (const auto active = reminders_.GetSetting("characters.active");
      active.has_value() && HasCharacter(*active)) {
    activeCharacterId_ = *active;
  } else {
    activeCharacterId_ = "builtin";
  }
}

void Application::SaveCharacters() {
  nlohmann::json saved = nlohmann::json::array();
  for (const CharacterProfile& character : characters_) {
    saved.push_back({{"id", character.id},
                     {"name", character.name},
                     {"fileName", character.fileName},
                     {"layout", character.layout}});
  }
  reminders_.SetSetting("characters.list", saved.dump());
  reminders_.SetSetting("characters.active", activeCharacterId_);
}

bool Application::HasCharacter(const std::string& id) const {
  if (id == "builtin") {
    return true;
  }
  return std::any_of(
      characters_.begin(), characters_.end(),
      [&id](const CharacterProfile& character) { return character.id == id; });
}

void Application::SendError(WebViewWindow& target,
                            const std::string& message) {
  target.PostJson(
      nlohmann::json{{"type", "app.error"},
                     {"payload", {{"message", message}}}}
          .dump());
}

}  // namespace milo
