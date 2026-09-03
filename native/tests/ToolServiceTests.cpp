#include "Milo/ToolService.h"

#include <cctype>
#include <cstdlib>
#include <iostream>

#include <nlohmann/json.hpp>

#include "cloudyi/packet_inspector.h"

namespace {

bool ExpectOutput(const std::string& tool, const std::string& operation,
                  const std::string& input, const std::string& expected) {
  const milo::ToolExecutionResult result =
      milo::ExecuteTool(tool, operation, input);
  if (!result.succeeded || result.output != expected) {
    std::cerr << tool << '/' << operation << " failed. error=" << result.error
              << " output=" << result.output << "\n";
    return false;
  }
  return true;
}

bool ExpectUuid(const std::string& operation, char version) {
  const milo::ToolExecutionResult result =
      milo::ExecuteTool("uuid", operation, "1");
  const bool shape = result.succeeded && result.output.size() == 36U &&
                     result.output[8] == '-' && result.output[13] == '-' &&
                     result.output[18] == '-' && result.output[23] == '-' &&
                     result.output[14] == version &&
                     (result.output[19] == '8' || result.output[19] == '9' ||
                      result.output[19] == 'a' || result.output[19] == 'b');
  if (!shape) {
    std::cerr << "uuid/" << operation << " returned an invalid value: "
              << result.output << " error=" << result.error << "\n";
  }
  return shape;
}

bool ExpectPassword(const std::string& operation, const std::string& length,
                    bool requireAllGroups) {
  const milo::ToolExecutionResult result =
      milo::ExecuteTool("password", operation, length);
  if (!result.succeeded || result.output.size() !=
                               static_cast<std::size_t>(std::atoi(length.c_str()))) {
    std::cerr << "password/" << operation << " failed: " << result.error
              << " output=" << result.output << "\n";
    return false;
  }
  bool lower = false;
  bool upper = false;
  bool digit = false;
  bool symbol = false;
  for (std::size_t index = 0; index < result.output.size(); ++index) {
    const unsigned char ch = static_cast<unsigned char>(result.output[index]);
    lower = lower || std::islower(ch) != 0;
    upper = upper || std::isupper(ch) != 0;
    digit = digit || std::isdigit(ch) != 0;
    symbol = symbol || std::isalnum(ch) == 0;
  }
  const bool valid = operation == "pin" ? digit && !lower && !upper && !symbol
                                         : !requireAllGroups ||
                                               (lower && upper && digit && symbol);
  if (!valid) {
    std::cerr << "password/" << operation
              << " did not honor the selected character groups.\n";
  }
  return valid;
}

bool ExpectPacketInspection() {
  const std::string packet =
      "ff ff ff ff ff ff 00 11 22 33 44 55 08 00 "
      "45 00 00 20 12 34 40 00 40 11 00 00 c0 a8 01 64 c0 a8 01 01 "
      "04 d2 16 2e 00 0c 00 00 de ad be ef";
  const milo::ToolExecutionResult result =
      milo::ExecuteTool("packet-inspector", "auto", packet);
  if (!result.succeeded) {
    std::cerr << "packet-inspector/auto failed: " << result.error << "\n";
    return false;
  }
  try {
    const nlohmann::json report = nlohmann::json::parse(result.output);
    if (report.at("byteCount").get<std::size_t>() != 46U ||
        report.at("protocol").get<std::string>() !=
            "Ethernet II / IPv4 / UDP" ||
        report.at("confidence").get<int>() < 80 ||
        report.at("bytes").size() != 46U ||
        report.at("layers").size() != 4U) {
      std::cerr << "packet-inspector returned unexpected report metadata: "
                << result.output << "\n";
      return false;
    }
    bool foundDestination = false;
    bool foundUdpPort = false;
    const nlohmann::json& fields = report.at("fields");
    for (nlohmann::json::const_iterator field = fields.begin();
         field != fields.end(); ++field) {
      const std::size_t offset = field->at("offset").get<std::size_t>();
      const std::size_t length = field->at("length").get<std::size_t>();
      if (offset > 46U || length > 46U - offset) {
        std::cerr << "packet-inspector exposed an out-of-bounds field.\n";
        return false;
      }
      if (field->at("layer") == "ipv4" && field->at("name") == "destination" &&
          field->at("value") == "192.168.1.1") {
        foundDestination = true;
      }
      if (field->at("layer") == "udp" &&
          field->at("name") == "destinationPort" &&
          field->at("value") == "5678") {
        foundUdpPort = true;
      }
    }
    if (!foundDestination || !foundUdpPort) {
      std::cerr << "packet-inspector omitted expected IPv4/UDP fields.\n";
      return false;
    }
  } catch (const std::exception& error) {
    std::cerr << "packet-inspector returned invalid JSON: " << error.what()
              << "\n";
    return false;
  }

  const milo::ToolExecutionResult raw =
      milo::ExecuteTool("packet-inspector", "auto", "de ad be ef 01");
  if (!raw.succeeded) return false;
  const nlohmann::json rawReport = nlohmann::json::parse(raw.output);
  if (rawReport.at("protocol") != "Raw bytes" ||
      rawReport.at("warnings").empty()) {
    std::cerr << "Unknown data was not preserved as warned raw payload.\n";
    return false;
  }
  const milo::ToolExecutionResult explicitRaw =
      milo::ExecuteTool("packet-inspector", "raw", "de ad be ef");
  if (!explicitRaw.succeeded ||
      nlohmann::json::parse(explicitRaw.output).at("confidence") != 0) {
    std::cerr << "Explicit raw mode should not claim protocol confidence.\n";
    return false;
  }
  const milo::ToolExecutionResult forcedInvalid =
      milo::ExecuteTool("packet-inspector", "ipv4", "45 00");
  if (!forcedInvalid.succeeded ||
      nlohmann::json::parse(forcedInvalid.output).at("confidence").get<int>() >
          35) {
    std::cerr << "A truncated forced protocol should have low confidence.\n";
    return false;
  }
  const milo::ToolExecutionResult forcedWrongVersion = milo::ExecuteTool(
      "packet-inspector", "ipv4",
      "55 00 00 14 00 00 00 00 40 11 00 00 01 02 03 04 05 06 07 08");
  if (!forcedWrongVersion.succeeded) return false;
  const nlohmann::json wrongVersion =
      nlohmann::json::parse(forcedWrongVersion.output);
  bool reportedActualVersion = false;
  for (nlohmann::json::const_iterator field = wrongVersion.at("fields").begin();
       field != wrongVersion.at("fields").end(); ++field) {
    if (field->at("name") == "version" && field->at("value") == "5") {
      reportedActualVersion = true;
    }
  }
  if (!reportedActualVersion || wrongVersion.at("confidence").get<int>() > 35) {
    std::cerr << "Forced IPv4 mode hid the actual invalid version nibble.\n";
    return false;
  }
  const milo::ToolExecutionResult fragment = milo::ExecuteTool(
      "packet-inspector", "ipv4",
      "45 00 00 18 00 01 00 01 40 11 00 00 01 02 03 04 05 06 07 08 "
      "de ad be ef");
  if (!fragment.succeeded) return false;
  const nlohmann::json fragmentReport =
      nlohmann::json::parse(fragment.output);
  bool reportedByteOffset = false;
  for (nlohmann::json::const_iterator field =
           fragmentReport.at("fields").begin();
       field != fragmentReport.at("fields").end(); ++field) {
    if (field->at("name") == "fragment" &&
        field->at("value").get<std::string>().find("offsetBytes=8") !=
            std::string::npos) {
      reportedByteOffset = true;
    }
  }
  if (!reportedByteOffset) {
    std::cerr << "IPv4 fragment offset was not reported in byte units.\n";
    return false;
  }
  const milo::ToolExecutionResult padded =
      milo::ExecuteTool("packet-inspector", "auto", packet + " 00 00");
  if (!padded.succeeded) return false;
  const nlohmann::json paddedReport = nlohmann::json::parse(padded.output);
  bool foundTrailing = false;
  for (nlohmann::json::const_iterator layer = paddedReport.at("layers").begin();
       layer != paddedReport.at("layers").end(); ++layer) {
    if (layer->at("id") == "trailing" && layer->at("offset") == 46U &&
        layer->at("length") == 2U) {
      foundTrailing = true;
    }
  }
  if (!foundTrailing) {
    std::cerr << "Bytes beyond the declared IPv4 packet were not classified.\n";
    return false;
  }

  const milo::ToolExecutionResult odd =
      milo::ExecuteTool("packet-inspector", "raw", "abc");
  if (odd.succeeded || odd.error.empty()) {
    std::cerr << "Odd-length packet Hex was unexpectedly accepted.\n";
    return false;
  }

  unsigned char bytes[8] = {};
  const long decoded = cy_packet_hex_decode(
      "0x45:00-00_14", 13U, bytes, sizeof(bytes));
  if (decoded != 4 || bytes[0] != 0x45 || bytes[3] != 0x14) {
    std::cerr << "Portable packet Hex decoder rejected supported separators.\n";
    return false;
  }
  return true;
}

}  // namespace

int main() {
  bool passed = true;
  passed &= ExpectOutput("base64", "encode", "hello", "aGVsbG8=");
  passed &= ExpectOutput("base64", "decode", "5Y-v54ix5L6d5L6d", "可爱依依");
  passed &= ExpectOutput("hex", "encode", "Hello", "48656c6c6f");
  passed &= ExpectOutput("hex", "decode", "48656c6c6f", "Hello");
  passed &= ExpectOutput("hash", "md5", "abc", "900150983cd24fb0d6963f7d28e17f72");
  passed &= ExpectOutput("hash", "sha256", "abc",
               "ba7816bf8f01cfea414140de5dae2223"
               "b00361a396177a9cb410ff61f20015ad");
  passed &= ExpectOutput("url-encode", "encode-component", "可爱 依依",
               "%E5%8F%AF%E7%88%B1%20%E4%BE%9D%E4%BE%9D");
  passed &= ExpectOutput("url-encode", "decode",
               "%E5%8F%AF%E7%88%B1+%E4%BE%9D%E4%BE%9D", "可爱 依依");
  passed &= ExpectOutput("numfmt", "group", "-1234567.890", "-1,234,567.890");
  passed &= ExpectOutput("numfmt", "group", "+1234", "+1,234");
  passed &= ExpectOutput("timestamp", "seconds", "0",
                         "1970-01-01T00:00:00.000Z");
  passed &= ExpectOutput("timestamp", "milliseconds", "1704067200123",
                         "2024-01-01T00:00:00.123Z");
  passed &= ExpectUuid("v4", '4');
  passed &= ExpectUuid("v7", '7');
  passed &= ExpectPassword("strong", "24", true);
  passed &= ExpectPassword("pin", "6", false);
  passed &= ExpectPacketInspection();

  const milo::ToolExecutionResult invalid =
      milo::ExecuteTool("hex", "decode", "xyz");
  if (invalid.succeeded || invalid.error.empty()) {
    std::cerr << "Invalid Hex input was unexpectedly accepted.\n";
    passed = false;
  }
  if (!passed) return 1;
  std::cout << "Tool service tests passed.\n";
  return 0;
}
