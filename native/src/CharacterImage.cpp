#include "Milo/CharacterImage.h"

#include <windows.h>
#include <wincrypt.h>

#include <stdexcept>
#include <utility>

namespace milo {

DecodedCharacterImage DecodeCharacterImage(const std::string& dataUrl) {
  constexpr std::size_t kMaximumImageBytes = 4U * 1024U * 1024U;
  constexpr const char* kPngPrefix = "data:image/png;base64,";
  constexpr const char* kWebpPrefix = "data:image/webp;base64,";

  std::string extension;
  std::size_t prefixLength = 0;
  if (dataUrl.rfind(kPngPrefix, 0) == 0) {
    extension = ".png";
    prefixLength = std::char_traits<char>::length(kPngPrefix);
  } else if (dataUrl.rfind(kWebpPrefix, 0) == 0) {
    extension = ".webp";
    prefixLength = std::char_traits<char>::length(kWebpPrefix);
  } else {
    throw std::runtime_error("角色图片只支持 PNG 或 WebP。");
  }

  const std::string encoded = dataUrl.substr(prefixLength);
  if (encoded.empty() || encoded.size() > kMaximumImageBytes * 2U) {
    throw std::runtime_error("角色图片不能超过 4 MB。");
  }

  // Query the decoded size before allocating; the encoded-length check above is
  // only an inexpensive first guard and is not trusted as the final limit.
  DWORD decodedSize = 0;
  if (!CryptStringToBinaryA(encoded.c_str(), static_cast<DWORD>(encoded.size()),
                            CRYPT_STRING_BASE64, nullptr, &decodedSize,
                            nullptr, nullptr) ||
      decodedSize == 0 || decodedSize > kMaximumImageBytes) {
    throw std::runtime_error("角色图片数据无效或超过 4 MB。");
  }

  std::vector<unsigned char> bytes(decodedSize);
  if (!CryptStringToBinaryA(encoded.c_str(), static_cast<DWORD>(encoded.size()),
                            CRYPT_STRING_BASE64, bytes.data(), &decodedSize,
                            nullptr, nullptr)) {
    throw std::runtime_error("无法读取角色图片。");
  }
  bytes.resize(decodedSize);

  // The MIME prefix is supplied by the WebView and therefore untrusted. Verify
  // the container signature before the bytes are persisted or served back.
  const bool validPng =
      extension == ".png" && bytes.size() >= 8 &&
      bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4e &&
      bytes[3] == 0x47 && bytes[4] == 0x0d && bytes[5] == 0x0a &&
      bytes[6] == 0x1a && bytes[7] == 0x0a;
  const bool validWebp =
      extension == ".webp" && bytes.size() >= 12 &&
      bytes[0] == 'R' && bytes[1] == 'I' && bytes[2] == 'F' &&
      bytes[3] == 'F' && bytes[8] == 'W' && bytes[9] == 'E' &&
      bytes[10] == 'B' && bytes[11] == 'P';
  if (!validPng && !validWebp) {
    throw std::runtime_error("图片内容与文件格式不一致。");
  }
  return {extension, std::move(bytes)};
}

}  // namespace milo
