#pragma once

/// @file
/// @brief Encoding, path and time helpers shared by the native application.

#include <cstdint>
#include <cstddef>
#include <string>

namespace milo {

/// Converts UTF-16 Windows text to UTF-8.
std::string WideToUtf8(const std::wstring& value);
/// Converts UTF-8 text to UTF-16 Windows text.
std::wstring Utf8ToWide(const std::string& value);
/// Joins two Windows path segments with exactly one directory separator.
std::wstring JoinPath(const std::wstring& directory,
                      const std::wstring& child);
/// Returns true when a file or directory exists at the supplied path.
bool PathExists(const std::wstring& path);
/// Creates a directory and any missing parents.
void EnsureDirectory(const std::wstring& path);
/// Writes a complete binary payload, replacing any existing file.
void WriteBinaryFile(const std::wstring& path, const void* data,
                     std::size_t size);
/// Moves a file atomically enough for application-level persistence.
void MoveFileReplacing(const std::wstring& source,
                       const std::wstring& destination);
/// Deletes a file when present and ignores a missing-file result.
void DeleteFileIfExists(const std::wstring& path);
/// Returns true for a filename with no directory or reserved path characters.
bool IsSimpleFileName(const std::wstring& value);
/// Returns the directory containing the running executable.
std::wstring ExecutableDirectory();
/// Returns the private app-data directory and performs one-time legacy migration.
std::wstring AppDataDirectory();
/// Returns the current Unix epoch time in milliseconds.
std::int64_t UnixTimeMilliseconds();

}  // namespace milo
