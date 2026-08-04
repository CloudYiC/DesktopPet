#include "Milo/Utils.h"

#include <windows.h>
#include <shlobj.h>

#include <chrono>
#include <limits>
#include <stdexcept>
#include <vector>

namespace milo {

std::string WideToUtf8(const std::wstring& value) {
  if (value.empty()) {
    return {};
  }

  const int size = WideCharToMultiByte(CP_UTF8, 0, value.data(),
                                       static_cast<int>(value.size()), nullptr,
                                       0, nullptr, nullptr);
  if (size <= 0) {
    throw std::runtime_error("Unable to convert UTF-16 text to UTF-8.");
  }

  std::string result(static_cast<std::size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()),
                      &result[0], size, nullptr, nullptr);
  return result;
}

std::wstring Utf8ToWide(const std::string& value) {
  if (value.empty()) {
    return {};
  }

  const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                       value.data(),
                                       static_cast<int>(value.size()), nullptr, 0);
  if (size <= 0) {
    throw std::runtime_error("Unable to convert UTF-8 text to UTF-16.");
  }

  std::wstring result(static_cast<std::size_t>(size), L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                      static_cast<int>(value.size()), &result[0], size);
  return result;
}

std::wstring JoinPath(const std::wstring& directory,
                      const std::wstring& child) {
  if (directory.empty()) {
    return child;
  }
  const wchar_t last = directory[directory.size() - 1];
  if (last == L'\\' || last == L'/') {
    return directory + child;
  }
  return directory + L"\\" + child;
}

bool PathExists(const std::wstring& path) {
  return GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES;
}

void EnsureDirectory(const std::wstring& path) {
  const int result = SHCreateDirectoryExW(nullptr, path.c_str(), nullptr);
  if (result != ERROR_SUCCESS && result != ERROR_FILE_EXISTS &&
      result != ERROR_ALREADY_EXISTS) {
    throw std::runtime_error("Unable to create the application directory.");
  }
  const DWORD attributes = GetFileAttributesW(path.c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES ||
      (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
    throw std::runtime_error("The application directory path is not valid.");
  }
}

void WriteBinaryFile(const std::wstring& path, const void* data,
                     std::size_t size) {
  HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr,
                            CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) {
    throw std::runtime_error("Unable to create the output file.");
  }

  const unsigned char* cursor = static_cast<const unsigned char*>(data);
  std::size_t remaining = size;
  bool succeeded = true;
  while (remaining > 0) {
    const std::size_t maximum =
        static_cast<std::size_t>((std::numeric_limits<DWORD>::max)());
    const DWORD chunk = static_cast<DWORD>(remaining > maximum ? maximum
                                                               : remaining);
    DWORD written = 0;
    if (!WriteFile(file, cursor, chunk, &written, nullptr) ||
        written != chunk) {
      succeeded = false;
      break;
    }
    cursor += written;
    remaining -= written;
  }
  if (succeeded && !FlushFileBuffers(file)) {
    succeeded = false;
  }
  CloseHandle(file);

  if (!succeeded) {
    DeleteFileW(path.c_str());
    throw std::runtime_error("Unable to write the complete output file.");
  }
}

void MoveFileReplacing(const std::wstring& source,
                       const std::wstring& destination) {
  if (!MoveFileExW(source.c_str(), destination.c_str(),
                   MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
    throw std::runtime_error("Unable to move the completed file.");
  }
}

void DeleteFileIfExists(const std::wstring& path) {
  if (DeleteFileW(path.c_str())) {
    return;
  }
  const DWORD error = GetLastError();
  if (error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND) {
    throw std::runtime_error("Unable to delete the file.");
  }
}

bool IsSimpleFileName(const std::wstring& value) {
  if (value.empty() || value == L"." || value == L".." ||
      value.find_first_of(L"<>:\"/\\|?*") != std::wstring::npos) {
    return false;
  }
  const wchar_t last = value[value.size() - 1];
  return last != L'.' && last != L' ';
}

std::wstring ExecutableDirectory() {
  // Windows does not expose the required buffer length up front, so grow until
  // GetModuleFileNameW returns an untruncated path.
  std::vector<wchar_t> buffer(512);
  for (;;) {
    const DWORD length = GetModuleFileNameW(nullptr, buffer.data(),
                                            static_cast<DWORD>(buffer.size()));
    if (length == 0) {
      throw std::runtime_error("Unable to locate the executable directory.");
    }
    if (length < buffer.size() - 1) {
      const std::wstring executablePath(buffer.data(),
                                        static_cast<std::size_t>(length));
      const std::wstring::size_type separator =
          executablePath.find_last_of(L"\\/");
      if (separator == std::wstring::npos) {
        throw std::runtime_error("Unable to locate the executable directory.");
      }
      return executablePath.substr(0, separator);
    }
    buffer.resize(buffer.size() * 2);
  }
}

std::wstring AppDataDirectory() {
  PWSTR rawPath = nullptr;
  const HRESULT result =
      SHGetKnownFolderPath(FOLDERID_LocalAppData, KF_FLAG_CREATE, nullptr,
                           &rawPath);
  if (FAILED(result) || rawPath == nullptr) {
    throw std::runtime_error("Unable to locate LocalAppData.");
  }

  const std::wstring localAppData(rawPath);
  const std::wstring path = JoinPath(localAppData, L"CuteYiyiDesktopPet");
  const std::wstring legacyPath = JoinPath(localAppData, L"MiloDesktopPet");
  CoTaskMemFree(rawPath);
  EnsureDirectory(path);

  // Migration is intentionally copy-only: an interrupted upgrade must not
  // destroy data that an older installed version can still read.
  const auto copyIfMissing = [&path, &legacyPath](
                                 const wchar_t* legacyName,
                                 const wchar_t* currentName) {
    const std::wstring source = JoinPath(legacyPath, legacyName);
    const std::wstring destination = JoinPath(path, currentName);
    if (PathExists(source) && !PathExists(destination)) {
      CopyFileW(source.c_str(), destination.c_str(), TRUE);
    }
  };

  // A SQLite database and its WAL belong to the same snapshot. Only migrate
  // the legacy pair when the current database has never been created.
  // Copying an old WAL later (for example after a clean checkpoint removes the
  // current WAL) can replay stale settings over newly saved values.
  const std::wstring currentDatabase = JoinPath(path, L"yiyi.db");
  const std::wstring legacyDatabase = JoinPath(legacyPath, L"milo.db");
  if (!PathExists(currentDatabase) && PathExists(legacyDatabase)) {
    copyIfMissing(L"milo.db", L"yiyi.db");
    copyIfMissing(L"milo.db-wal", L"yiyi.db-wal");
  }
  copyIfMissing(L"onboarding.complete", L"onboarding.complete");

  return path;
}

std::int64_t UnixTimeMilliseconds() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

}  // namespace milo
