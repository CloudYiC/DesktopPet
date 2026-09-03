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

#include <nlohmann/json.hpp>

#include "Milo/Utils.h"
#include "cloudyi/base64.h"
#include "cloudyi/hex.h"
#include "cloudyi/md5.h"
#include "cloudyi/packet_inspector.h"
#include "cloudyi/sha256.h"
#include "cloudyi/store_tools.h"
#include "cloudyi/url_encode.h"

namespace milo {
namespace {

const std::size_t kMaximumInputBytes = 1024U * 1024U;
const std::size_t kMaximumPacketBytes = 256U * 1024U;
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

ToolExecutionResult InspectPacket(const std::string& input,
                                  const std::string& operation) {
  cy_packet_mode mode = CY_PACKET_MODE_AUTO;
  if (cy_packet_mode_parse(operation.c_str(), &mode) != 0) {
    return Failure("报文起始层无效，请选择自动、Ethernet、IPv4、IPv6、TCP、UDP 或原始数据。");
  }

  const std::size_t capacity =
      (std::max)(std::size_t{1}, cy_packet_hex_max_decoded_size(input.size()));
  std::vector<unsigned char> bytes(capacity);
  const long decoded = cy_packet_hex_decode(
      input.empty() ? "" : input.data(), input.size(), bytes.data(), bytes.size());
  if (decoded == -2) {
    return Failure("报文中包含非十六进制字符；请粘贴规范化 Hex 内容。");
  }
  if (decoded == -4) {
    return Failure("十六进制数字数量必须为偶数，当前末尾缺少半个字节。");
  }
  if (decoded < 0) {
    return Failure("十六进制报文解析失败，请检查输入长度与格式。");
  }
  const std::size_t byteCount = static_cast<std::size_t>(decoded);
  if (byteCount > kMaximumPacketBytes) {
    return Failure("单次报文分析最多支持 256 KB 数据。");
  }
  bytes.resize(byteCount);

  cy_packet_report report = {};
  const unsigned char emptyByte = 0;
  const unsigned char* data = bytes.empty() ? &emptyByte : bytes.data();
  if (cy_packet_inspect(data, bytes.size(), mode, &report) != 0) {
    return Failure("报文解析核心未能完成本次分析。");
  }

  nlohmann::json json;
  json["mode"] = cy_packet_mode_name(report.mode);
  json["byteCount"] = report.byte_count;
  json["protocol"] = report.protocol;
  json["confidence"] = report.confidence;
  json["bytes"] = nlohmann::json::array();
  for (std::size_t index = 0; index < bytes.size(); ++index) {
    json["bytes"].push_back(bytes[index]);
  }
  json["layers"] = nlohmann::json::array();
  for (std::size_t index = 0; index < report.layer_count; ++index) {
    const cy_packet_layer& layer = report.layers[index];
    nlohmann::json item;
    item["id"] = layer.id;
    item["name"] = layer.name;
    item["offset"] = layer.offset;
    item["length"] = layer.length;
    item["summary"] = layer.summary;
    json["layers"].push_back(item);
  }
  json["fields"] = nlohmann::json::array();
  for (std::size_t index = 0; index < report.field_count; ++index) {
    const cy_packet_field& field = report.fields[index];
    nlohmann::json item;
    item["layer"] = field.layer;
    item["name"] = field.name;
    item["offset"] = field.offset;
    item["length"] = field.length;
    item["value"] = field.value;
    item["summary"] = field.summary;
    json["fields"].push_back(item);
  }
  json["warnings"] = nlohmann::json::array();
  for (std::size_t index = 0; index < report.warning_count; ++index) {
    const cy_packet_warning& warning = report.warnings[index];
    nlohmann::json item;
    item["code"] = warning.code;
    item["message"] = warning.message;
    item["offset"] = warning.offset;
    json["warnings"].push_back(item);
  }
  const std::string output = json.dump();
  return Success(output.data(), output.size());
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
  } else if (toolId == "packet-inspector") {
    if (operation == "auto" || operation == "ethernet" ||
        operation == "ipv4" || operation == "ipv6" ||
        operation == "tcp" || operation == "udp" || operation == "raw") {
      return InspectPacket(input, operation);
    }
  }
  return Failure("这个工具操作尚未接入本地核心。");
}

}  // namespace milo
