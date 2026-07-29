#include <iostream>
#include <stdexcept>
#include <string>

#include "Milo/CharacterImage.h"

namespace {

/** Asserts that untrusted image input is rejected with a validation error. */
void ExpectRejected(const std::string& dataUrl) {
  try {
    static_cast<void>(milo::DecodeCharacterImage(dataUrl));
  } catch (const std::runtime_error&) {
    return;
  }
  throw std::runtime_error("Invalid character image was accepted.");
}

}  // namespace

int main() {
  try {
    // Small signature-only fixtures keep the unit test deterministic.
    const auto png = milo::DecodeCharacterImage(
        "data:image/png;base64,iVBORw0KGgo=");
    if (png.extension != ".png" || png.bytes.size() != 8) {
      throw std::runtime_error("PNG character image was decoded incorrectly.");
    }

    const auto webp = milo::DecodeCharacterImage(
        "data:image/webp;base64,UklGRgAAAABXRUJQ");
    if (webp.extension != ".webp" || webp.bytes.size() != 12) {
      throw std::runtime_error("WebP character image was decoded incorrectly.");
    }

    // Reject unsupported MIME types, mismatched signatures, and invalid Base64.
    ExpectRejected("data:image/jpeg;base64,iVBORw0KGgo=");
    ExpectRejected("data:image/png;base64,UklGRgAAAABXRUJQ");
    ExpectRejected("data:image/png;base64,not-base64");
    std::cout << "Character image validation tests passed.\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
