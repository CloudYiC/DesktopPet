#include "Milo/Application.h"

#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <strsafe.h>

#include <algorithm>
#include <cctype>
#include <cstring>
#include <iterator>
#include <stdexcept>
#include <utility>

#include "Milo/CharacterImage.h"
#include "Milo/DatabaseService.h"
#include "Milo/ImageService.h"
#include "Milo/SystemService.h"
#include "Milo/ToolService.h"
#include "Milo/Utils.h"
#include "cloudyi/file_dialog.h"
#include "cloudyi/icon_file.h"
#include "resource.h"

namespace milo {
namespace {

constexpr UINT kTrayIconId = 1;
constexpr UINT kTrayMessage = WM_APP + 42;
constexpr UINT kOpenDashboardCommand = 1001;
constexpr UINT kHidePetCommand = 1002;
constexpr UINT kQuitCommand = 1003;
constexpr int kAutoHideMinuteOptions[] = {1, 2, 5, 10, 20, 30, 60};
constexpr wchar_t kPackagedGirlRelativePath[] =
    L"assets\\private-default-girl.png";

bool FilesHaveSameContent(const std::wstring& leftPath,
                          const std::wstring& rightPath) {
  HANDLE left = CreateFileW(leftPath.c_str(), GENERIC_READ, FILE_SHARE_READ,
                            nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL,
                            nullptr);
  if (left == INVALID_HANDLE_VALUE) return false;
  HANDLE right = CreateFileW(rightPath.c_str(), GENERIC_READ, FILE_SHARE_READ,
                             nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL,
                             nullptr);
  if (right == INVALID_HANDLE_VALUE) {
    CloseHandle(left);
    return false;
  }

  LARGE_INTEGER leftSize{};
  LARGE_INTEGER rightSize{};
  bool equal = GetFileSizeEx(left, &leftSize) &&
               GetFileSizeEx(right, &rightSize) &&
               leftSize.QuadPart == rightSize.QuadPart;
  std::vector<unsigned char> leftBuffer(64 * 1024);
  std::vector<unsigned char> rightBuffer(leftBuffer.size());
  while (equal) {
    DWORD leftRead = 0;
    DWORD rightRead = 0;
    if (!ReadFile(left, leftBuffer.data(),
                  static_cast<DWORD>(leftBuffer.size()), &leftRead, nullptr) ||
        !ReadFile(right, rightBuffer.data(),
                  static_cast<DWORD>(rightBuffer.size()), &rightRead,
                  nullptr) ||
        leftRead != rightRead ||
        std::memcmp(leftBuffer.data(), rightBuffer.data(), leftRead) != 0) {
      equal = false;
      break;
    }
    if (leftRead == 0) break;
  }
  CloseHandle(right);
  CloseHandle(left);
  return equal;
}

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

nlohmann::json SystemSnapshotToJson(const SystemSnapshot& snapshot) {
  return {{"operatingSystem", snapshot.operatingSystem},
          {"osEdition", snapshot.osEdition},
          {"osDisplayVersion", snapshot.osDisplayVersion},
          {"osBuild", snapshot.osBuild},
          {"architecture", snapshot.architecture},
          {"computerName", snapshot.computerName},
          {"userName", snapshot.userName},
          {"processorName", snapshot.processorName},
          {"physicalCores", snapshot.physicalCores},
          {"logicalProcessors", snapshot.logicalProcessors},
          {"processorPackages", snapshot.processorPackages},
          {"processorMaxMegahertz", snapshot.processorMaxMegahertz},
          {"virtualizationEnabled", snapshot.virtualizationEnabled},
          {"totalMemoryBytes", snapshot.totalMemoryBytes},
          {"availableMemoryBytes", snapshot.availableMemoryBytes},
          {"memoryLoadPercent", snapshot.memoryLoadPercent},
          {"totalPageFileBytes", snapshot.totalPageFileBytes},
          {"availablePageFileBytes", snapshot.availablePageFileBytes},
          {"systemDrive", snapshot.systemDrive},
          {"systemDiskTotalBytes", snapshot.systemDiskTotalBytes},
          {"systemDiskFreeBytes", snapshot.systemDiskFreeBytes},
          {"manufacturer", snapshot.manufacturer},
          {"model", snapshot.model},
          {"biosVersion", snapshot.biosVersion},
          {"biosDate", snapshot.biosDate},
          {"primaryGraphics", snapshot.primaryGraphics},
          {"primaryDisplayWidth", snapshot.primaryDisplayWidth},
          {"primaryDisplayHeight", snapshot.primaryDisplayHeight},
          {"primaryDisplayDpi", snapshot.primaryDisplayDpi},
          {"timeZone", snapshot.timeZone},
          {"localeName", snapshot.localeName},
          {"activeNetworkAdapters", snapshot.activeNetworkAdapters},
          {"primaryNetworkAdapter", snapshot.primaryNetworkAdapter},
          {"primaryIpv4", snapshot.primaryIpv4},
          {"batteryPercent", snapshot.batteryPercent},
          {"acLineStatus", snapshot.acLineStatus},
          {"uptimeMilliseconds", snapshot.uptimeMilliseconds},
          {"installUnixSeconds", snapshot.installUnixSeconds}};
}

nlohmann::json PortEntryToJson(const PortEntry& entry) {
  return {{"protocol", entry.protocol},
          {"localAddress", entry.localAddress},
          {"localPort", entry.localPort},
          {"remoteAddress", entry.remoteAddress},
          {"remotePort", entry.remotePort},
          {"state", entry.state},
          {"processId", entry.processId},
          {"processName", entry.processName}};
}

nlohmann::json InstalledSoftwareToJson(const InstalledSoftware& entry) {
  return {{"id", entry.id},
          {"displayName", entry.displayName},
          {"displayVersion", entry.displayVersion},
          {"publisher", entry.publisher},
          {"installLocation", entry.installLocation},
          {"registryPath", entry.registryPath},
          {"estimatedSizeBytes", entry.estimatedSizeBytes},
          {"installLocationInferred", entry.installLocationInferred},
          {"currentUser", entry.currentUser},
          {"noRemove", entry.noRemove},
          {"windowsInstaller", entry.windowsInstaller}};
}

nlohmann::json SoftwareResidualToJson(const SoftwareResidual& residual) {
  return {{"path", residual.path},
          {"label", residual.label},
          {"kind", residual.kind},
          {"evidence", residual.evidence},
          {"confidence", residual.confidence},
          {"sizeBytes", residual.sizeBytes},
          {"itemCount", residual.itemCount},
          {"sizeTruncated", residual.sizeTruncated},
          {"defaultSelected", residual.defaultSelected},
          {"personalData", residual.personalData}};
}

nlohmann::json SoftwareCleanupPlanToJson(
    const SoftwareCleanupPlan& plan) {
  nlohmann::json residuals = nlohmann::json::array();
  for (std::vector<SoftwareResidual>::const_iterator residual =
           plan.residuals.begin();
       residual != plan.residuals.end(); ++residual) {
    residuals.push_back(SoftwareResidualToJson(*residual));
  }
  return {{"token", plan.token},
          {"softwareId", plan.softwareId},
          {"displayName", plan.displayName},
          {"residuals", residuals}};
}

nlohmann::json SoftwareOperationToJson(
    const SoftwareOperationResult& result) {
  return {{"succeeded", result.succeeded},
          {"message", result.message},
          {"removedPaths", result.removedPaths},
          {"failedPaths", result.failedPaths}};
}

nlohmann::json DatabaseColumnToJson(const DatabaseColumn& column) {
  return {{"name", column.name},
          {"type", column.type},
          {"defaultValue", column.defaultValue},
          {"notNull", column.notNull},
          {"primaryKey", column.primaryKey}};
}

nlohmann::json DatabaseObjectToJson(const DatabaseObject& object) {
  nlohmann::json columns = nlohmann::json::array();
  for (std::vector<DatabaseColumn>::const_iterator column =
           object.columns.begin();
       column != object.columns.end(); ++column) {
    columns.push_back(DatabaseColumnToJson(*column));
  }
  return {{"type", object.type},
          {"name", object.name},
          {"tableName", object.tableName},
          {"sql", object.sql},
          {"columns", columns}};
}

nlohmann::json DatabaseOverviewToJson(const DatabaseOverview& overview) {
  nlohmann::json objects = nlohmann::json::array();
  for (std::vector<DatabaseObject>::const_iterator object =
           overview.objects.begin();
       object != overview.objects.end(); ++object) {
    objects.push_back(DatabaseObjectToJson(*object));
  }
  return {{"path", overview.path},
          {"fileName", overview.fileName},
          {"fileSizeBytes", overview.fileSizeBytes},
          {"pageSize", overview.pageSize},
          {"pageCount", overview.pageCount},
          {"userVersion", overview.userVersion},
          {"journalMode", overview.journalMode},
          {"objects", objects}};
}

nlohmann::json DatabaseQueryResultToJson(
    const DatabaseQueryResult& result) {
  return {{"columns", result.columns},
          {"rows", result.rows},
          {"affectedRows", result.affectedRows},
          {"lastInsertId", result.lastInsertId},
          {"elapsedMilliseconds", result.elapsedMilliseconds},
          {"statementCount", result.statementCount},
          {"truncated", result.truncated},
          {"wroteData", result.wroteData},
          {"message", result.message}};
}

bool IsValidLabel(const std::string& name, std::size_t maximumCharacters) {
  if (name.empty() || maximumCharacters == 0 ||
      name.size() > maximumCharacters * 4) {
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

bool IsValidWorkspaceTheme(const std::string& value) {
  return value == "warm" || value == "cloud" || value == "rose";
}

bool IsValidWorkspaceTextSize(const std::string& value) {
  return value == "compact" || value == "comfortable" || value == "large";
}

bool IsValidDashboardView(const std::string& value) {
  static const char* views[] = {
      "toolbox", "today", "all", "status", "settings", "marketplace",
      "account"};
  return std::find(std::begin(views), std::end(views), value) !=
         std::end(views);
}

bool IsValidToolCategory(const std::string& value) {
  if (value.empty()) return true;
  static const char* categories[] = {
      "data", "network", "system", "file-conversion"};
  return std::find(std::begin(categories), std::end(categories), value) !=
         std::end(categories);
}

bool IsSafeCharacterId(const std::string& value) {
  // Character ids are later embedded in filenames, so allow a strict subset.
  return !value.empty() && value.size() <= 64 &&
         std::all_of(value.begin(), value.end(), [](const unsigned char value) {
           return std::isalnum(value) || value == '-' || value == '_';
         });
}

void UpdateDesktopShortcutIcon(const std::wstring& iconPath) {
  PWSTR rawDesktop = nullptr;
  if (FAILED(SHGetKnownFolderPath(FOLDERID_Desktop, KF_FLAG_DEFAULT, nullptr,
                                  &rawDesktop)) ||
      rawDesktop == nullptr) {
    return;
  }
  const std::wstring desktop(rawDesktop);
  CoTaskMemFree(rawDesktop);

  const std::wstring legacyPetShortcut =
      JoinPath(desktop, L"可爱依依桌面宠物.lnk");
  const std::wstring legacyAssistantShortcut =
      JoinPath(desktop, L"可爱依依小助手.lnk");
  const std::wstring workbenchShortcut =
      JoinPath(desktop, L"依依工作台.lnk");
  if (!PathExists(workbenchShortcut) && PathExists(legacyAssistantShortcut)) {
    MoveFileExW(legacyAssistantShortcut.c_str(), workbenchShortcut.c_str(),
                MOVEFILE_COPY_ALLOWED | MOVEFILE_WRITE_THROUGH);
  }
  if (!PathExists(workbenchShortcut) && PathExists(legacyPetShortcut)) {
    MoveFileExW(legacyPetShortcut.c_str(), workbenchShortcut.c_str(),
                MOVEFILE_COPY_ALLOWED | MOVEFILE_WRITE_THROUGH);
  }
  const std::wstring shortcut =
      PathExists(workbenchShortcut)
          ? workbenchShortcut
          : (PathExists(legacyAssistantShortcut)
                 ? legacyAssistantShortcut
                 : (PathExists(legacyPetShortcut) ? legacyPetShortcut
                                                  : std::wstring{}));
  if (shortcut.empty()) return;

  Microsoft::WRL::ComPtr<IShellLinkW> shellLink;
  if (FAILED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER,
                              IID_PPV_ARGS(&shellLink)))) {
    return;
  }
  Microsoft::WRL::ComPtr<IPersistFile> persisted;
  if (FAILED(shellLink.As(&persisted)) ||
      FAILED(persisted->Load(shortcut.c_str(), STGM_READWRITE)) ||
      FAILED(shellLink->SetIconLocation(iconPath.c_str(), 0)) ||
      FAILED(persisted->Save(shortcut.c_str(), TRUE))) {
    return;
  }
  SHChangeNotify(SHCNE_UPDATEITEM, SHCNF_PATHW | SHCNF_FLUSHNOWAIT,
                 shortcut.c_str(), nullptr);
}

}  // namespace

Application::Application(HINSTANCE instance) : instance_(instance) {
  const std::wstring executableDirectory = ExecutableDirectory();
  uiDirectory_ = JoinPath(executableDirectory, L"ui");

  const std::wstring appData = AppDataDirectory();
  webViewDataDirectory_ = JoinPath(appData, L"WebView2");
  characterDirectory_ = JoinPath(appData, L"Characters");
  onboardingMarker_ = JoinPath(appData, L"onboarding.complete");
  showDashboardOnStart_ = !PathExists(onboardingMarker_);
  EnsureDirectory(webViewDataDirectory_);
  EnsureDirectory(characterDirectory_);
  reminders_.Open(JoinPath(appData, L"yiyi.db"));
  // User preferences are recoverable. A malformed legacy setting must not keep
  // the application from starting with safe defaults.
  try {
    std::string setting;
    if (reminders_.GetSetting("pet.name", setting) &&
        IsValidPetName(setting)) {
      petName_ = setting;
    }
    if (reminders_.GetSetting("audio.sound", setting)) {
      soundEnabled_ = setting != "0";
    }
    if (reminders_.GetSetting("audio.speech", setting)) {
      speechEnabled_ = setting == "1";
    }
    if (reminders_.GetSetting("pet.autoHide", setting)) {
      autoHideEnabled_ = setting != "0";
    }
    if (reminders_.GetSetting("pet.autoHideMinutes", setting)) {
      const int savedMinutes = std::stoi(setting);
      if (IsValidAutoHideMinutes(savedMinutes)) {
        autoHideMinutes_ = savedMinutes;
      }
    }
    if (reminders_.GetSetting("workspace.theme", setting) &&
        IsValidWorkspaceTheme(setting)) {
      workspaceTheme_ = setting;
    }
    if (reminders_.GetSetting("workspace.textSize", setting) &&
        IsValidWorkspaceTextSize(setting)) {
      workspaceTextSize_ = setting;
    }
    if (reminders_.GetSetting("workspace.openLastView", setting)) {
      openLastView_ = setting != "0";
    }
    if (reminders_.GetSetting("workspace.lastView", setting) &&
        IsValidDashboardView(setting)) {
      lastDashboardView_ = setting;
    }
    if (reminders_.GetSetting("workspace.lastCategory", setting) &&
        IsValidToolCategory(setting)) {
      lastToolCategory_ = setting;
    }
    std::string x;
    std::string y;
    if (reminders_.GetSetting("pet.x", x) &&
        reminders_.GetSetting("pet.y", y)) {
      petPosition_.x = std::stoi(x);
      petPosition_.y = std::stoi(y);
      hasPetPosition_ = true;
    }
    LoadCharacters();
  } catch (const std::exception&) {
    hasPetPosition_ = false;
    characters_.clear();
    activeCharacterId_ = DefaultCharacterId();
  }
}

Application::~Application() {
  RemoveTrayIcon();
  dashboardWindow_.reset();
  petWindow_.reset();
  if (activeSmallIcon_ != nullptr && activeSmallIcon_ != activeLargeIcon_) {
    DestroyIcon(activeSmallIcon_);
  }
  if (activeLargeIcon_ != nullptr) DestroyIcon(activeLargeIcon_);
}

int Application::Run(int) {
  if (!PathExists(JoinPath(uiDirectory_, L"index.html"))) {
    throw std::runtime_error(
        "React UI was not found. Run scripts/build.ps1 to build the app.");
  }

  petWindow_.reset(new WebViewWindow(*this, WindowKind::Pet));

  if (!petWindow_->Create(instance_)) {
    throw std::runtime_error("Unable to create the application windows.");
  }

  AddTrayIcon();
  petWindow_->Show();
  if (showDashboardOnStart_) {
    ShowDashboard();
    const std::string marker = "CuteYiyiDesktopPet 0.11.5";
    WriteBinaryFile(onboardingMarker_, marker.data(), marker.size());
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
    if (type == "window.drag.start") {
      source.BeginDrag();
      return;
    }
    if (type == "window.drag.move") {
      source.UpdateDrag();
      return;
    }
    if (type == "window.drag.end") {
      source.EndDrag();
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
        SendError(source, "衣柜款式名称需要是 1 到 20 个左右的可见字符。");
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
      const std::wstring imagePath =
          JoinPath(characterDirectory_, Utf8ToWide(fileName));
      const std::wstring temporaryPath = imagePath + L".uploading";

      // Write-then-rename prevents half-written character files from appearing
      // in the virtual host if the process is interrupted.
      WriteBinaryFile(temporaryPath, image.bytes.data(), image.bytes.size());
      try {
        MoveFileReplacing(temporaryPath, imagePath);
      } catch (...) {
        DeleteFileW(temporaryPath.c_str());
        throw;
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
        DeleteFileW(imagePath.c_str());
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
    if (type == "character.icon.update") {
      const std::string id = payload.value("id", "");
      if (id != activeCharacterId_ || !IsSafeCharacterId(id)) {
        // An asynchronous render for the previously selected character may
        // arrive after a quick wardrobe switch; silently ignore stale icons.
        return;
      }
      const DecodedCharacterImage icon =
          DecodeCharacterImage(payload.value("dataUrl", ""));
      if (icon.extension != ".png") {
        SendError(source, "小助手图标必须使用 PNG 格式。");
        return;
      }
      const std::wstring iconPath = JoinPath(
          characterDirectory_, L"assistant-icon-" + Utf8ToWide(id) + L".ico");
      const std::wstring temporaryPath = iconPath + L".updating";
      if (!cy_write_png_icon(temporaryPath.c_str(), icon.bytes.data(),
                             icon.bytes.size())) {
        throw std::runtime_error("无法生成当前角色的小助手图标。");
      }
      try {
        MoveFileReplacing(temporaryPath, iconPath);
      } catch (...) {
        DeleteFileW(temporaryPath.c_str());
        throw;
      }
      ApplyCharacterIcon(iconPath);
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
        activeCharacterId_ = DefaultCharacterId();
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
      const std::wstring removedPath =
          JoinPath(characterDirectory_, Utf8ToWide(removed.fileName));
      DeleteFileW(removedPath.c_str());
      SendState();
      return;
    }
    if (type == "tool.execute") {
      const std::string requestId = payload.value("requestId", "");
      const std::string toolId = payload.value("toolId", "");
      const std::string operation = payload.value("operation", "");
      const std::string input = payload.value("input", "");
      if (requestId.empty() || requestId.size() > 80 || toolId.empty() ||
          operation.empty()) {
        source.PostJson(
            nlohmann::json{{"type", "tool.error"},
                           {"payload",
                            {{"requestId", requestId},
                             {"message", "工具请求缺少必要参数。"}}}}
                .dump());
        return;
      }

      // Only the allow-listed C core is reachable through this command. File,
      // process and network capabilities will use separate permission gates.
      const ToolExecutionResult result = ExecuteTool(
          toolId, operation, input, payload.value("urlSafe", false),
          payload.value("padded", true));
      const nlohmann::json responsePayload = result.succeeded
          ? nlohmann::json{{"requestId", requestId},
                           {"toolId", toolId},
                           {"output", result.output}}
          : nlohmann::json{{"requestId", requestId},
                           {"toolId", toolId},
                           {"message", result.error}};
      source.PostJson(
          nlohmann::json{{"type",
                          result.succeeded ? "tool.result" : "tool.error"},
                         {"payload", responsePayload}}
              .dump());
      return;
    }
    if (type == "system.snapshot") {
      const std::string requestId = payload.value("requestId", "");
      if (requestId.empty() || requestId.size() > 80) {
        SendError(source, "系统信息请求缺少有效标识。");
        return;
      }
      try {
        source.PostJson(
            nlohmann::json{{"type", "system.snapshot.result"},
                           {"payload",
                            {{"requestId", requestId},
                             {"snapshot", SystemSnapshotToJson(
                                              QuerySystemSnapshot())}}}}
                .dump());
      } catch (const std::exception& error) {
        source.PostJson(
            nlohmann::json{{"type", "system.snapshot.error"},
                           {"payload",
                            {{"requestId", requestId},
                             {"message", error.what()}}}}
                .dump());
      }
      return;
    }
    if (type == "ports.list") {
      const std::string requestId = payload.value("requestId", "");
      if (requestId.empty() || requestId.size() > 80) {
        SendError(source, "端口请求缺少有效标识。");
        return;
      }
      const std::vector<PortEntry> entries = ListPortEntries();
      nlohmann::json rows = nlohmann::json::array();
      for (std::vector<PortEntry>::const_iterator entry = entries.begin();
           entry != entries.end(); ++entry) {
        rows.push_back(PortEntryToJson(*entry));
      }
      source.PostJson(
          nlohmann::json{{"type", "ports.list.result"},
                         {"payload",
                          {{"requestId", requestId}, {"entries", rows}}}}
              .dump());
      return;
    }
    if (type == "ports.terminate") {
      const std::string requestId = payload.value("requestId", "");
      const std::uint32_t processId = payload.value("processId", 0U);
      const std::string processName = payload.value("processName", "");
      const bool confirmed = payload.value("confirmed", false);
      if (requestId.empty() || requestId.size() > 80 || !confirmed) {
        source.PostJson(
            nlohmann::json{{"type", "ports.terminate.error"},
                           {"payload",
                            {{"requestId", requestId},
                             {"message", "结束进程前必须明确确认。"}}}}
                .dump());
        return;
      }
      const ProcessOperationResult result =
          TerminatePortOwner(processId, processName);
      source.PostJson(
          nlohmann::json{{"type", result.succeeded
                                     ? "ports.terminate.result"
                                     : "ports.terminate.error"},
                         {"payload",
                          {{"requestId", requestId},
                           {"message", result.message}}}}
              .dump());
      return;
    }
    if (type == "software.list") {
      const std::string requestId = payload.value("requestId", "");
      if (requestId.empty() || requestId.size() > 80) {
        SendError(source, "软件列表请求缺少有效标识。");
        return;
      }
      try {
        const std::vector<InstalledSoftware> entries =
            softwareService_.ListInstalled();
        nlohmann::json rows = nlohmann::json::array();
        for (std::vector<InstalledSoftware>::const_iterator entry =
                 entries.begin();
             entry != entries.end(); ++entry) {
          rows.push_back(InstalledSoftwareToJson(*entry));
        }
        source.PostJson(
            nlohmann::json{{"type", "software.list.result"},
                           {"payload",
                            {{"requestId", requestId}, {"entries", rows}}}}
                .dump());
      } catch (const std::exception& error) {
        source.PostJson(
            nlohmann::json{{"type", "software.list.error"},
                           {"payload",
                            {{"requestId", requestId},
                             {"message", error.what()}}}}
                .dump());
      }
      return;
    }
    if (type == "software.scan") {
      const std::string requestId = payload.value("requestId", "");
      const std::string softwareId = payload.value("softwareId", "");
      const std::string displayName = payload.value("displayName", "");
      if (requestId.empty() || requestId.size() > 80 || softwareId.empty() ||
          softwareId.size() > 2048 || !IsValidLabel(displayName, 160)) {
        SendError(source, "软件残留扫描请求无效。");
        return;
      }
      try {
        const SoftwareCleanupPlan plan =
            softwareService_.ScanResiduals(softwareId, displayName);
        source.PostJson(
            nlohmann::json{{"type", "software.scan.result"},
                           {"payload",
                            {{"requestId", requestId},
                             {"plan", SoftwareCleanupPlanToJson(plan)}}}}
                .dump());
      } catch (const std::exception& error) {
        source.PostJson(
            nlohmann::json{{"type", "software.scan.error"},
                           {"payload",
                            {{"requestId", requestId},
                             {"message", error.what()}}}}
                .dump());
      }
      return;
    }
    if (type == "software.uninstall") {
      const std::string requestId = payload.value("requestId", "");
      const std::string softwareId = payload.value("softwareId", "");
      const std::string displayName = payload.value("displayName", "");
      const bool confirmed = payload.value("confirmed", false);
      if (requestId.empty() || requestId.size() > 80 || softwareId.empty() ||
          softwareId.size() > 2048 || !IsValidLabel(displayName, 160)) {
        SendError(source, "软件卸载请求无效。");
        return;
      }
      try {
        const SoftwareOperationResult result =
            softwareService_.LaunchRegisteredUninstaller(
                softwareId, displayName, confirmed);
        source.PostJson(
            nlohmann::json{{"type", result.succeeded
                                       ? "software.uninstall.result"
                                       : "software.uninstall.error"},
                           {"payload",
                            {{"requestId", requestId},
                             {"message", result.message},
                             {"operation", SoftwareOperationToJson(result)}}}}
                .dump());
      } catch (const std::exception& error) {
        source.PostJson(
            nlohmann::json{{"type", "software.uninstall.error"},
                           {"payload",
                            {{"requestId", requestId},
                             {"message", error.what()}}}}
                .dump());
      }
      return;
    }
    if (type == "software.cleanup") {
      const std::string requestId = payload.value("requestId", "");
      const std::string planToken = payload.value("planToken", "");
      const std::string typedName = payload.value("typedName", "");
      const bool confirmed = payload.value("confirmed", false);
      std::vector<std::string> selectedPaths;
      if (payload.contains("selectedPaths") &&
          payload.at("selectedPaths").is_array()) {
        const nlohmann::json& paths = payload.at("selectedPaths");
        if (paths.size() <= 32) {
          for (nlohmann::json::const_iterator path = paths.begin();
               path != paths.end(); ++path) {
            if (path->is_string() && path->get<std::string>().size() <= 32768)
              selectedPaths.push_back(path->get<std::string>());
          }
        }
      }
      if (requestId.empty() || requestId.size() > 80 ||
          planToken.size() != 32 || !IsValidLabel(typedName, 160) ||
          selectedPaths.empty()) {
        SendError(source, "软件残留清理请求无效。");
        return;
      }
      try {
        const SoftwareOperationResult result =
            softwareService_.CleanupResiduals(planToken, typedName,
                                               selectedPaths, confirmed);
        source.PostJson(
            nlohmann::json{{"type", (result.succeeded ||
                                      !result.removedPaths.empty())
                                       ? "software.cleanup.result"
                                       : "software.cleanup.error"},
                           {"payload",
                            {{"requestId", requestId},
                             {"message", result.message},
                             {"operation", SoftwareOperationToJson(result)}}}}
                .dump());
      } catch (const std::exception& error) {
        source.PostJson(
            nlohmann::json{{"type", "software.cleanup.error"},
                           {"payload",
                            {{"requestId", requestId},
                             {"message", error.what()}}}}
                .dump());
      }
      return;
    }
    if (type == "image.save") {
      const std::string requestId = payload.value("requestId", "");
      if (requestId.empty() || requestId.size() > 96) {
        SendError(source, "图片保存请求无效。");
        return;
      }
      try {
        const ImageSaveResult result = SaveExportedImage(
            source.Handle(), payload.value("dataUrl", ""),
            payload.value("format", ""),
            payload.value("suggestedBaseName", "converted-image"));
        source.PostJson(
            nlohmann::json{{"type", "image.save.result"},
                           {"payload",
                            {{"requestId", requestId},
                             {"cancelled", result.cancelled},
                             {"path", result.path},
                             {"sizeBytes", result.sizeBytes}}}}
                .dump());
      } catch (const std::exception& error) {
        source.PostJson(
            nlohmann::json{{"type", "image.save.error"},
                           {"payload",
                            {{"requestId", requestId},
                             {"message", error.what()}}}}
                .dump());
      }
      return;
    }

    if (type == "database.pick") {
      const std::string requestId = payload.value("requestId", "");
      if (requestId.empty() || requestId.size() > 80) {
        SendError(source, "数据库请求缺少有效标识。");
        return;
      }
      wchar_t selectedPath[32768]{};
      const bool createNew = payload.value("createNew", false);
      const int selected = cy_pick_sqlite_database(
          source.Handle(), createNew ? 1 : 0, selectedPath,
          sizeof(selectedPath) / sizeof(selectedPath[0]));
      if (selected == 0) {
        source.PostJson(
            nlohmann::json{{"type", "database.pick.result"},
                           {"payload",
                            {{"requestId", requestId}, {"cancelled", true}}}}
                .dump());
        return;
      }
      if (selected < 0) {
        source.PostJson(
            nlohmann::json{{"type", "database.pick.error"},
                           {"payload",
                            {{"requestId", requestId},
                             {"message", "无法打开 Windows 文件选择器。"}}}}
                .dump());
        return;
      }
      try {
        const std::wstring path(selectedPath);
        const DatabaseOverview overview =
            createNew ? CreateDatabase(path) : InspectDatabase(path);
        activeDatabasePath_ = path;
        source.PostJson(
            nlohmann::json{{"type", "database.pick.result"},
                           {"payload",
                            {{"requestId", requestId},
                             {"cancelled", false},
                             {"overview", DatabaseOverviewToJson(overview)}}}}
                .dump());
      } catch (const std::exception& error) {
        source.PostJson(
            nlohmann::json{{"type", "database.pick.error"},
                           {"payload",
                            {{"requestId", requestId},
                             {"message", error.what()}}}}
                .dump());
      }
      return;
    }
    if (type == "database.refresh") {
      const std::string requestId = payload.value("requestId", "");
      try {
        if (requestId.empty() || requestId.size() > 80 ||
            activeDatabasePath_.empty()) {
          throw std::runtime_error("请先打开一个 SQLite 数据库。");
        }
        source.PostJson(
            nlohmann::json{{"type", "database.refresh.result"},
                           {"payload",
                            {{"requestId", requestId},
                             {"overview", DatabaseOverviewToJson(
                                              InspectDatabase(
                                                  activeDatabasePath_))}}}}
                .dump());
      } catch (const std::exception& error) {
        source.PostJson(
            nlohmann::json{{"type", "database.refresh.error"},
                           {"payload",
                            {{"requestId", requestId},
                             {"message", error.what()}}}}
                .dump());
      }
      return;
    }
    if (type == "database.execute") {
      const std::string requestId = payload.value("requestId", "");
      try {
        if (requestId.empty() || requestId.size() > 80 ||
            activeDatabasePath_.empty()) {
          throw std::runtime_error("请先打开一个 SQLite 数据库。");
        }
        const DatabaseQueryResult result = ExecuteDatabaseSql(
            activeDatabasePath_, payload.value("sql", ""),
            payload.value("allowWrite", false));
        nlohmann::json response =
            {{"requestId", requestId},
             {"result", DatabaseQueryResultToJson(result)}};
        if (result.wroteData) {
          response["overview"] = DatabaseOverviewToJson(
              InspectDatabase(activeDatabasePath_));
        }
        source.PostJson(
            nlohmann::json{{"type", "database.execute.result"},
                           {"payload", response}}
                .dump());
      } catch (const std::exception& error) {
        source.PostJson(
            nlohmann::json{{"type", "database.execute.error"},
                           {"payload",
                            {{"requestId", requestId},
                             {"message", error.what()}}}}
                .dump());
      }
      return;
    }
    if (type == "database.close") {
      const std::string requestId = payload.value("requestId", "");
      activeDatabasePath_.clear();
      source.PostJson(
          nlohmann::json{{"type", "database.close.result"},
                         {"payload", {{"requestId", requestId}}}}
              .dump());
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
      const std::string workspaceTheme =
          payload.value("workspaceTheme", workspaceTheme_);
      const std::string workspaceTextSize =
          payload.value("workspaceTextSize", workspaceTextSize_);
      if (!IsValidWorkspaceTheme(workspaceTheme) ||
          !IsValidWorkspaceTextSize(workspaceTextSize)) {
        SendError(source, "工作台主题或字号设置无效。");
        return;
      }
      petName_ = petName;
      soundEnabled_ = payload.value("soundEnabled", soundEnabled_);
      speechEnabled_ = payload.value("speechEnabled", speechEnabled_);
      autoHideEnabled_ =
          payload.value("autoHideEnabled", autoHideEnabled_);
      autoHideMinutes_ = autoHideMinutes;
      workspaceTheme_ = workspaceTheme;
      workspaceTextSize_ = workspaceTextSize;
      openLastView_ = payload.value("openLastView", openLastView_);
      reminders_.SetSetting("pet.name", petName_);
      reminders_.SetSetting("audio.sound", soundEnabled_ ? "1" : "0");
      reminders_.SetSetting("audio.speech", speechEnabled_ ? "1" : "0");
      reminders_.SetSetting("pet.autoHide", autoHideEnabled_ ? "1" : "0");
      reminders_.SetSetting("pet.autoHideMinutes",
                            std::to_string(autoHideMinutes_));
      reminders_.SetSetting("workspace.theme", workspaceTheme_);
      reminders_.SetSetting("workspace.textSize", workspaceTextSize_);
      reminders_.SetSetting("workspace.openLastView",
                            openLastView_ ? "1" : "0");
      if (!autoHideEnabled_) {
        petWindow_->SetAutoTucked(false);
      }
      UpdateBranding();
      SendState();
      return;
    }
    if (type == "workspace.navigation.update") {
      const std::string view = payload.value("view", "");
      const std::string category = payload.value("category", "");
      if (!IsValidDashboardView(view) || !IsValidToolCategory(category)) {
        SendError(source, "无法保存未知的工作台页面。");
        return;
      }
      lastDashboardView_ = view;
      lastToolCategory_ = category;
      reminders_.SetSetting("workspace.lastView", lastDashboardView_);
      reminders_.SetSetting("workspace.lastCategory", lastToolCategory_);
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
      if (hasPresentedReminder_ && presentedReminderId_ == id) {
        petWindow_->EndReminderPresentation();
        hasPresentedReminder_ = false;
        Broadcast({{"type", "reminder.dismissed"}, {"payload", {{"id", id}}}});
      }
      SendState();
      return;
    }
    if (type == "reminder.delete") {
      const auto id = payload.value("id", std::int64_t{});
      reminders_.Remove(id);
      if (hasPresentedReminder_ && presentedReminderId_ == id) {
        petWindow_->EndReminderPresentation();
        hasPresentedReminder_ = false;
        Broadcast({{"type", "reminder.dismissed"}, {"payload", {{"id", id}}}});
      }
      SendState();
      return;
    }
    if (type == "reminder.snooze") {
      const auto id = payload.value("id", std::int64_t{});
      const int requestedMinutes = payload.value("minutes", 5);
      const int minutes =
          (std::max)(1, (std::min)(requestedMinutes, 24 * 60));
      reminders_.Snooze(id,
                        UnixTimeMilliseconds() + minutes * 60LL * 1000LL);
      if (hasPresentedReminder_ && presentedReminderId_ == id) {
        petWindow_->EndReminderPresentation();
        hasPresentedReminder_ = false;
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
      hasPresentedReminder_ = true;
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
          autoHideEnabled_ && !hasPresentedReminder_ &&
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
  petPosition_.x = bounds.left;
  petPosition_.y = bounds.top;
  hasPetPosition_ = true;
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
  const std::wstring tooltip = L"依依工作台";
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
  AppendMenuW(menu, MF_STRING, kOpenDashboardCommand, L"打开依依工作台");
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
    dashboardWindow_->SetTitle(L"依依工作台");
  }
  if (trayIconAdded_) {
    trayIcon_.uFlags = NIF_TIP;
    const std::wstring tooltip = L"依依工作台";
    StringCchCopyW(trayIcon_.szTip, ARRAYSIZE(trayIcon_.szTip),
                   tooltip.c_str());
    Shell_NotifyIconW(NIM_MODIFY, &trayIcon_);
  }
}

void Application::ApplyCharacterIcon(const std::wstring& iconPath) {
  HICON largeIcon = static_cast<HICON>(LoadImageW(
      nullptr, iconPath.c_str(), IMAGE_ICON, GetSystemMetrics(SM_CXICON),
      GetSystemMetrics(SM_CYICON), LR_LOADFROMFILE | LR_DEFAULTCOLOR));
  HICON smallIcon = static_cast<HICON>(LoadImageW(
      nullptr, iconPath.c_str(), IMAGE_ICON, GetSystemMetrics(SM_CXSMICON),
      GetSystemMetrics(SM_CYSMICON), LR_LOADFROMFILE | LR_DEFAULTCOLOR));
  if (largeIcon == nullptr || smallIcon == nullptr) {
    if (largeIcon != nullptr) DestroyIcon(largeIcon);
    if (smallIcon != nullptr) DestroyIcon(smallIcon);
    return;
  }

  const HICON previousLarge = activeLargeIcon_;
  const HICON previousSmall = activeSmallIcon_;
  activeLargeIcon_ = largeIcon;
  activeSmallIcon_ = smallIcon;
  activeCharacterIconPath_ = iconPath;
  if (petWindow_ != nullptr) petWindow_->SetIcons(largeIcon, smallIcon);
  if (dashboardWindow_ != nullptr) dashboardWindow_->SetIcons(largeIcon, smallIcon);
  if (trayIconAdded_) {
    trayIcon_.uFlags = NIF_ICON;
    trayIcon_.hIcon = smallIcon;
    Shell_NotifyIconW(NIM_MODIFY, &trayIcon_);
  }
  UpdateDesktopShortcutIcon(iconPath);

  if (previousSmall != nullptr && previousSmall != previousLarge) {
    DestroyIcon(previousSmall);
  }
  if (previousLarge != nullptr) DestroyIcon(previousLarge);
}

void Application::EnsureDashboard() {
  if (dashboardWindow_ != nullptr) {
    return;
  }
  dashboardWindow_.reset(
      new WebViewWindow(*this, WindowKind::Dashboard));
  if (!dashboardWindow_->Create(instance_)) {
    dashboardWindow_.reset();
    throw std::runtime_error("Unable to create the dashboard window.");
  }
  if (activeLargeIcon_ != nullptr || activeSmallIcon_ != nullptr) {
    dashboardWindow_->SetIcons(activeLargeIcon_, activeSmallIcon_);
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
  nlohmann::json characters = nlohmann::json::array();
  if (HasPackagedGirl()) {
    characters.push_back(
        {{"id", "builtin-girl"},
         {"name", "粉色依依"},
         {"imageUrl",
          "https://milo.local/assets/private-default-girl.png"},
         {"layout", "single"},
         {"builtIn", true}});
  }
  characters.push_back(
      {{"id", "builtin"},
       {"name", "经典小鼠"},
       {"imageUrl", "https://milo.local/assets/milo-sprite.png"},
       {"layout", "sheet"},
       {"builtIn", true}});
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
          {"workspaceTheme", workspaceTheme_},
          {"workspaceTextSize", workspaceTextSize_},
          {"openLastView", openLastView_},
          {"lastDashboardView", lastDashboardView_},
          {"lastToolCategory", lastToolCategory_},
          {"characters", std::move(characters)},
          {"activeCharacterId", activeCharacterId_}};
}

void Application::LoadCharacters() {
  characters_.clear();
  std::vector<std::wstring> redundantCharacterFiles;
  const std::wstring packagedGirlPath =
      JoinPath(uiDirectory_, kPackagedGirlRelativePath);
  std::string serialized;
  if (reminders_.GetSetting("characters.list", serialized) &&
      !serialized.empty()) {
    const nlohmann::json saved = nlohmann::json::parse(serialized);
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
        const std::wstring relativeName = Utf8ToWide(character.fileName);
        const std::wstring characterPath =
            JoinPath(characterDirectory_, relativeName);
        if (!IsSimpleFileName(relativeName) || !PathExists(characterPath)) {
          continue;
        }
        if (HasPackagedGirl() &&
            FilesHaveSameContent(characterPath, packagedGirlPath)) {
          redundantCharacterFiles.push_back(characterPath);
          redundantCharacterFiles.push_back(JoinPath(
              characterDirectory_,
              L"assistant-icon-" + Utf8ToWide(character.id) + L".ico"));
          continue;
        }
        characters_.push_back(character);
        if (characters_.size() >= 12) {
          break;
        }
      }
    }
  }

  std::string active;
  const bool hasValidActive =
      reminders_.GetSetting("characters.active", active) &&
      HasCharacter(active);
  std::string packagedGirlDefaultApplied;
  const bool shouldApplyPackagedGirlDefault =
      HasPackagedGirl() &&
      (!reminders_.GetSetting("characters.packagedGirlDefaultApplied",
                              packagedGirlDefaultApplied) ||
       packagedGirlDefaultApplied != "1");

  // Releases before 0.11.3 stored the mouse as the default. Upgrade that old
  // default once, but preserve a user-imported active character. The marker
  // lets a later deliberate switch back to the mouse survive future launches.
  if (shouldApplyPackagedGirlDefault) {
    activeCharacterId_ = hasValidActive && active != "builtin"
                             ? active
                             : "builtin-girl";
    reminders_.SetSetting("characters.active", activeCharacterId_);
    reminders_.SetSetting("characters.packagedGirlDefaultApplied", "1");
  } else {
    activeCharacterId_ = hasValidActive ? active : DefaultCharacterId();
  }

  if (!redundantCharacterFiles.empty()) {
    SaveCharacters();
    for (std::vector<std::wstring>::const_iterator file =
             redundantCharacterFiles.begin();
         file != redundantCharacterFiles.end(); ++file) {
      DeleteFileIfExists(*file);
    }
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
  if (id == "builtin-girl") {
    return HasPackagedGirl();
  }
  return std::any_of(
      characters_.begin(), characters_.end(),
      [&id](const CharacterProfile& character) { return character.id == id; });
}

bool Application::HasPackagedGirl() const {
  return PathExists(JoinPath(uiDirectory_, kPackagedGirlRelativePath));
}

std::string Application::DefaultCharacterId() const {
  return HasPackagedGirl() ? "builtin-girl" : "builtin";
}

void Application::SendError(WebViewWindow& target,
                            const std::string& message) {
  target.PostJson(
      nlohmann::json{{"type", "app.error"},
                     {"payload", {{"message", message}}}}
          .dump());
}

}  // namespace milo
