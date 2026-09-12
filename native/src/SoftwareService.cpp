#include "Milo/SoftwareService.h"

#include <windows.h>
#include <bcrypt.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <winver.h>

#include <algorithm>
#include <cwctype>
#include <set>
#include <sstream>
#include <stdexcept>
#include <vector>

#include "Milo/Utils.h"
#include "Milo/SoftwareServiceTestAccess.h"
#include "cloudyi/software_inventory.h"

namespace milo {
namespace {

struct RegistrySoftware {
  InstalledSoftware publicEntry;
  std::wstring executablePath;
  std::wstring uninstallCommand;
};

struct InventoryContext {
  std::vector<RegistrySoftware>* entries;
  std::function<bool()> stop;
  bool aborted{};
};

bool IsLocalAbsolutePath(const std::wstring& input);
bool HasSafeLocalComponents(const std::wstring& input);

std::wstring ExtractExistingExecutable(const std::wstring& command) {
  if (command.empty()) return std::wstring();
  std::wstring lowercase = command;
  std::transform(lowercase.begin(), lowercase.end(), lowercase.begin(),
                 [](wchar_t character) {
                   return static_cast<wchar_t>(towlower(character));
                 });
  const std::wstring::size_type extension = lowercase.find(L".exe");
  if (extension == std::wstring::npos) return std::wstring();
  std::wstring candidate = command.substr(0, extension + 4);
  while (!candidate.empty() && iswspace(candidate.front()))
    candidate.erase(candidate.begin());
  if (!candidate.empty() && candidate.front() == L'"')
    candidate.erase(candidate.begin());
  while (!candidate.empty() &&
         (candidate.back() == L'"' || iswspace(candidate.back()))) {
    candidate.pop_back();
  }
  if (!IsLocalAbsolutePath(candidate) || !HasSafeLocalComponents(candidate)) return std::wstring();
  const DWORD attributes = GetFileAttributesW(candidate.c_str());
  return attributes != INVALID_FILE_ATTRIBUTES &&
                 (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0
             ? candidate
             : std::wstring();
}

std::wstring ParentDirectory(const std::wstring& path) {
  const std::wstring::size_type separator = path.find_last_of(L"\\/");
  return separator == std::wstring::npos ? std::wstring()
                                         : path.substr(0, separator);
}

std::string RegistryDisplayPath(const std::wstring& entryId) {
  const std::wstring::size_type first = entryId.find(L'|');
  const std::wstring::size_type second =
      first == std::wstring::npos ? std::wstring::npos
                                  : entryId.find(L'|', first + 1);
  if (first == std::wstring::npos || second == std::wstring::npos ||
      second + 1 >= entryId.size()) {
    return std::string();
  }
  const std::wstring scope = entryId.substr(0, first);
  const std::wstring view = entryId.substr(first + 1, second - first - 1);
  const std::wstring keyName = entryId.substr(second + 1);
  const std::wstring root = scope == L"HKCU" ? L"HKEY_CURRENT_USER"
                                              : L"HKEY_LOCAL_MACHINE";
  return WideToUtf8(root +
                    L"\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\"
                    L"Uninstall\\" + keyName + L" (" + view + L" 位视图)");
}

int AppendInventoryEntry(const cy_installed_software* raw, void* context) {
  InventoryContext* inventory = static_cast<InventoryContext*>(context);
  if (inventory->stop && inventory->stop()) { inventory->aborted = true; return 0; }
  RegistrySoftware entry;
  entry.publicEntry.id = WideToUtf8(raw->entry_id);
  entry.publicEntry.displayName = WideToUtf8(raw->display_name);
  entry.publicEntry.displayVersion = WideToUtf8(raw->display_version);
  entry.publicEntry.publisher = WideToUtf8(raw->publisher);
  entry.publicEntry.installLocation = WideToUtf8(raw->install_location);
  entry.publicEntry.registryPath = RegistryDisplayPath(raw->entry_id);
  entry.executablePath = ExtractExistingExecutable(raw->display_icon);
  if (entry.executablePath.empty())
    entry.executablePath = ExtractExistingExecutable(raw->uninstall_command);
  if (entry.publicEntry.installLocation.empty()) {
    const std::wstring inferredLocation = ParentDirectory(entry.executablePath);
    if (!inferredLocation.empty()) {
      entry.publicEntry.installLocation = WideToUtf8(inferredLocation);
      entry.publicEntry.installLocationInferred = true;
    }
  }
  entry.publicEntry.estimatedSizeBytes = raw->estimated_size_bytes;
  entry.publicEntry.currentUser =
      (raw->flags & CY_SOFTWARE_CURRENT_USER) != 0;
  entry.publicEntry.systemComponent =
      (raw->flags & CY_SOFTWARE_SYSTEM_COMPONENT) != 0;
  entry.publicEntry.noRemove = (raw->flags & CY_SOFTWARE_NO_REMOVE) != 0;
  entry.publicEntry.windowsInstaller =
      (raw->flags & CY_SOFTWARE_WINDOWS_INSTALLER) != 0;
  entry.uninstallCommand = raw->uninstall_command[0] != L'\0'
                               ? raw->uninstall_command
                               : raw->quiet_uninstall_command;
  inventory->entries->push_back(entry);
  return 1;
}

std::vector<RegistrySoftware> ReadRegistryInventory(const std::function<bool()>& stop = {}) {
  std::vector<RegistrySoftware> entries;
  InventoryContext context; context.entries = &entries; context.stop = stop;
  if (!cy_enumerate_installed_software(AppendInventoryEntry, &context)) {
    throw std::runtime_error("无法读取 Windows 已安装软件列表。");
  }
  if (context.aborted) throw std::runtime_error("软件清单读取已取消或达到扫描时间上限，请重试。");
  std::sort(entries.begin(), entries.end(),
            [](const RegistrySoftware& left, const RegistrySoftware& right) {
              const std::wstring leftName = Utf8ToWide(left.publicEntry.displayName);
              const std::wstring rightName = Utf8ToWide(right.publicEntry.displayName);
              return _wcsicmp(leftName.c_str(), rightName.c_str()) < 0;
            });
  return entries;
}

const RegistrySoftware* FindSoftware(const std::vector<RegistrySoftware>& rows,
                                     const std::string& id,
                                     const std::string& expectedName) {
  for (std::vector<RegistrySoftware>::const_iterator row = rows.begin();
       row != rows.end(); ++row) {
    if (row->publicEntry.id == id &&
        row->publicEntry.displayName == expectedName) {
      return &*row;
    }
  }
  return nullptr;
}

std::wstring KnownFolder(REFKNOWNFOLDERID folderId) {
  PWSTR raw = nullptr;
  if (FAILED(SHGetKnownFolderPath(folderId, KF_FLAG_DEFAULT, nullptr, &raw)) ||
      raw == nullptr) {
    return std::wstring();
  }
  const std::wstring value(raw);
  CoTaskMemFree(raw);
  return value;
}

std::wstring TrimPath(const std::wstring& input) {
  std::wstring value = input;
  while (!value.empty() && iswspace(value.front())) value.erase(value.begin());
  while (!value.empty() && iswspace(value.back())) value.pop_back();
  if (value.size() >= 2 && value.front() == L'"' && value.back() == L'"') {
    value = value.substr(1, value.size() - 2);
  }
  while (value.size() > 3 &&
         (value.back() == L'\\' || value.back() == L'/')) {
    value.pop_back();
  }
  return value;
}

std::wstring CanonicalPath(const std::wstring& input) {
  if (input.empty()) return std::wstring();
  std::vector<wchar_t> buffer(32768);
  const DWORD length = GetFullPathNameW(input.c_str(),
                                        static_cast<DWORD>(buffer.size()),
                                        buffer.data(), nullptr);
  if (length == 0 || length >= buffer.size()) return std::wstring();
  return TrimPath(std::wstring(buffer.data(), length));
}

// Do not probe UNC, device namespaces, mapped network drives or relative targets.
bool IsLocalAbsolutePath(const std::wstring& input) {
  if (input.size() < 3 || !iswalpha(input[0]) || input[1] != L':' ||
      (input[2] != L'\\' && input[2] != L'/')) return false;
  const wchar_t root[] = {input[0], L':', L'\\', L'\0'};
  const UINT type = GetDriveTypeW(root);
  return type == DRIVE_FIXED || type == DRIVE_REMOVABLE || type == DRIVE_RAMDISK;
}

bool HasSafeLocalComponents(const std::wstring& input) {
  if (!IsLocalAbsolutePath(input)) return false;
  const std::wstring path = CanonicalPath(input);
  if (path.empty()) return false;
  for (std::size_t index = 3; index <= path.size(); ++index) {
    if (index != path.size() && path[index] != L'\\' && path[index] != L'/') continue;
    const std::wstring component = path.substr(0, index);
    const DWORD attributes = GetFileAttributesW(component.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES ||
        (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return false;
  }
  return true;
}

std::string PathIdentity(const std::wstring& path) {
  if (!HasSafeLocalComponents(path)) return std::string();
  HANDLE file = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
      OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (file == INVALID_HANDLE_VALUE) return std::string();
  BY_HANDLE_FILE_INFORMATION info{};
  const bool valid = GetFileInformationByHandle(file, &info) != FALSE &&
      (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0;
  std::vector<wchar_t> finalBuffer(32768);
  const DWORD finalLength = valid ? GetFinalPathNameByHandleW(file, finalBuffer.data(),
      static_cast<DWORD>(finalBuffer.size()), FILE_NAME_NORMALIZED) : 0;
  CloseHandle(file);
  if (!valid || finalLength == 0 || finalLength >= finalBuffer.size()) return std::string();
  std::wstring finalPath(finalBuffer.data(), finalLength);
  if (finalPath.compare(0, 4, L"\\\\?\\") == 0) finalPath.erase(0, 4);
  if (_wcsicmp(CanonicalPath(path).c_str(), CanonicalPath(finalPath).c_str()) != 0 ||
      !HasSafeLocalComponents(path)) return std::string();
  std::ostringstream stamp;
  stamp << info.dwVolumeSerialNumber << ':' << info.nFileIndexHigh << ':'
        << info.nFileIndexLow << ':' << info.ftCreationTime.dwHighDateTime << ':'
        << info.ftCreationTime.dwLowDateTime << ':'
        << ((info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0);
  if ((info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
    stamp << ':' << info.ftLastWriteTime.dwHighDateTime << ':'
          << info.ftLastWriteTime.dwLowDateTime << ':' << info.nFileSizeHigh
          << ':' << info.nFileSizeLow;
  }
  return stamp.str();
}

struct ScanContext {
  explicit ScanContext(const std::function<bool()>& stop = {})
      : cancelled(stop), deadline(GetTickCount64() + 4500U) {}
  std::function<bool()> cancelled;
  ULONGLONG deadline;
  unsigned maximumDepth{6}, maximumEntries{16000}, maximumResults{40};
  unsigned visited{};
  bool truncated{};
  bool wasCancelled{};
  std::vector<std::string> warnings;
  void Warn(const std::string& text, bool incomplete = true) {
    if (incomplete) truncated = true;
    if (warnings.size() < 16 && std::find(warnings.begin(), warnings.end(), text) == warnings.end())
      warnings.push_back(text);
  }
  bool Continue() {
    if (wasCancelled || (cancelled && cancelled())) { wasCancelled = true; return false; }
    if (GetTickCount64() >= deadline) { Warn("扫描达到时间上限，结果可能不完整。"); return false; }
    if (visited > maximumEntries) { Warn("扫描达到文件项上限，结果可能不完整。"); return false; }
    return true;
  }
  bool Visit() {
    if (!Continue()) return false;
    if (++visited > maximumEntries) { Warn("扫描达到文件项上限，结果可能不完整。"); return false; }
    return true;
  }
  bool Room(std::size_t count) {
    if (!Continue()) return false;
    if (count >= maximumResults) { Warn("关联项达到显示上限，请分批清理后重新扫描。"); return false; }
    return true;
  }
};

class ComScope {
 public:
  ComScope() : result_(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED)) {}
  ~ComScope() { if (SUCCEEDED(result_)) CoUninitialize(); }
  bool valid() const { return SUCCEEDED(result_) || result_ == RPC_E_CHANGED_MODE; }
 private:
  HRESULT result_;
};

std::wstring ReadShortcutTarget(const std::wstring& path) {
  if (!HasSafeLocalComponents(path)) return std::wstring();
  WIN32_FILE_ATTRIBUTE_DATA attributes{};
  if (!GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &attributes) ||
      attributes.nFileSizeHigh != 0 || attributes.nFileSizeLow > 2U * 1024U * 1024U)
    return std::wstring();
  ComScope apartment;
  if (!apartment.valid()) return std::wstring();
  IShellLinkW* link = nullptr;
  if (FAILED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER,
                             IID_PPV_ARGS(&link)))) return std::wstring();
  IPersistFile* persist = nullptr;
  std::wstring target;
  if (SUCCEEDED(link->QueryInterface(IID_PPV_ARGS(&persist)))) {
    if (SUCCEEDED(persist->Load(path.c_str(), STGM_READ))) {
      std::vector<wchar_t> buffer(32768);
      // RAWPATH only: never Resolve, execute, search a target, or access a share.
      if (SUCCEEDED(link->GetPath(buffer.data(), static_cast<int>(buffer.size()),
                                 nullptr, SLGP_RAWPATH))) {
        const std::wstring raw(buffer.data());
        if (IsLocalAbsolutePath(raw)) target = CanonicalPath(raw);
      }
    }
    persist->Release();
  }
  link->Release();
  return target;
}

bool CleanupPathExists(const std::wstring& path) {
  return !path.empty() && GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES;
}

std::wstring Lowercase(std::wstring value) {
  std::transform(value.begin(), value.end(), value.begin(),
                 [](wchar_t character) {
                   return static_cast<wchar_t>(towlower(character));
                 });
  return value;
}

bool SamePath(const std::wstring& left, const std::wstring& right) {
  const std::wstring canonicalLeft = CanonicalPath(left);
  const std::wstring canonicalRight = CanonicalPath(right);
  return !canonicalLeft.empty() && !canonicalRight.empty() &&
         _wcsicmp(canonicalLeft.c_str(), canonicalRight.c_str()) == 0;
}

bool IsDescendantPath(const std::wstring& path, const std::wstring& parent) {
  const std::wstring canonicalPath = Lowercase(CanonicalPath(path));
  std::wstring canonicalParent = Lowercase(CanonicalPath(parent));
  if (canonicalPath.empty() || canonicalParent.empty()) return false;
  if (canonicalParent.back() != L'\\') canonicalParent.push_back(L'\\');
  return canonicalPath.size() > canonicalParent.size() &&
         canonicalPath.compare(0, canonicalParent.size(), canonicalParent) == 0;
}

bool IsTrustedProgramPath(const std::wstring& path) {
  const std::wstring localPrograms =
      KnownFolder(FOLDERID_LocalAppData) + L"\\Programs";
  return IsDescendantPath(path, KnownFolder(FOLDERID_ProgramFiles)) ||
         IsDescendantPath(path, KnownFolder(FOLDERID_ProgramFilesX86)) ||
         IsDescendantPath(path, localPrograms);
}

bool IsProtectedCleanupPath(const std::wstring& path) {
  const std::wstring canonical = CanonicalPath(path);
  if (canonical.empty() || canonical.size() <= 3) return true;
  const KNOWNFOLDERID protectedFolders[] = {
      FOLDERID_Profile,         FOLDERID_Desktop,
      FOLDERID_PublicDesktop,   FOLDERID_Programs,
      FOLDERID_CommonPrograms,  FOLDERID_ProgramData,
      FOLDERID_Documents,       FOLDERID_Downloads,
      FOLDERID_Pictures,        FOLDERID_Music,
      FOLDERID_Videos,          FOLDERID_Favorites,
      FOLDERID_SavedGames,
      FOLDERID_RoamingAppData,  FOLDERID_LocalAppData,
      FOLDERID_ProgramFiles,    FOLDERID_ProgramFilesX86,
      FOLDERID_Windows,
  };
  for (std::size_t index = 0; index < ARRAYSIZE(protectedFolders); ++index) {
    const std::wstring root = KnownFolder(protectedFolders[index]);
    if (!root.empty() && (SamePath(canonical, root) || IsDescendantPath(root, canonical))) return true;
  }
  const std::wstring profileAppData = KnownFolder(FOLDERID_Profile) +
                                      L"\\AppData";
  if (SamePath(canonical, profileAppData)) return true;
  const std::wstring windows = KnownFolder(FOLDERID_Windows);
  if (!windows.empty()) {
    const std::wstring lowerPath = Lowercase(canonical);
    std::wstring lowerWindows = Lowercase(CanonicalPath(windows));
    if (!lowerWindows.empty() && lowerWindows.back() != L'\\')
      lowerWindows.push_back(L'\\');
    if (lowerPath.compare(0, lowerWindows.size(), lowerWindows) == 0)
      return true;
  }
  return false;
}

struct TreeMeasure {
  std::uint64_t bytes{};
  std::uint32_t items{};
  bool truncated{};
};

void MeasurePath(const std::wstring& path, TreeMeasure* measure,
                  DWORD startedAt, ScanContext* scan = nullptr) {
  if ((scan && !scan->Visit()) || measure->items >= 100000U ||
      GetTickCount() - startedAt > (scan ? 120U : 1800U)) {
    measure->truncated = true;
    return;
  }
  const DWORD attributes = GetFileAttributesW(path.c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES) return;
  ++measure->items;
  if ((attributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
    WIN32_FILE_ATTRIBUTE_DATA data{};
    if (GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &data)) {
      measure->bytes +=
          (static_cast<std::uint64_t>(data.nFileSizeHigh) << 32) |
          data.nFileSizeLow;
    }
    return;
  }
  if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return;

  WIN32_FIND_DATAW item{};
  const std::wstring pattern = path + L"\\*";
  HANDLE search = FindFirstFileW(pattern.c_str(), &item);
  if (search == INVALID_HANDLE_VALUE) return;
  do {
    if (wcscmp(item.cFileName, L".") == 0 ||
        wcscmp(item.cFileName, L"..") == 0) {
      continue;
    }
    MeasurePath(path + L"\\" + item.cFileName, measure, startedAt, scan);
    if (measure->truncated) break;
  } while (FindNextFileW(search, &item));
  FindClose(search);
}

std::string CreatePlanToken() {
  unsigned char bytes[16]{};
  if (BCryptGenRandom(nullptr, bytes, sizeof(bytes),
                      BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) {
    throw std::runtime_error("无法创建安全的清理确认标识。");
  }
  static const char digits[] = "0123456789abcdef";
  std::string output;
  output.reserve(sizeof(bytes) * 2);
  for (std::size_t index = 0; index < sizeof(bytes); ++index) {
    output.push_back(digits[bytes[index] >> 4]);
    output.push_back(digits[bytes[index] & 0x0f]);
  }
  return output;
}

void AddResidual(std::vector<SoftwareResidual>* output,
                 const std::wstring& rawPath, const std::string& label,
                 const std::string& kind, const std::string& evidence,
                  const std::string& confidence, bool defaultSelected,
                  bool personalData, ScanContext* scan = nullptr) {
  if (scan && !scan->Room(output->size())) return;
  const std::wstring path = CanonicalPath(TrimPath(rawPath));
  if (!IsLocalAbsolutePath(path) || !CleanupPathExists(path) || IsProtectedCleanupPath(path)) return;
  for (std::vector<SoftwareResidual>::const_iterator row = output->begin();
       row != output->end(); ++row) {
    if (SamePath(Utf8ToWide(row->path), path)) return;
  }
  TreeMeasure measure;
  const std::string identity = PathIdentity(path);
  if (identity.empty()) {
    if (scan) scan->Warn("部分关联位置无法读取身份或经过重解析点，已跳过。");
    return;
  }
  MeasurePath(path, &measure, GetTickCount(), scan);
  SoftwareResidual residual;
  residual.path = WideToUtf8(path);
  residual.label = label;
  residual.kind = kind;
  residual.evidence = evidence;
  residual.confidence = confidence;
  residual.sizeBytes = measure.bytes;
  residual.itemCount = measure.items;
  residual.sizeTruncated = measure.truncated;
  residual.defaultSelected = defaultSelected;
  residual.personalData = personalData;
  residual.nativeIdentity = identity;
  if (measure.truncated && scan) scan->Warn("部分目录大小统计未完成，显示值为已统计部分。", false);
  output->push_back(residual);
}

std::wstring LeafName(const std::wstring& path) {
  const std::wstring trimmed = TrimPath(path);
  const std::wstring::size_type separator = trimmed.find_last_of(L"\\/");
  return separator == std::wstring::npos ? trimmed
                                         : trimmed.substr(separator + 1);
}

std::wstring StemName(const std::wstring& path) {
  std::wstring leaf = LeafName(path);
  const std::wstring::size_type extension = leaf.find_last_of(L'.');
  if (extension != std::wstring::npos) leaf.resize(extension);
  return leaf;
}

std::wstring RegistryKeyName(const std::string& id) {
  const std::wstring wideId = Utf8ToWide(id);
  const std::wstring::size_type first = wideId.find(L'|');
  const std::wstring::size_type second =
      first == std::wstring::npos ? std::wstring::npos
                                  : wideId.find(L'|', first + 1);
  return second == std::wstring::npos ? std::wstring()
                                      : wideId.substr(second + 1);
}

std::wstring StripVersionDecorations(std::wstring value) {
  while (!value.empty() && iswspace(value.back())) value.pop_back();
  const std::wstring::size_type parenthesis = value.find(L'(');
  if (parenthesis != std::wstring::npos && parenthesis > 2)
    value.resize(parenthesis);
  for (std::wstring::size_type index = 1; index + 1 < value.size(); ++index) {
    if (iswspace(value[index]) && iswdigit(value[index + 1])) {
      value.resize(index);
      break;
    }
  }
  while (!value.empty() &&
         (iswspace(value.back()) || value.back() == L'-' ||
          value.back() == L'_')) {
    value.pop_back();
  }
  return value;
}

bool IsCjkLetter(wchar_t character) {
  return (character >= 0x3400 && character <= 0x9fff) ||
         (character >= 0xf900 && character <= 0xfaff);
}

std::wstring NormalizeIdentity(const std::wstring& value) {
  std::wstring output;
  for (std::wstring::const_iterator character = value.begin();
       character != value.end(); ++character) {
    if ((*character >= L'0' && *character <= L'9') ||
        (*character >= L'a' && *character <= L'z') ||
        (*character >= L'A' && *character <= L'Z') ||
        IsCjkLetter(*character)) {
      output.push_back(static_cast<wchar_t>(towlower(*character)));
    }
  }
  return output;
}

bool IsGenericIdentity(const std::wstring& value) {
  static const wchar_t* generic[] = {
      L"app",       L"application", L"client",  L"helper",
      L"cache",     L"caches",      L"data",    L"launcher",
      L"logs",      L"packages",    L"program", L"programs",
      L"server",    L"setup",       L"temp",
      L"software",  L"uninstall",   L"unins",   L"update",
      L"updater",   L"user",        L"x64",     L"x86",
      L"co",        L"company",     L"corporation", L"group",
      L"inc",       L"limited",     L"llc",     L"ltd",
      L"technologies", L"technology", L"程序",  L"软件",
      L"卸载",      L"更新",        L"公司",    L"科技",
      L"有限公司"};
  return std::find_if(std::begin(generic), std::end(generic),
                      [&value](const wchar_t* candidate) {
                        return value == candidate;
                      }) != std::end(generic);
}

struct IdentityAlias {
  std::wstring normalized;
  std::string evidence;
  std::string confidence;
};

void AddAlias(std::vector<IdentityAlias>* aliases, const std::wstring& value,
              const std::string& evidence, const std::string& confidence) {
  const std::wstring normalized = NormalizeIdentity(value);
  if (normalized.size() < 4 &&
      std::find_if(normalized.begin(), normalized.end(), IsCjkLetter) ==
          normalized.end()) {
    return;
  }
  if (normalized.empty() || IsGenericIdentity(normalized)) return;
  for (std::vector<IdentityAlias>::iterator alias = aliases->begin();
       alias != aliases->end(); ++alias) {
    if (alias->normalized == normalized) {
      if (alias->confidence == "medium" && confidence == "high")
        *alias = IdentityAlias{normalized, evidence, confidence};
      return;
    }
  }
  aliases->push_back(IdentityAlias{normalized, evidence, confidence});
}

std::vector<std::wstring> SplitIdentityWords(const std::wstring& value) {
  std::vector<std::wstring> words;
  std::wstring current;
  for (std::wstring::const_iterator character = value.begin();
       character != value.end(); ++character) {
    const bool identityCharacter =
        (*character >= L'0' && *character <= L'9') ||
        (*character >= L'a' && *character <= L'z') ||
        (*character >= L'A' && *character <= L'Z') ||
        IsCjkLetter(*character);
    if (identityCharacter) {
      current.push_back(*character);
    } else if (!current.empty()) {
      words.push_back(current);
      current.clear();
    }
  }
  if (!current.empty()) words.push_back(current);
  return words;
}

void AddIdentityVariants(std::vector<IdentityAlias>* aliases,
                         const std::wstring& rawValue,
                         const std::string& evidence,
                         const std::string& confidence) {
  const std::wstring base = StripVersionDecorations(rawValue);
  AddAlias(aliases, rawValue, evidence, confidence);
  AddAlias(aliases, base, evidence, confidence);
  const std::vector<std::wstring> words = SplitIdentityWords(base);
  for (std::size_t index = 0; index < words.size(); ++index) {
    AddAlias(aliases, words[index], evidence + "（名称片段）", "medium");
    if (index + 1 < words.size()) {
      AddAlias(aliases, words[index] + words[index + 1],
               evidence + "（相邻名称片段）", "medium");
    }
  }
}

std::wstring ReadVersionString(const std::wstring& executable,
                                const wchar_t* field) {
  if (executable.empty() || !HasSafeLocalComponents(executable)) return std::wstring();
  DWORD ignored = 0;
  const DWORD size = GetFileVersionInfoSizeW(executable.c_str(), &ignored);
  if (size == 0 || size > 16U * 1024U * 1024U) return std::wstring();
  std::vector<unsigned char> data(size);
  if (!GetFileVersionInfoW(executable.c_str(), 0, size, data.data()))
    return std::wstring();

  struct Translation {
    WORD language;
    WORD codePage;
  };
  Translation* translations = nullptr;
  UINT translationBytes = 0;
  if (!VerQueryValueW(data.data(), L"\\VarFileInfo\\Translation",
                      reinterpret_cast<void**>(&translations),
                      &translationBytes) ||
      translations == nullptr || translationBytes < sizeof(Translation)) {
    return std::wstring();
  }
  wchar_t query[128]{};
  swprintf_s(query, ARRAYSIZE(query), L"\\StringFileInfo\\%04x%04x\\%ls",
             translations[0].language, translations[0].codePage, field);
  wchar_t* value = nullptr;
  UINT characters = 0;
  if (!VerQueryValueW(data.data(), query, reinterpret_cast<void**>(&value),
                      &characters) ||
      value == nullptr || characters <= 1) {
    return std::wstring();
  }
  return std::wstring(value, characters - 1);
}

struct SoftwareIdentity {
  std::vector<IdentityAlias> product;
  std::vector<IdentityAlias> publisher;
};

SoftwareIdentity BuildIdentity(const RegistrySoftware& software) {
  SoftwareIdentity identity;
  AddIdentityVariants(&identity.product,
                      Utf8ToWide(software.publicEntry.displayName),
                      "与卸载注册名称精确匹配", "high");
  AddIdentityVariants(&identity.product,
                      RegistryKeyName(software.publicEntry.id),
                      "与卸载注册项名称精确匹配", "high");
  AddIdentityVariants(&identity.product, StemName(software.executablePath),
                      "与主程序文件名匹配", "medium");
  AddIdentityVariants(&identity.product,
                      ReadVersionString(software.executablePath,
                                        L"ProductName"),
                      "与主程序产品名称匹配", "high");
  AddIdentityVariants(&identity.product,
                      ReadVersionString(software.executablePath,
                                        L"FileDescription"),
                      "与主程序文件说明匹配", "high");
  AddIdentityVariants(&identity.publisher,
                      Utf8ToWide(software.publicEntry.publisher),
                      "与注册发布者匹配", "high");
  AddIdentityVariants(&identity.publisher,
                      ReadVersionString(software.executablePath,
                                        L"CompanyName"),
                      "与主程序公司名称匹配", "high");
  for (std::vector<IdentityAlias>::iterator product = identity.product.begin();
       product != identity.product.end();) {
    const bool isPublisherName =
        std::find_if(identity.publisher.begin(), identity.publisher.end(),
                     [product](const IdentityAlias& publisher) {
                       return product->normalized == publisher.normalized;
                     }) != identity.publisher.end();
    if (isPublisherName)
      product = identity.product.erase(product);
    else
      ++product;
  }
  // InstallLocation alone is not a product identity: a shared D:\Publisher
  // directory must not cause similarly named AppData directories to be selected.
  const std::wstring leaf = NormalizeIdentity(LeafName(Utf8ToWide(software.publicEntry.installLocation)));
  const auto supported = std::find_if(identity.product.begin(), identity.product.end(),
      [&leaf](const IdentityAlias& alias) { return alias.normalized == leaf && alias.confidence == "high"; });
  if (supported != identity.product.end())
    AddAlias(&identity.product, leaf, "安装目录名由独立产品身份交叉验证", "high");
  return identity;
}

const IdentityAlias* MatchAlias(const std::wstring& name,
                                const std::vector<IdentityAlias>& aliases) {
  const std::wstring normalized = NormalizeIdentity(name);
  if (normalized.empty()) return nullptr;
  for (std::vector<IdentityAlias>::const_iterator alias = aliases.begin();
       alias != aliases.end(); ++alias) {
    if (alias->normalized == normalized) return &*alias;
  }
  return nullptr;
}

struct DirectoryEntry {
  std::wstring path;
  std::wstring name;
  bool directory{};
};

std::vector<DirectoryEntry> ListDirectoryEntries(const std::wstring& root,
                                                 bool includeShortcuts,
                                                 ScanContext* scan = nullptr) {
  std::vector<DirectoryEntry> output;
  if (root.empty()) return output;
  if (!IsLocalAbsolutePath(root)) { if (scan) scan->Warn("网络或非本地扫描根已跳过。"); return output; }
  if (!HasSafeLocalComponents(root)) {
    const DWORD error = GetLastError();
    if (scan && error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND)
      scan->Warn("部分扫描根不可读或经过重解析点，已跳过。");
    return output;
  }
  WIN32_FIND_DATAW item{};
  HANDLE search = FindFirstFileW((root + L"\\*").c_str(), &item);
  if (search == INVALID_HANDLE_VALUE) {
    if (scan && GetLastError() != ERROR_FILE_NOT_FOUND)
      scan->Warn("部分目录无法枚举（权限或读取错误），结果可能不完整。");
    return output;
  }
  do {
    if (scan && !scan->Visit()) break;
    if (wcscmp(item.cFileName, L".") == 0 || wcscmp(item.cFileName, L"..") == 0) {
      continue;
    }
    if ((item.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
      if (scan) scan->Warn("发现重解析点或符号链接，未跟随扫描。");
      continue;
    }
    const bool directory =
        (item.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
    const std::wstring name(item.cFileName);
    const std::wstring lower = Lowercase(name);
    const bool shortcut = lower.size() > 4 &&
                          lower.substr(lower.size() - 4) == L".lnk";
    if (directory || (includeShortcuts && shortcut)) {
      DirectoryEntry entry;
      entry.path = root + L"\\" + name;
      entry.name = name;
      entry.directory = directory;
      output.push_back(entry);
    }
  } while (output.size() < 2048U && FindNextFileW(search, &item));
  if (scan && output.size() >= 2048U) scan->Warn("部分目录达到单层枚举上限，结果可能不完整。");
  if (scan && output.size() < 2048U && scan->Continue() && scan->visited <= scan->maximumEntries &&
      GetLastError() != ERROR_NO_MORE_FILES)
    scan->Warn("部分目录枚举未能完成（权限或读取错误）。");
  FindClose(search);
  return output;
}

void ScanIdentityRoot(std::vector<SoftwareResidual>* output,
                      const std::wstring& root, const std::string& label,
                      const std::string& kind, bool personalData,
                      bool includeShortcuts,
                      const std::vector<IdentityAlias>& productAliases,
                      ScanContext* scan) {
  const std::vector<DirectoryEntry> entries =
      ListDirectoryEntries(root, includeShortcuts, scan);
  for (std::vector<DirectoryEntry>::const_iterator entry = entries.begin();
       entry != entries.end() && scan->Room(output->size()); ++entry) {
    const std::wstring candidateName = entry->directory
                                           ? entry->name
                                           : StemName(entry->name);
    const IdentityAlias* alias = MatchAlias(candidateName, productAliases);
    if (alias == nullptr) continue;
    const std::string evidence = alias->evidence + "；限定目录精确命中";
    const bool defaultSelected =
        kind == "shortcut" && alias->confidence == "high";
    AddResidual(output, entry->path, label, kind, evidence,
                alias->confidence, defaultSelected, personalData, scan);
  }
}

void ScanPublisherChildren(
    std::vector<SoftwareResidual>* output, const std::wstring& root,
    const std::string& label, const std::string& kind, bool personalData,
    const SoftwareIdentity& identity, ScanContext* scan) {
  const std::vector<DirectoryEntry> publishers =
      ListDirectoryEntries(root, false, scan);
  for (std::vector<DirectoryEntry>::const_iterator publisher =
           publishers.begin();
       publisher != publishers.end() && scan->Room(output->size()); ++publisher) {
    if (!publisher->directory ||
        MatchAlias(publisher->name, identity.publisher) == nullptr) {
      continue;
    }
    const std::vector<DirectoryEntry> children =
        ListDirectoryEntries(publisher->path, kind == "shortcut", scan);
    for (std::vector<DirectoryEntry>::const_iterator child = children.begin();
         child != children.end() && scan->Room(output->size()); ++child) {
      const std::wstring candidateName = child->directory
                                             ? child->name
                                             : StemName(child->name);
      const IdentityAlias* alias = MatchAlias(candidateName, identity.product);
      if (alias == nullptr) continue;
      const bool defaultSelected =
          kind == "shortcut" && alias->confidence == "high";
      AddResidual(output, child->path, label, kind,
                  alias->evidence + "；发布者目录下精确命中",
                  alias->confidence, defaultSelected, personalData, scan);
    }
  }
}

struct ShortcutIdentity {
  std::wstring executable;
  std::wstring installDirectory;
  std::vector<IdentityAlias> product;
};

ShortcutIdentity BuildShortcutIdentity(const RegistrySoftware& software) {
  ShortcutIdentity result;
  // Independent identity evidence excludes the install directory leaf itself:
  // a registry path such as D:\Tencent must not "verify" a shared parent.
  AddIdentityVariants(&result.product, Utf8ToWide(software.publicEntry.displayName),
                      "卸载注册名称", "high");
  AddIdentityVariants(&result.product, RegistryKeyName(software.publicEntry.id),
                      "卸载注册项名称", "high");
  const std::wstring executable = TrimPath(software.executablePath);
  if (!executable.empty() && !PathIdentity(executable).empty()) {
    result.executable = CanonicalPath(executable);
    AddIdentityVariants(&result.product, StemName(executable), "注册程序名称", "medium");
    AddIdentityVariants(&result.product, ReadVersionString(executable, L"ProductName"), "产品元数据", "high");
  }
  std::vector<IdentityAlias> publisher;
  AddIdentityVariants(&publisher, Utf8ToWide(software.publicEntry.publisher), "发布者", "high");
  result.product.erase(std::remove_if(result.product.begin(), result.product.end(),
      [&publisher](const IdentityAlias& alias) {
        return std::find_if(publisher.begin(), publisher.end(), [&alias](const IdentityAlias& company) {
          return company.normalized == alias.normalized;
        }) != publisher.end();
      }), result.product.end());
  const std::wstring install = CanonicalPath(TrimPath(Utf8ToWide(software.publicEntry.installLocation)));
  if (!install.empty() && !PathIdentity(install).empty() && !IsProtectedCleanupPath(install))
    result.installDirectory = install;
  return result;
}

bool ShortcutTargetMatches(const std::wstring& target, const ShortcutIdentity& identity) {
  if (target.empty() || PathIdentity(target).empty()) return false;
  const DWORD attributes = GetFileAttributesW(target.c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0) return false;
  if (!identity.executable.empty() && SamePath(target, identity.executable)) return true;
  if (identity.installDirectory.empty() || !IsDescendantPath(target, identity.installDirectory)) return false;
  // A dedicated product directory or independently identified executable is
  // required. Merely being somewhere below a publisher's directory is not enough.
  if (MatchAlias(LeafName(identity.installDirectory), identity.product) != nullptr ||
      MatchAlias(StemName(target), identity.product) != nullptr) return true;
  return MatchAlias(ReadVersionString(target, L"ProductName"), identity.product) != nullptr;
}

void ScanShortcutDirectory(std::vector<SoftwareResidual>* output,
                           const std::wstring& root, const std::string& label,
                           const ShortcutIdentity& identity, ScanContext* scan,
                           unsigned depth = 0) {
  if (!scan->Room(output->size())) return;
  const std::vector<DirectoryEntry> entries = ListDirectoryEntries(root, true, scan);
  for (const auto& entry : entries) {
    if (!scan->Room(output->size())) break;
    if (entry.directory) {
      if (depth >= scan->maximumDepth) {
        scan->Warn("部分快捷方式目录达到扫描深度上限，未继续展开。");
      } else {
        // Parent names are deliberately irrelevant. A shared menu folder is
        // only traversed, never scheduled for recursive cleanup.
        ScanShortcutDirectory(output, entry.path, label, identity, scan, depth + 1);
      }
      continue;
    }
    const std::string before = PathIdentity(entry.path);
    if (before.empty()) { scan->Warn("部分快捷方式无法读取身份，已跳过。"); continue; }
    const std::wstring target = ReadShortcutTarget(entry.path);
    if (!scan->Continue()) break;
    if (target.empty()) {
      scan->Warn("部分快捷方式无法读取本地目标（含网络、广告或无效链接），已跳过。");
      continue;
    }
    if (!ShortcutTargetMatches(target, identity)) continue;
    if (before != PathIdentity(entry.path)) { scan->Warn("部分快捷方式在扫描期间发生变化，已跳过。"); continue; }
    const std::size_t oldSize = output->size();
    AddResidual(output, entry.path, label, "shortcut", "快捷方式实际目标与注册程序或经产品身份核实的安装位置一致",
                "high", true, false, scan);
    if (output->size() > oldSize) output->back().targetPath = WideToUtf8(target);
  }
}

bool RevalidateResidual(const SoftwareResidual& residual) {
  const std::wstring path = Utf8ToWide(residual.path);
  if (residual.nativeIdentity.empty() || residual.nativeIdentity != PathIdentity(path)) return false;
  if (residual.kind == "shortcut") {
    if (residual.targetPath.empty()) return false;
    const std::wstring target = ReadShortcutTarget(path);
    // The target executable may legitimately disappear after uninstall. Keep
    // pre-uninstall evidence, but never accept a link whose destination changed.
    return !target.empty() && SamePath(target, Utf8ToWide(residual.targetPath)) &&
           residual.nativeIdentity == PathIdentity(path);
  }
  return true;
}

bool ContainsOtherSoftwareLocation(const std::wstring& directory,
                                   const std::vector<std::wstring>& otherLocations) {
  for (const auto& location : otherLocations) {
    if (IsLocalAbsolutePath(location) &&
        (SamePath(location, directory) || IsDescendantPath(location, directory))) return true;
  }
  return false;
}

std::vector<SoftwareResidual> BuildResiduals(
    const RegistrySoftware& registrySoftware,
    const std::vector<RegistrySoftware>& registry, ScanContext* scan) {
  const InstalledSoftware& software = registrySoftware.publicEntry;
  std::vector<SoftwareResidual> output;
  const SoftwareIdentity identity = BuildIdentity(registrySoftware);
  const ShortcutIdentity shortcutIdentity = BuildShortcutIdentity(registrySoftware);
  std::vector<std::wstring> otherLocations;
  for (const auto& other : registry) {
    if (other.publicEntry.id == software.id) continue;
    const std::wstring registered = TrimPath(Utf8ToWide(other.publicEntry.installLocation));
    if (!registered.empty()) otherLocations.push_back(registered);
    if (!other.executablePath.empty()) otherLocations.push_back(other.executablePath);
  }
  const KNOWNFOLDERID shortcutRoots[] = {FOLDERID_Programs, FOLDERID_CommonPrograms,
                                        FOLDERID_Desktop, FOLDERID_PublicDesktop};
  const char* shortcutLabels[] = {"当前用户开始菜单快捷方式", "所有用户开始菜单快捷方式",
                                   "当前用户桌面快捷方式", "公共桌面快捷方式"};
  for (std::size_t index = 0; index < ARRAYSIZE(shortcutRoots); ++index) {
    if (!scan->Room(output.size())) break;
    const std::wstring root = KnownFolder(shortcutRoots[index]);
    if (root.empty()) { scan->Warn("部分系统快捷方式位置无法取得，结果可能不完整。"); continue; }
    ScanShortcutDirectory(&output, root, shortcutLabels[index], shortcutIdentity, scan);
  }
  const std::wstring registeredLocation = Utf8ToWide(software.installLocation);
  const bool standardProgramPath = IsTrustedProgramPath(registeredLocation);
  const bool dedicatedProgramDirectory = MatchAlias(LeafName(registeredLocation), shortcutIdentity.product) != nullptr;
  if (dedicatedProgramDirectory && !shortcutIdentity.installDirectory.empty() &&
      !ContainsOtherSoftwareLocation(registeredLocation, otherLocations)) {
    AddResidual(&output, registeredLocation,
                software.installLocationInferred
                    ? "由注册程序文件确认的安装目录"
                    : "注册安装目录",
                "program",
                software.installLocationInferred
                    ? "DisplayIcon 或 UninstallString 指向该目录内现存 EXE"
                    : "Windows 卸载项直接提供 InstallLocation",
                standardProgramPath ? "high" : "medium", false, false, scan);
  } else if (!registeredLocation.empty() && !dedicatedProgramDirectory) {
    scan->Warn("安装位置尚不能核实为该软件独占目录，未将整个目录列为清理项。", false);
  }

  const std::wstring profile = KnownFolder(FOLDERID_Profile);
  const std::wstring roaming = KnownFolder(FOLDERID_RoamingAppData);
  const std::wstring local = KnownFolder(FOLDERID_LocalAppData);
  const std::wstring programData = KnownFolder(FOLDERID_ProgramData);
  ScanIdentityRoot(&output, profile, "用户配置目录", "personal", true,
                   false, identity.product, scan);
  ScanIdentityRoot(&output, local, "本地应用数据", "personal", true, false,
                   identity.product, scan);
  ScanIdentityRoot(&output, roaming, "漫游应用数据", "personal", true,
                   false, identity.product, scan);
  ScanIdentityRoot(&output, programData, "所有用户共享数据", "personal",
                   true, false, identity.product, scan);
  ScanIdentityRoot(&output, local + L"\\Programs", "当前用户程序目录",
                   "program", false, false, identity.product, scan);
  ScanPublisherChildren(&output, local, "发布者目录内的本地数据",
                        "personal", true, identity, scan);
  ScanPublisherChildren(&output, roaming, "发布者目录内的漫游数据",
                        "personal", true, identity, scan);
  ScanPublisherChildren(&output, programData, "发布者目录内的共享数据",
                        "personal", true, identity, scan);
  // Apply to all directory candidates, including rediscovery via local data
  // roots. A different registered app nested inside makes the directory shared.
  output.erase(std::remove_if(output.begin(), output.end(), [&otherLocations, scan](const SoftwareResidual& residual) {
    if (residual.kind == "shortcut") return false;
    if (!ContainsOtherSoftwareLocation(Utf8ToWide(residual.path), otherLocations)) return false;
    scan->Warn("部分关联目录包含其他已注册软件，已保留共享目录，仅可审核独立快捷方式。", false);
    return true;
  }), output.end());
  if (!registeredLocation.empty() && ContainsOtherSoftwareLocation(registeredLocation, otherLocations))
    scan->Warn("安装位置包含其他已注册软件，整个共享安装目录未列入清理计划。", false);
  return output;
}

bool MovePathToRecycleBin(const std::wstring& path) {
  ComScope apartment;
  if (!apartment.valid() || !HasSafeLocalComponents(path)) return false;
  IFileOperation* operation = nullptr;
  IShellItem* item = nullptr;
  HRESULT status = CoCreateInstance(CLSID_FileOperation, nullptr,
      CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&operation));
  if (FAILED(status)) return false;
  // Windows 10/11: explicitly recycle, abort on failure; no permanent-delete
  // fallback. ALLOWUNDO alone only requests recycling "if possible".
  status = operation->SetOperationFlags(FOFX_RECYCLEONDELETE | FOFX_EARLYFAILURE |
      FOF_ALLOWUNDO | FOF_WANTNUKEWARNING | FOF_NOCONFIRMATION |
      FOF_NOERRORUI | FOF_SILENT);
  if (SUCCEEDED(status)) status = SHCreateItemFromParsingName(path.c_str(), nullptr, IID_PPV_ARGS(&item));
  if (SUCCEEDED(status)) status = operation->DeleteItem(item, nullptr);
  if (SUCCEEDED(status)) status = operation->PerformOperations();
  BOOL aborted = TRUE;
  if (SUCCEEDED(status)) status = operation->GetAnyOperationsAborted(&aborted);
  if (item) item->Release();
  operation->Release();
  return SUCCEEDED(status) && !aborted && !CleanupPathExists(path);
}

bool PlanCurrent(const SoftwareCleanupPlan& plan) {
  return !plan.token.empty() && plan.nativeCreatedTick != 0 &&
         GetTickCount64() - plan.nativeCreatedTick <= 15U * 60U * 1000U;
}

bool SafelyMissing(const std::wstring& path) {
  if (!IsLocalAbsolutePath(path) || !HasSafeLocalComponents(ParentDirectory(path))) return false;
  if (GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES) return false;
  return GetLastError() == ERROR_FILE_NOT_FOUND || GetLastError() == ERROR_PATH_NOT_FOUND;
}

// Pin each ancestor against replacement/reparse changes while the exact path is
// used by the shell. The leaf permits rename-to-recycle but never content writes.
class PinnedCleanupPath {
 public:
  ~PinnedCleanupPath() { for (HANDLE handle : handles_) CloseHandle(handle); }
  bool Lock(const std::wstring& raw) {
    if (!HasSafeLocalComponents(raw)) return false;
    const std::wstring path = CanonicalPath(raw);
    for (std::size_t index = 3; index <= path.size(); ++index) {
      if (index != path.size() && path[index] != L'\\' && path[index] != L'/') continue;
      const DWORD share = FILE_SHARE_READ | (index == path.size() ? FILE_SHARE_DELETE : 0);
      failedPath_ = path.substr(0, index);
      HANDLE handle = CreateFileW(path.substr(0, index).c_str(), FILE_READ_ATTRIBUTES,
          share, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
      if (handle == INVALID_HANDLE_VALUE) return false;
      handles_.push_back(handle);
      BY_HANDLE_FILE_INFORMATION info{};
      if (!GetFileInformationByHandle(handle, &info) ||
          (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return false;
    }
    return true;
  }
  const std::wstring& ErrorPath() const { return failedPath_; }
 private:
  std::vector<HANDLE> handles_;
  std::wstring failedPath_;
};

bool TreeSafeToRecycle(const std::wstring& path, ScanContext* scan, unsigned depth = 0) {
  if (!scan->Visit() || depth > 64 || !HasSafeLocalComponents(path)) return false;
  const DWORD attributes = GetFileAttributesW(path.c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return false;
  if ((attributes & FILE_ATTRIBUTE_DIRECTORY) == 0) return true;
  WIN32_FIND_DATAW entry{};
  HANDLE search = FindFirstFileW((path + L"\\*").c_str(), &entry);
  if (search == INVALID_HANDLE_VALUE) return GetLastError() == ERROR_FILE_NOT_FOUND;
  bool safe = true;
  do {
    if (wcscmp(entry.cFileName, L".") == 0 || wcscmp(entry.cFileName, L"..") == 0) continue;
    if ((entry.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
        !TreeSafeToRecycle(path + L"\\" + entry.cFileName, scan, depth + 1)) { safe = false; break; }
  } while (FindNextFileW(search, &entry));
  if (safe && GetLastError() != ERROR_NO_MORE_FILES) safe = false;
  FindClose(search);
  return safe;
}

bool ParseUninstallCommand(const std::wstring& raw, std::wstring* executable,
                           std::wstring* arguments) {
  if (raw.empty() || raw.size() > 8191 || raw.find(L'\0') != std::wstring::npos ||
      raw.find_first_of(L"\r\n") != std::wstring::npos) return false;
  std::vector<wchar_t> expanded(32768);
  const DWORD length = ExpandEnvironmentStringsW(raw.c_str(), expanded.data(),
                                                static_cast<DWORD>(expanded.size()));
  if (!length || length >= expanded.size()) return false;
  std::wstring command(expanded.data());
  while (!command.empty() && iswspace(command.front())) command.erase(command.begin());
  std::size_t end = std::wstring::npos;
  if (!command.empty() && command.front() == L'"') {
    end = command.find(L'"', 1);
    if (end == std::wstring::npos) return false;
    *executable = command.substr(1, end - 1);
    ++end;
    if (end < command.size() && !iswspace(command[end])) return false;
  } else {
    const std::wstring lower = Lowercase(command);
    std::size_t extension = lower.find(L".exe");
    while (extension != std::wstring::npos && extension + 4 < lower.size() &&
           !iswspace(lower[extension + 4])) extension = lower.find(L".exe", extension + 4);
    if (extension == std::wstring::npos) return false;
    end = extension + 4;
    *executable = command.substr(0, end);
  }
  if (Lowercase(*executable).size() < 4 ||
      Lowercase(*executable).substr(executable->size() - 4) != L".exe") return false;
  // Bare msiexec is the one Windows registration form resolved explicitly into
  // System32; never rely on the working directory or PATH search for executables.
  if (_wcsicmp(executable->c_str(), L"msiexec.exe") == 0) {
    wchar_t system[MAX_PATH]{};
    const UINT count = GetSystemDirectoryW(system, ARRAYSIZE(system));
    if (!count || count >= ARRAYSIZE(system)) return false;
    *executable = std::wstring(system) + L"\\msiexec.exe";
  }
  if (!IsLocalAbsolutePath(*executable) || PathIdentity(*executable).empty() ||
      (GetFileAttributesW(executable->c_str()) & FILE_ATTRIBUTE_DIRECTORY) != 0) return false;
  *executable = CanonicalPath(*executable);
  *arguments = command.substr(end);
  return true;
}

}  // namespace

std::vector<InstalledSoftware> SoftwareService::ListInstalled() const {
  const std::vector<RegistrySoftware> registry = ReadRegistryInventory();
  std::vector<InstalledSoftware> output;
  for (std::vector<RegistrySoftware>::const_iterator row = registry.begin();
       row != registry.end(); ++row) {
    if (row->publicEntry.systemComponent) continue;
    output.push_back(row->publicEntry);
  }
  return output;
}

SoftwareCleanupPlan SoftwareService::ScanResiduals(
    const std::string& softwareId, const std::string& expectedName,
    const std::function<bool()>& cancelled) {
  const std::uint64_t generation = ++scanGeneration_;
  {
    std::lock_guard<std::mutex> lock(planMutex_);
    activePlan_ = SoftwareCleanupPlan();
  }
  ScanContext scan([this, generation, cancelled] {
    return scanGeneration_.load() != generation || (cancelled && cancelled());
  });
  const std::vector<RegistrySoftware> registry = ReadRegistryInventory([&scan] { return !scan.Continue(); });
  const RegistrySoftware* software =
      FindSoftware(registry, softwareId, expectedName);
  if (software == nullptr || software->publicEntry.systemComponent) {
    throw std::runtime_error("软件记录已经变化，请刷新列表后重试。");
  }
  SoftwareCleanupPlan plan;
  plan.token = CreatePlanToken();
  plan.softwareId = softwareId;
  plan.displayName = expectedName;
  plan.nativeCreatedTick = GetTickCount64();
  plan.nativeGeneration = generation;
  plan.residuals = BuildResiduals(*software, registry, &scan);
  scan.Continue();
  if (scan.wasCancelled) throw std::runtime_error("关联扫描已取消。");
  plan.scanTruncated = scan.truncated;
  plan.scanWarnings = scan.warnings;
  std::lock_guard<std::mutex> lock(planMutex_);
  if (scanGeneration_.load() != generation || (cancelled && cancelled()))
    throw std::runtime_error("关联扫描已取消。");
  activePlan_ = plan;
  return plan;
}

void SoftwareService::CancelScan() { ++scanGeneration_; }

SoftwareCleanupPlan SoftwareService::RefreshResiduals(const std::string& planToken) {
  const std::uint64_t generation = scanGeneration_.load();
  SoftwareCleanupPlan plan;
  {
    std::lock_guard<std::mutex> lock(planMutex_);
    if (planToken.empty() || planToken != activePlan_.token || activePlan_.nativeCreatedTick == 0)
      throw std::runtime_error("扫描计划已失效，请重新扫描。");
    plan = activePlan_;
  }
  ScanContext scan([this, generation] { return scanGeneration_.load() != generation; });
  const bool expired = !PlanCurrent(plan);
  std::vector<SoftwareResidual> remaining;
  for (const auto& residual : plan.residuals) {
    if (!scan.Continue()) break;
    if (SafelyMissing(Utf8ToWide(residual.path))) continue;
    if (RevalidateResidual(residual)) remaining.push_back(residual);
    else {
      plan.scanTruncated = true;
      const std::string warning = "部分原关联项身份变化或无法复核，已从清理计划移除。";
      if (std::find(plan.scanWarnings.begin(), plan.scanWarnings.end(), warning) == plan.scanWarnings.end())
        plan.scanWarnings.push_back(warning);
    }
  }
  scan.Continue();
  if (scan.wasCancelled) throw std::runtime_error("关联项复查已取消。");
  if (scan.truncated) throw std::runtime_error("关联项复查超时，原计划未修改，请重试。");
  plan.residuals.swap(remaining);
  if (expired) {
    plan.nativeCreatedTick = GetTickCount64();
    for (auto& residual : plan.residuals) residual.defaultSelected = false;
    plan.scanWarnings.push_back("旧授权已过期；仅复核原锁定项后续期，请重新审核选择，未增补任何路径。");
  }
  plan.nativeGeneration = generation;
  std::lock_guard<std::mutex> lock(planMutex_);
  if (generation != scanGeneration_.load() || activePlan_.token != planToken)
    throw std::runtime_error("关联项复查已取消或计划已变化。");
  activePlan_ = plan;
  return plan;
}

SoftwareOperationResult SoftwareService::RevealResidual(const std::string& planToken,
                                                       const std::string& path) {
  std::lock_guard<std::mutex> lock(planMutex_);
  SoftwareOperationResult result;
  if (planToken != activePlan_.token || !PlanCurrent(activePlan_) || activePlan_.nativeGeneration != scanGeneration_.load()) {
    result.message = "扫描计划已失效，请重新扫描后打开位置。"; return result;
  }
  for (const auto& residual : activePlan_.residuals) {
    if (residual.path != path) continue;
    PinnedCleanupPath pinned;
    if (!pinned.Lock(Utf8ToWide(path)) || !RevalidateResidual(residual)) break;
    ComScope apartment;
    PIDLIST_ABSOLUTE item = ILCreateFromPathW(Utf8ToWide(path).c_str());
    if (item) {
      result.succeeded = SUCCEEDED(SHOpenFolderAndSelectItems(item, 0, nullptr, 0));
      CoTaskMemFree(item);
    }
    result.message = result.succeeded ? "已打开文件位置。" : "无法打开此文件位置。";
    return result;
  }
  result.message = "该路径不在当前计划中或身份已变化，请重新扫描。";
  return result;
}

SoftwareOperationResult SoftwareService::LaunchRegisteredUninstaller(
    const std::string& softwareId, const std::string& expectedName,
    bool confirmed) const {
  SoftwareOperationResult result;
  if (!confirmed) {
    result.message = "启动卸载程序前必须明确确认。";
    return result;
  }
  const std::vector<RegistrySoftware> registry = ReadRegistryInventory();
  const RegistrySoftware* software =
      FindSoftware(registry, softwareId, expectedName);
  if (software == nullptr || software->publicEntry.systemComponent ||
      software->publicEntry.noRemove || software->uninstallCommand.empty()) {
    result.message = "该软件没有可安全调用的注册卸载程序。";
    return result;
  }
  if (software->uninstallCommand.size() > 8191U) {
    result.message = "卸载命令异常过长，已拒绝执行。";
    return result;
  }

  std::wstring executable, arguments;
  if (!ParseUninstallCommand(software->uninstallCommand, &executable, &arguments)) {
    result.message = "卸载命令不能解析为明确的本地 EXE，已拒绝模糊命令执行。";
    return result;
  }
  const std::wstring explicitCommand = L"\"" + executable + L"\"" + arguments;
  std::vector<wchar_t> command(explicitCommand.begin(), explicitCommand.end());
  command.push_back(L'\0');
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, FALSE, 0,
                      nullptr, nullptr, &startup, &process)) {
    result.message = "无法启动软件自带的卸载程序，可能需要管理员权限。";
    return result;
  }
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  result.succeeded = true;
  result.message = "已启动软件自带的卸载程序；完成后请返回扫描残留。";
  return result;
}

SoftwareOperationResult SoftwareService::CleanupResiduals(
    const std::string& planToken, const std::string& typedName,
    const std::vector<std::string>& selectedPaths, bool confirmed) {
  SoftwareOperationResult result;
  std::lock_guard<std::mutex> lock(planMutex_);
  if (!confirmed || !PlanCurrent(activePlan_) || activePlan_.nativeGeneration != scanGeneration_.load() ||
      planToken != activePlan_.token || typedName != activePlan_.displayName) {
    result.message = "清理需要 15 分钟内的有效扫描结果，并完整输入软件名称。";
    return result;
  }
  if (selectedPaths.empty() || selectedPaths.size() > activePlan_.residuals.size()) {
    result.message = "没有选择可清理的关联路径。";
    return result;
  }
  for (const auto& selected : selectedPaths) {
    if (std::find_if(activePlan_.residuals.begin(), activePlan_.residuals.end(),
        [&selected](const SoftwareResidual& residual) { return residual.path == selected; }) == activePlan_.residuals.end()) {
      result.message = "所选路径不完全属于当前锁定计划，未执行任何清理。";
      return result;
    }
  }
  bool stillRegistered = false;
  if (registrationCheckForTest_) stillRegistered = registrationCheckForTest_(activePlan_.softwareId);
  else {
    const auto installed = ReadRegistryInventory();
    stillRegistered = std::find_if(installed.begin(), installed.end(), [this](const RegistrySoftware& item) {
      return item.publicEntry.id == activePlan_.softwareId;
    }) != installed.end();
  }
  if (stillRegistered) {
    result.message = "软件仍在注册列表中，请先完成标准卸载；关闭或取消卸载窗口不代表卸载完成。";
    return result;
  }

  std::set<std::string> uniquePaths;
  ScanContext validation;
  for (std::vector<std::string>::const_iterator selected = selectedPaths.begin();
       selected != selectedPaths.end(); ++selected) {
    if (!uniquePaths.insert(*selected).second) continue;
    const SoftwareResidual* approved = nullptr;
    for (std::vector<SoftwareResidual>::const_iterator residual =
             activePlan_.residuals.begin();
         residual != activePlan_.residuals.end(); ++residual) {
      if (residual->path == *selected) {
        approved = &*residual;
        break;
      }
    }
    const std::wstring path = approved ? Utf8ToWide(approved->path)
                                       : std::wstring();
    if (approved == nullptr || IsProtectedCleanupPath(path) || !validation.Continue()) {
      result.failedPaths.push_back(*selected);
      continue;
    }
    if (SafelyMissing(path)) { result.removedPaths.push_back(*selected); continue; }
    PinnedCleanupPath pinned;
    if (!pinned.Lock(path) || !RevalidateResidual(*approved) ||
        !TreeSafeToRecycle(path, &validation) || !RevalidateResidual(*approved)) {
      result.failedPaths.push_back(*selected);
      continue;
    }
    if (MovePathToRecycleBin(path)) {
      result.removedPaths.push_back(*selected);
    } else {
      result.failedPaths.push_back(*selected);
    }
  }
  result.succeeded = !result.removedPaths.empty() && result.failedPaths.empty();
  if (result.failedPaths.empty()) {
    result.message = "所选残留已移入回收站，可以在误删时恢复。";
  } else if (!result.removedPaths.empty()) {
    result.message = "部分关联项已移入回收站；其余身份变化、位置不安全、复核超限或正在使用，未清理。";
  } else {
    result.message = "未能清理所选路径；其身份可能变化、包含重解析点、复核超限或正在使用，请重新扫描。";
  }
  activePlan_.residuals.erase(std::remove_if(activePlan_.residuals.begin(), activePlan_.residuals.end(),
      [&result](const SoftwareResidual& residual) {
        return std::find(result.removedPaths.begin(), result.removedPaths.end(), residual.path) != result.removedPaths.end();
      }), activePlan_.residuals.end());
  return result;
}

SoftwareCleanupPlan SoftwareServiceTestAccess::ScanShortcuts(
    const InstalledSoftware& software, const std::wstring& executable,
    const std::vector<std::wstring>& roots, const std::function<bool()>& cancelled,
    unsigned maximumDepth, unsigned maximumEntries, unsigned maximumResults) {
  RegistrySoftware registered;
  registered.publicEntry = software;
  registered.executablePath = executable;
  const ShortcutIdentity identity = BuildShortcutIdentity(registered);
  ScanContext scan(cancelled);
  scan.maximumDepth = maximumDepth;
  scan.maximumEntries = maximumEntries;
  scan.maximumResults = maximumResults;
  SoftwareCleanupPlan plan;
  plan.token = CreatePlanToken();
  plan.softwareId = software.id;
  plan.displayName = software.displayName;
  plan.nativeCreatedTick = GetTickCount64();
  for (const auto& root : roots) ScanShortcutDirectory(&plan.residuals, root, "测试快捷方式根", identity, &scan);
  scan.Continue();
  if (scan.wasCancelled) throw std::runtime_error("关联扫描已取消。");
  plan.scanTruncated = scan.truncated;
  plan.scanWarnings = scan.warnings;
  return plan;
}

bool SoftwareServiceTestAccess::Revalidate(const SoftwareResidual& residual) {
  return RevalidateResidual(residual);
}

std::wstring SoftwareServiceTestAccess::UninstallerExecutable(const std::wstring& command) {
  std::wstring executable, arguments;
  return ParseUninstallCommand(command, &executable, &arguments) ? executable : std::wstring();
}

void SoftwareServiceTestAccess::InstallPlan(SoftwareService& service, const SoftwareCleanupPlan& plan) {
  std::lock_guard<std::mutex> lock(service.planMutex_);
  service.activePlan_ = plan;
  service.activePlan_.nativeGeneration = service.scanGeneration_.load();
  service.registrationCheckForTest_ = [](const std::string&) { return false; };
}

void SoftwareServiceTestAccess::SetRegistered(SoftwareService& service, bool registered) {
  std::lock_guard<std::mutex> lock(service.planMutex_);
  service.registrationCheckForTest_ = [registered](const std::string&) { return registered; };
}

bool SoftwareServiceTestAccess::ProductNameMatches(const InstalledSoftware& software,
    const std::wstring& executable, const std::wstring& directoryName) {
  RegistrySoftware registered; registered.publicEntry = software; registered.executablePath = executable;
  return MatchAlias(directoryName, BuildIdentity(registered).product) != nullptr;
}

bool SoftwareServiceTestAccess::SharedDirectory(const std::wstring& directory,
    const std::vector<std::wstring>& otherLocations) {
  return ContainsOtherSoftwareLocation(directory, otherLocations);
}

bool SoftwareServiceTestAccess::CanSafelyCleanup(const SoftwareResidual& residual) {
  PinnedCleanupPath pinned; ScanContext scan;
  const std::wstring path = Utf8ToWide(residual.path);
  if (!pinned.Lock(path)) throw std::runtime_error("positive cleanup pin failed: " + std::to_string(GetLastError()) + " " + WideToUtf8(pinned.ErrorPath()));
  if (!RevalidateResidual(residual)) throw std::runtime_error("positive cleanup identity failed: " + std::to_string(GetLastError()));
  if (!TreeSafeToRecycle(path, &scan)) throw std::runtime_error("positive cleanup tree failed: " + std::to_string(GetLastError()));
  return true;
}

}  // namespace milo
