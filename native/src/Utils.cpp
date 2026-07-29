#include "Milo/Utils.h"

#include <windows.h>
#include <shlobj.h>

#include <chrono>
#include <filesystem>
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
                      result.data(), size, nullptr, nullptr);
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
                      static_cast<int>(value.size()), result.data(), size);
  return result;
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
      return std::filesystem::path(
                 std::wstring(buffer.data(), static_cast<std::size_t>(length)))
          .parent_path()
          .wstring();
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

  const std::filesystem::path localAppData(rawPath);
  const std::filesystem::path path = localAppData / L"CuteYiyiDesktopPet";
  const std::filesystem::path legacyPath = localAppData / L"MiloDesktopPet";
  CoTaskMemFree(rawPath);
  std::filesystem::create_directories(path);

  // Migration is intentionally copy-only: an interrupted upgrade must not
  // destroy data that an older installed version can still read.
  const auto copyIfMissing = [&path, &legacyPath](
                                 const wchar_t* legacyName,
                                 const wchar_t* currentName) {
    std::error_code error;
    const std::filesystem::path source = legacyPath / legacyName;
    const std::filesystem::path destination = path / currentName;
    if (std::filesystem::exists(source, error) &&
        !std::filesystem::exists(destination, error)) {
      std::filesystem::copy_file(source, destination,
                                 std::filesystem::copy_options::skip_existing,
                                 error);
    }
  };

  // A SQLite database and its WAL belong to the same snapshot. Only migrate
  // the legacy pair when the current database has never been created.
  // Copying an old WAL later (for example after a clean checkpoint removes the
  // current WAL) can replay stale settings over newly saved values.
  std::error_code databaseError;
  const std::filesystem::path currentDatabase = path / L"yiyi.db";
  const std::filesystem::path legacyDatabase = legacyPath / L"milo.db";
  if (!std::filesystem::exists(currentDatabase, databaseError) &&
      std::filesystem::exists(legacyDatabase, databaseError)) {
    copyIfMissing(L"milo.db", L"yiyi.db");
    copyIfMissing(L"milo.db-wal", L"yiyi.db-wal");
  }
  copyIfMissing(L"onboarding.complete", L"onboarding.complete");

  return path.wstring();
}

std::int64_t UnixTimeMilliseconds() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

}  // namespace milo
