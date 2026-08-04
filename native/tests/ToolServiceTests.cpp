#include "Milo/ToolService.h"

#include <cctype>
#include <cstdlib>
#include <iostream>

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
