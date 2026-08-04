#include "Milo/SoftwareService.h"

#include <windows.h>
#include <bcrypt.h>
#include <shellapi.h>
#include <shlobj.h>
#include <winver.h>

#include <algorithm>
#include <cwctype>
#include <set>
#include <sstream>
#include <stdexcept>
#include <vector>

#include "Milo/Utils.h"
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
};

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

std::vector<RegistrySoftware> ReadRegistryInventory() {
  std::vector<RegistrySoftware> entries;
  InventoryContext context = {&entries};
  if (!cy_enumerate_installed_software(AppendInventoryEntry, &context)) {
    throw std::runtime_error("无法读取 Windows 已安装软件列表。");
  }
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
    if (!root.empty() && SamePath(canonical, root)) return true;
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
                 DWORD startedAt) {
  if (measure->items >= 100000U || GetTickCount() - startedAt > 1800U) {
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
    MeasurePath(path + L"\\" + item.cFileName, measure, startedAt);
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
                 bool personalData) {
  const std::wstring path = CanonicalPath(TrimPath(rawPath));
  if (!CleanupPathExists(path) || IsProtectedCleanupPath(path)) return;
  for (std::vector<SoftwareResidual>::const_iterator row = output->begin();
       row != output->end(); ++row) {
    if (SamePath(Utf8ToWide(row->path), path)) return;
  }
  TreeMeasure measure;
  MeasurePath(path, &measure, GetTickCount());
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
  if (executable.empty()) return std::wstring();
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
  AddIdentityVariants(&identity.product,
                      LeafName(Utf8ToWide(software.publicEntry.installLocation)),
                      "与已验证安装目录名称匹配", "high");
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
                                                 bool includeShortcuts) {
  std::vector<DirectoryEntry> output;
  if (root.empty()) return output;
  WIN32_FIND_DATAW item{};
  HANDLE search = FindFirstFileW((root + L"\\*").c_str(), &item);
  if (search == INVALID_HANDLE_VALUE) return output;
  do {
    if (wcscmp(item.cFileName, L".") == 0 ||
        wcscmp(item.cFileName, L"..") == 0 ||
        (item.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
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
  FindClose(search);
  return output;
}

void ScanIdentityRoot(std::vector<SoftwareResidual>* output,
                      const std::wstring& root, const std::string& label,
                      const std::string& kind, bool personalData,
                      bool includeShortcuts,
                      const std::vector<IdentityAlias>& productAliases) {
  const std::vector<DirectoryEntry> entries =
      ListDirectoryEntries(root, includeShortcuts);
  for (std::vector<DirectoryEntry>::const_iterator entry = entries.begin();
       entry != entries.end() && output->size() < 40U; ++entry) {
    const std::wstring candidateName = entry->directory
                                           ? entry->name
                                           : StemName(entry->name);
    const IdentityAlias* alias = MatchAlias(candidateName, productAliases);
    if (alias == nullptr) continue;
    const std::string evidence = alias->evidence + "；限定目录精确命中";
    const bool defaultSelected =
        kind == "shortcut" && alias->confidence == "high";
    AddResidual(output, entry->path, label, kind, evidence,
                alias->confidence, defaultSelected, personalData);
  }
}

void ScanPublisherChildren(
    std::vector<SoftwareResidual>* output, const std::wstring& root,
    const std::string& label, const std::string& kind, bool personalData,
    const SoftwareIdentity& identity) {
  const std::vector<DirectoryEntry> publishers =
      ListDirectoryEntries(root, false);
  for (std::vector<DirectoryEntry>::const_iterator publisher =
           publishers.begin();
       publisher != publishers.end() && output->size() < 40U; ++publisher) {
    if (!publisher->directory ||
        MatchAlias(publisher->name, identity.publisher) == nullptr) {
      continue;
    }
    const std::vector<DirectoryEntry> children =
        ListDirectoryEntries(publisher->path, kind == "shortcut");
    for (std::vector<DirectoryEntry>::const_iterator child = children.begin();
         child != children.end() && output->size() < 40U; ++child) {
      const std::wstring candidateName = child->directory
                                             ? child->name
                                             : StemName(child->name);
      const IdentityAlias* alias = MatchAlias(candidateName, identity.product);
      if (alias == nullptr) continue;
      const bool defaultSelected =
          kind == "shortcut" && alias->confidence == "high";
      AddResidual(output, child->path, label, kind,
                  alias->evidence + "；发布者目录下精确命中",
                  alias->confidence, defaultSelected, personalData);
    }
  }
}

std::vector<SoftwareResidual> BuildResiduals(
    const RegistrySoftware& registrySoftware) {
  const InstalledSoftware& software = registrySoftware.publicEntry;
  std::vector<SoftwareResidual> output;
  const SoftwareIdentity identity = BuildIdentity(registrySoftware);
  const std::wstring registeredLocation = Utf8ToWide(software.installLocation);
  const bool standardProgramPath = IsTrustedProgramPath(registeredLocation);
  if (standardProgramPath || software.installLocationInferred) {
    AddResidual(&output, registeredLocation,
                software.installLocationInferred
                    ? "由注册程序文件确认的安装目录"
                    : "注册安装目录",
                "program",
                software.installLocationInferred
                    ? "DisplayIcon 或 UninstallString 指向该目录内现存 EXE"
                    : "Windows 卸载项直接提供 InstallLocation",
                "high", true, false);
  }

  const std::wstring profile = KnownFolder(FOLDERID_Profile);
  const std::wstring roaming = KnownFolder(FOLDERID_RoamingAppData);
  const std::wstring local = KnownFolder(FOLDERID_LocalAppData);
  const std::wstring programData = KnownFolder(FOLDERID_ProgramData);
  const std::wstring programs = KnownFolder(FOLDERID_Programs);
  const std::wstring commonPrograms = KnownFolder(FOLDERID_CommonPrograms);
  ScanIdentityRoot(&output, profile, "用户配置目录", "personal", true,
                   false, identity.product);
  ScanIdentityRoot(&output, local, "本地应用数据", "personal", true, false,
                   identity.product);
  ScanIdentityRoot(&output, roaming, "漫游应用数据", "personal", true,
                   false, identity.product);
  ScanIdentityRoot(&output, programData, "所有用户共享数据", "personal",
                   true, false, identity.product);
  ScanIdentityRoot(&output, local + L"\\Programs", "当前用户程序目录",
                   "program", false, false, identity.product);
  ScanPublisherChildren(&output, local, "发布者目录内的本地数据",
                        "personal", true, identity);
  ScanPublisherChildren(&output, roaming, "发布者目录内的漫游数据",
                        "personal", true, identity);
  ScanPublisherChildren(&output, programData, "发布者目录内的共享数据",
                        "personal", true, identity);
  ScanIdentityRoot(&output, programs, "当前用户开始菜单项", "shortcut",
                   false, true, identity.product);
  ScanIdentityRoot(&output, commonPrograms, "所有用户开始菜单项",
                   "shortcut", false, true, identity.product);
  ScanPublisherChildren(&output, programs, "发布者开始菜单目录", "shortcut",
                        false, identity);
  ScanPublisherChildren(&output, commonPrograms, "发布者开始菜单目录",
                        "shortcut", false, identity);
  return output;
}

bool MovePathToRecycleBin(const std::wstring& path) {
  std::vector<wchar_t> doubleTerminated(path.begin(), path.end());
  doubleTerminated.push_back(L'\0');
  doubleTerminated.push_back(L'\0');
  SHFILEOPSTRUCTW operation{};
  operation.wFunc = FO_DELETE;
  operation.pFrom = doubleTerminated.data();
  operation.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT |
                     FOF_NOERRORUI;
  const int status = SHFileOperationW(&operation);
  return status == 0 && !operation.fAnyOperationsAborted &&
         !CleanupPathExists(path);
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
    const std::string& softwareId, const std::string& expectedName) {
  const std::vector<RegistrySoftware> registry = ReadRegistryInventory();
  const RegistrySoftware* software =
      FindSoftware(registry, softwareId, expectedName);
  if (software == nullptr || software->publicEntry.systemComponent) {
    throw std::runtime_error("软件记录已经变化，请刷新列表后重试。");
  }
  activePlan_ = SoftwareCleanupPlan();
  activePlan_.token = CreatePlanToken();
  activePlan_.softwareId = softwareId;
  activePlan_.displayName = expectedName;
  activePlan_.residuals = BuildResiduals(*software);
  return activePlan_;
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

  std::vector<wchar_t> command(software->uninstallCommand.begin(),
                               software->uninstallCommand.end());
  command.push_back(L'\0');
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE, 0,
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
  if (!confirmed || activePlan_.token.empty() ||
      planToken != activePlan_.token || typedName != activePlan_.displayName) {
    result.message = "彻底清理需要有效扫描结果并完整输入软件名称。";
    return result;
  }
  if (selectedPaths.empty() || selectedPaths.size() > activePlan_.residuals.size()) {
    result.message = "没有选择可清理的关联路径。";
    return result;
  }

  std::set<std::string> uniquePaths;
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
    if (approved == nullptr || IsProtectedCleanupPath(path)) {
      result.failedPaths.push_back(*selected);
      continue;
    }
    if (!CleanupPathExists(path) || MovePathToRecycleBin(path)) {
      result.removedPaths.push_back(*selected);
    } else {
      result.failedPaths.push_back(*selected);
    }
  }
  result.succeeded = !result.removedPaths.empty() && result.failedPaths.empty();
  if (result.failedPaths.empty()) {
    result.message = "所选残留已移入回收站，可以在误删时恢复。";
  } else if (!result.removedPaths.empty()) {
    result.message = "部分残留已移入回收站；其余路径可能正在使用或需要管理员权限。";
  } else {
    result.message = "未能清理所选路径；请关闭相关进程或使用管理员权限重试。";
  }
  if (result.failedPaths.empty()) activePlan_ = SoftwareCleanupPlan();
  return result;
}

}  // namespace milo
