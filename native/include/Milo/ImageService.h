#pragma once

/// @file
/// @brief Validates and saves image exports produced by the local React canvas.

#include <windows.h>

#include <cstdint>
#include <string>

namespace milo {

struct ImageSaveResult {
  bool cancelled{};
  std::string path;
  std::uint64_t sizeBytes{};
};

/// Opens a native save dialog and writes a validated PNG/JPEG/WebP/ICO image.
ImageSaveResult SaveExportedImage(HWND owner, const std::string& dataUrl,
                                  const std::string& format,
                                  const std::string& suggestedBaseName);

}  // namespace milo
