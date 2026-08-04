#include "Milo/ToolService.h"

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cctype>
#include <cstddef>
#include <cstdlib>
#include <limits>
#include <sstream>
#include <vector>

#include <windows.h>
#include <bcrypt.h>

#include "Milo/Utils.h"
#include "cloudyi/base64.h"
#include "cloudyi/hex.h"
#include "cloudyi/md5.h"
#include "cloudyi/sha256.h"
#include "cloudyi/store_tools.h"
#include "cloudyi/url_encode.h"

namespace milo {
namespace {

const std::size_t kMaximumInputBytes = 1024U * 1024U;
const unsigned char kEmptyByte = 0;

const unsigned char* BytesOf(const std::string& input) {
  return input.empty()
             ? &kEmptyByte
             : reinterpret_cast<const unsigned char*>(input.data());
}

ToolExecutionResult Success(const char* data, std::size_t size) {
  ToolExecutionResult result;
  result.succeeded = true;
  result.output.assign(data, size);
  return result;
}

ToolExecutionResult Failure(const std::string& error) {
  ToolExecutionResult result;
  result.error = error;
  return result;
}

bool IsUtf8(const std::string& text) {
  try {
    Utf8ToWide(text);
    return true;
  } catch (...) {
    return false;
  }
}

bool ParseInteger(const std::string& input, long long* value) {
  if (!value || input.empty()) return false;
  char* end = nullptr;
  errno = 0;
  const long long parsed = std::strtoll(input.c_str(), &end, 10);
  if (errno == ERANGE || end == input.c_str()) return false;
  while (*end && std::isspace(static_cast<unsigned char>(*end))) ++end;
  if (*end) return false;
  *value = parsed;
  return true;
}

bool FillSecureRandom(std::vector<unsigned char>* bytes) {
  if (!bytes || bytes->empty()) return bytes != nullptr;
  if (bytes->size() > static_cast<std::size_t>((std::numeric_limits<ULONG>::max)())) {
    return false;
  }
  return BCryptGenRandom(nullptr, bytes->data(),
                         static_cast<ULONG>(bytes->size()),
                         BCRYPT_USE_SYSTEM_PREFERRED_RNG) >= 0;
}

ToolExecutionResult EncodeBase64(const std::string& input, bool urlSafe,
                                 bool padded) {
  const std::size_t capacity =
      (std::max)(std::size_t{1}, cy_base64_encode_max_size(input.size()));
  std::vector<char> output(capacity);
  const long written = cy_base64_encode(
      BytesOf(input), input.size(), output.data(), output.size(),
      urlSafe ? 1 : 0, padded ? 1 : 0);
  return written < 0
             ? Failure("Base64 编码失败，请检查输入内容。")
             : Success(output.data(), static_cast<std::size_t>(written));
}

ToolExecutionResult DecodeBase64(const std::string& input) {
  const std::size_t capacity =
      (std::max)(std::size_t{1}, cy_base64_decode_max_size(input.size()));
  std::vector<unsigned char> output(capacity);
  const long written = cy_base64_decode(input.empty() ? "" : input.data(),
                                        input.size(), output.data(),
                                        output.size());
  if (written < 0) {
    return Failure("Base64 内容格式不正确。");
  }
  const std::string text(reinterpret_cast<const char*>(output.data()),
                         static_cast<std::size_t>(written));
  return IsUtf8(text) ? Success(text.data(), text.size())
                      : Failure("解码结果不是 UTF-8 文本，二进制模式将在后续版本提供。");
}

ToolExecutionResult EncodeHex(const std::string& input) {
  const std::size_t capacity =
      (std::max)(std::size_t{1}, cy_hex_encode_size(input.size()));
  std::vector<char> output(capacity);
  const long written = cy_hex_encode(BytesOf(input), input.size(),
                                     output.data(), output.size());
  return written < 0
             ? Failure("Hex 编码失败。")
             : Success(output.data(), static_cast<std::size_t>(written));
}

ToolExecutionResult DecodeHex(const std::string& input) {
  const std::size_t capacity = (std::max)(std::size_t{1}, input.size() / 2 + 1);
  std::vector<unsigned char> output(capacity);
  const long written = cy_hex_decode(input.empty() ? "" : input.data(),
                                     input.size(), output.data(), output.size());
  if (written < 0) {
    return Failure("Hex 内容必须由成对的十六进制数字组成。");
  }
  const std::string text(reinterpret_cast<const char*>(output.data()),
                         static_cast<std::size_t>(written));
  return IsUtf8(text) ? Success(text.data(), text.size())
                      : Failure("解码结果不是 UTF-8 文本，二进制模式将在后续版本提供。");
}

ToolExecutionResult HashText(const std::string& input,
                             const std::string& operation) {
  const std::size_t capacity = operation == "md5" ? 32U : 64U;
  std::vector<char> output(capacity);
  const long written = operation == "md5"
      ? cy_md5_hex(BytesOf(input), input.size(), output.data(), output.size())
      : cy_sha256_hex(BytesOf(input), input.size(), output.data(), output.size());
  return written < 0
             ? Failure("哈希计算失败。")
             : Success(output.data(), static_cast<std::size_t>(written));
}

ToolExecutionResult EncodeUrl(const std::string& input, bool component) {
  const std::size_t capacity =
      (std::max)(std::size_t{1}, cy_url_encode_max_size(input.size()));
  std::vector<char> output(capacity);
  const long written = cy_url_encode(input.empty() ? "" : input.data(),
                                     input.size(), output.data(), output.size(),
                                     component ? 1 : 0);
  return written < 0
             ? Failure("URL 编码失败。")
             : Success(output.data(), static_cast<std::size_t>(written));
}

ToolExecutionResult DecodeUrl(const std::string& input) {
  const std::size_t capacity = (std::max)(std::size_t{1}, input.size());
  std::vector<char> output(capacity);
  const long written = cy_url_decode(input.empty() ? "" : input.data(),
                                     input.size(), output.data(), output.size());
  if (written < 0) {
    return Failure("URL 转义格式不正确，请检查百分号后的十六进制数字。");
  }
  const std::string text(output.data(), static_cast<std::size_t>(written));
  return IsUtf8(text) ? Success(text.data(), text.size())
                      : Failure("URL 解码结果不是有效的 UTF-8 文本。");
}

ToolExecutionResult FormatNumber(const std::string& input) {
  if (input.size() > 510U) {
    return Failure("数字内容过长，当前最多支持 510 个字符。");
  }
  std::vector<char> output(input.size() + input.size() / 3U + 8U);
  const int written = cy_number_group(input.data(), input.size(),
                                      output.data(), output.size());
  return written < 0
             ? Failure("请输入普通十进制数字，可包含符号、小数点或已有分隔符。")
             : Success(output.data(), static_cast<std::size_t>(written));
}

ToolExecutionResult ConvertTimestamp(const std::string& input,
                                     const std::string& operation) {
  long long value = 0;
  if (!ParseInteger(input, &value)) {
    return Failure("时间戳必须是完整的十进制整数。");
  }
  char output[25] = {};
  const int unit = operation == "milliseconds" ? 1 : 0;
  const int written = cy_timestamp_to_iso(static_cast<int64_t>(value), unit,
                                          output, sizeof(output));
  return written < 0
             ? Failure("时间戳超出当前支持的 UTC 日期范围。")
             : Success(output, static_cast<std::size_t>(written));
}

ToolExecutionResult GenerateUuid(const std::string& input,
                                 const std::string& operation) {
  long long count = 0;
  if (!ParseInteger(input, &count) || count < 1 || count > 50) {
    return Failure("UUID 数量需要是 1 到 50 之间的整数。");
  }
  std::ostringstream output;
  for (long long index = 0; index < count; ++index) {
    std::vector<unsigned char> random(operation == "v7" ? 10U : 16U);
    if (!FillSecureRandom(&random)) {
      return Failure("Windows 安全随机数生成失败。");
    }
    char uuid[37] = {};
    int written = -1;
    if (operation == "v7") {
      const long long unixMilliseconds =
          std::chrono::duration_cast<std::chrono::milliseconds>(
              std::chrono::system_clock::now().time_since_epoch())
              .count();
      written = cy_uuid_v7(static_cast<uint64_t>(unixMilliseconds),
                           random.data(), uuid, sizeof(uuid));
    } else {
      written = cy_uuid_v4(random.data(), uuid, sizeof(uuid));
    }
    if (written < 0) return Failure("UUID 生成失败。");
    if (index) output << '\n';
    output.write(uuid, written);
  }
  const std::string text = output.str();
  return Success(text.data(), text.size());
}

ToolExecutionResult GeneratePassword(const std::string& input,
                                     const std::string& operation) {
  long long length = 0;
  if (!ParseInteger(input, &length) || length < 4 || length > 128) {
    return Failure("密码长度需要是 4 到 128 之间的整数。");
  }
  const int useLower = operation == "pin" ? 0 : 1;
  const int useUpper = operation == "pin" ? 0 : 1;
  const int useDigits = 1;
  const int useSymbols = operation == "strong" ? 1 : 0;
  std::vector<char> output(static_cast<std::size_t>(length) + 1U);

  for (int attempt = 0; attempt < 4; ++attempt) {
    std::vector<unsigned char> random(
        static_cast<std::size_t>(length) * 16U + 64U);
    if (!FillSecureRandom(&random)) {
      return Failure("Windows 安全随机数生成失败。");
    }
    const int written = cy_password_generate(
        random.data(), random.size(), static_cast<int>(length), useLower,
        useUpper, useDigits, useSymbols, output.data(), output.size());
    if (written >= 0) {
      return Success(output.data(), static_cast<std::size_t>(written));
    }
    if (written != -2) break;
  }
  return Failure("密码生成失败，请重试。");
}

}  // namespace

ToolExecutionResult ExecuteTool(const std::string& toolId,
                                const std::string& operation,
                                const std::string& input,
                                bool urlSafe,
                                bool padded) {
  if (input.size() > kMaximumInputBytes) {
    return Failure("当前工具单次最多处理 1 MB 文本。");
  }
  if (toolId == "base64") {
    if (operation == "encode") return EncodeBase64(input, urlSafe, padded);
    if (operation == "decode") return DecodeBase64(input);
  } else if (toolId == "hex") {
    if (operation == "encode") return EncodeHex(input);
    if (operation == "decode") return DecodeHex(input);
  } else if (toolId == "hash") {
    if (operation == "md5" || operation == "sha256") {
      return HashText(input, operation);
    }
  } else if (toolId == "url-encode") {
    if (operation == "encode-component") return EncodeUrl(input, true);
    if (operation == "encode-url") return EncodeUrl(input, false);
    if (operation == "decode") return DecodeUrl(input);
  } else if (toolId == "numfmt") {
    if (operation == "group") return FormatNumber(input);
  } else if (toolId == "timestamp") {
    if (operation == "seconds" || operation == "milliseconds") {
      return ConvertTimestamp(input, operation);
    }
  } else if (toolId == "uuid") {
    if (operation == "v4" || operation == "v7") {
      return GenerateUuid(input, operation);
    }
  } else if (toolId == "password") {
    if (operation == "strong" || operation == "letters-digits" ||
        operation == "pin") {
      return GeneratePassword(input, operation);
    }
  }
  return Failure("这个工具操作尚未接入本地核心。");
}

}  // namespace milo
