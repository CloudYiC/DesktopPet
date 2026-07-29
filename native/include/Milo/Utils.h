#pragma once

/// @file
/// @brief Encoding, path and time helpers shared by the native application.

#include <cstdint>
#include <string>

namespace milo {

/// Converts UTF-16 Windows text to UTF-8.
std::string WideToUtf8(const std::wstring& value);
/// Converts UTF-8 text to UTF-16 Windows text.
std::wstring Utf8ToWide(const std::string& value);
/// Returns the directory containing the running executable.
std::wstring ExecutableDirectory();
/// Returns the private app-data directory and performs one-time legacy migration.
std::wstring AppDataDirectory();
/// Returns the current Unix epoch time in milliseconds.
std::int64_t UnixTimeMilliseconds();

}  // namespace milo
