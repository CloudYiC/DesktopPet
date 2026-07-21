#pragma once

#include <cstdint>
#include <string>

namespace milo {

std::string WideToUtf8(const std::wstring& value);
std::wstring Utf8ToWide(const std::string& value);
std::wstring ExecutableDirectory();
std::wstring AppDataDirectory();
std::int64_t UnixTimeMilliseconds();

}  // namespace milo

