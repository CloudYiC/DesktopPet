#pragma once

/// @file
/// @brief Validation and decoding for character images uploaded by React.

#include <string>
#include <vector>

namespace milo {

/// Validated bytes and normalized extension for a character image.
struct DecodedCharacterImage {
  std::string extension;
  std::vector<unsigned char> bytes;
};

/// Decodes a PNG/WebP data URL and rejects oversized or malformed content.
/// @throws std::runtime_error when the input is unsafe or unsupported.
DecodedCharacterImage DecodeCharacterImage(const std::string& dataUrl);

}  // namespace milo
