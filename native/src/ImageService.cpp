#include "Milo/ImageService.h"

#include <windows.h>
#include <wincrypt.h>

#include <algorithm>
#include <cctype>
#include <stdexcept>
#include <vector>

#include "Milo/Utils.h"
#include "cloudyi/file_dialog.h"
#include "cloudyi/icon_file.h"

namespace milo {
namespace {

const std::size_t kMaximumExportBytes = 32U * 1024U * 1024U;

std::vector<unsigned char> DecodeBase64(const std::string& encoded) {
  if (encoded.empty() || encoded.size() > kMaximumExportBytes * 2U) {
    throw std::runtime_error("转换后的图片过大，请降低尺寸或质量。");
  }
  DWORD size = 0;
  if (!CryptStringToBinaryA(encoded.c_str(), static_cast<DWORD>(encoded.size()),
                            CRYPT_STRING_BASE64, nullptr, &size, nullptr,
                            nullptr) ||
      size == 0 || size > kMaximumExportBytes) {
    throw std::runtime_error("转换后的图片数据无效或超过 32 MB。");
  }
  std::vector<unsigned char> bytes(size);
  if (!CryptStringToBinaryA(encoded.c_str(), static_cast<DWORD>(encoded.size()),
                            CRYPT_STRING_BASE64, bytes.data(), &size, nullptr,
                            nullptr)) {
    throw std::runtime_error("无法解码转换后的图片。");
  }
  bytes.resize(size);
  return bytes;
}

bool StartsWith(const std::vector<unsigned char>& bytes,
                const unsigned char* signature, std::size_t length) {
  return bytes.size() >= length &&
         std::equal(signature, signature + length, bytes.begin());
}

std::string RequiredPrefix(const std::string& format) {
  if (format == "png" || format == "ico") return "data:image/png;base64,";
  if (format == "jpeg") return "data:image/jpeg;base64,";
  if (format == "webp") return "data:image/webp;base64,";
  throw std::runtime_error("不支持这个图片输出格式。");
}

std::wstring SafeSuggestedName(const std::string& value,
                               const std::string& format) {
  std::string safe;
  for (std::string::const_iterator character = value.begin();
       character != value.end(); ++character) {
    const unsigned char byte = static_cast<unsigned char>(*character);
    if (byte < 0x20 || *character == '\\' || *character == '/' ||
        *character == ':' || *character == '*' || *character == '?' ||
        *character == '"' || *character == '<' || *character == '>' ||
        *character == '|') {
      continue;
    }
    safe.push_back(*character);
  }
  if (safe.empty()) safe = "converted-image";
  std::wstring wideName = Utf8ToWide(safe);
  if (wideName.size() > 80) wideName.resize(80);
  const std::string extension = format == "jpeg" ? ".jpg" : "." + format;
  return wideName + Utf8ToWide(extension);
}

std::wstring RequiredExtension(const std::string& format) {
  return Utf8ToWide(format == "jpeg" ? ".jpg" : "." + format);
}

bool EndsWithIgnoringCase(const std::wstring& value,
                          const std::wstring& suffix) {
  if (value.size() < suffix.size()) return false;
  return _wcsicmp(value.c_str() + value.size() - suffix.size(),
                  suffix.c_str()) == 0;
}

std::uint64_t FileSize(const std::wstring& path) {
  WIN32_FILE_ATTRIBUTE_DATA attributes{};
  if (!GetFileAttributesExW(path.c_str(), GetFileExInfoStandard, &attributes)) {
    return 0;
  }
  ULARGE_INTEGER size{};
  size.HighPart = attributes.nFileSizeHigh;
  size.LowPart = attributes.nFileSizeLow;
  return size.QuadPart;
}

}  // namespace

ImageSaveResult SaveExportedImage(HWND owner, const std::string& dataUrl,
                                  const std::string& format,
                                  const std::string& suggestedBaseName) {
  if (suggestedBaseName.size() > 512) {
    throw std::runtime_error("建议的图片文件名过长。");
  }
  const std::string prefix = RequiredPrefix(format);
  if (dataUrl.compare(0, prefix.size(), prefix) != 0) {
    throw std::runtime_error("图片内容与所选输出格式不一致。");
  }
  const std::vector<unsigned char> bytes =
      DecodeBase64(dataUrl.substr(prefix.size()));
  static const unsigned char pngSignature[] =
      {0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a};
  static const unsigned char jpegSignature[] = {0xff, 0xd8, 0xff};
  const bool valid = (format == "png" || format == "ico")
                         ? StartsWith(bytes, pngSignature, sizeof(pngSignature))
                     : format == "jpeg"
                         ? StartsWith(bytes, jpegSignature, sizeof(jpegSignature))
                         : bytes.size() >= 12 && bytes[0] == 'R' &&
                               bytes[1] == 'I' && bytes[2] == 'F' &&
                               bytes[3] == 'F' && bytes[8] == 'W' &&
                               bytes[9] == 'E' && bytes[10] == 'B' &&
                               bytes[11] == 'P';
  if (!valid) throw std::runtime_error("图片签名校验失败。");

  wchar_t destination[32768]{};
  const std::wstring wideFormat = Utf8ToWide(format);
  const std::wstring suggested = SafeSuggestedName(suggestedBaseName, format);
  const int picked = cy_pick_image_destination(
      owner, wideFormat.c_str(), suggested.c_str(), destination,
      ARRAYSIZE(destination));
  if (picked == 0) return {true, std::string{}, 0};
  if (picked < 0) throw std::runtime_error("无法打开图片保存窗口。");

  std::wstring outputPath(destination);
  const std::wstring extension = RequiredExtension(format);
  if (!EndsWithIgnoringCase(outputPath, extension) &&
      !(format == "jpeg" && EndsWithIgnoringCase(outputPath, L".jpeg"))) {
    outputPath += extension;
  }
  const std::wstring temporaryPath = outputPath + L".converting";
  if (format == "ico") {
    if (!cy_write_png_icon(temporaryPath.c_str(), bytes.data(), bytes.size())) {
      throw std::runtime_error("无法生成 Windows ICO 文件。");
    }
  } else {
    WriteBinaryFile(temporaryPath, bytes.data(), bytes.size());
  }
  try {
    MoveFileReplacing(temporaryPath, outputPath);
  } catch (...) {
    DeleteFileW(temporaryPath.c_str());
    throw;
  }
  return {false, WideToUtf8(outputPath), FileSize(outputPath)};
}

}  // namespace milo
