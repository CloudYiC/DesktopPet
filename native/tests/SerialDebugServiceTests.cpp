#include "Milo/SerialDebugService.h"
#include "Milo/SerialPortWin32.h"
#include <chrono>
#include <cstring>
#include <cstdio>
#include <iostream>
#include <set>
#include <thread>
#include <vector>

namespace {
bool Check(bool condition, const char* label) { if (!condition) std::cerr << "FAIL: " << label << '\n'; return condition; }
template <typename Operation> bool Rejects(Operation operation) { try { operation(); return false; } catch (...) { return true; } }
}

int main() {
  bool ok = true;
  cy_serial_options options = {};
  std::snprintf(options.port, sizeof(options.port), "%s", "COM1"); options.baud = 115200; options.data_bits = 8; options.dtr = options.rts = 1;
  ok &= Check(cy_serial_valid_options(&options) != 0, "valid 115200 8N1");
  const char* invalid[] = {"", "COM0", "COM01", "COM65536", "COM-1", "COM1\\x", "NUL", "\\\\.\\COM1", "C:\\test"};
  for (const char* name : invalid) { std::memset(options.port, 0, sizeof(options.port)); std::snprintf(options.port, sizeof(options.port), "%s", name); ok &= Check(!cy_serial_valid_options(&options), "reject arbitrary device paths"); }
  std::snprintf(options.port, sizeof(options.port), "%s", "COM1"); options.stop_bits = 1;
  ok &= Check(!cy_serial_valid_options(&options), "1.5 stop bits requires 5 bits");
  options.data_bits = 5; ok &= Check(cy_serial_valid_options(&options) != 0, "5-bit 1.5 stop allowed");
  options.stop_bits = 2; ok &= Check(!cy_serial_valid_options(&options), "5-bit 2 stop rejected");
  options.stop_bits = 0; options.baud = 4000001; ok &= Check(!cy_serial_valid_options(&options), "baud maximum");

  std::vector<unsigned char> decoded(65536, 77);
  std::size_t count = 0;
  ok &= Check(cy_serial_decode_hex("00aAFF", 6, decoded.data(), decoded.size(), &count) && count == 3 && decoded[0] == 0 && decoded[1] == 170 && decoded[2] == 255, "pure C hex decoder");
  const std::string maximum(131072, 'f');
  ok &= Check(cy_serial_decode_hex(maximum.data(), maximum.size(), decoded.data(), decoded.size(), &count) && count == 65536, "maximum 64 KiB bytes");
  ok &= Check(!cy_serial_decode_hex(maximum.data(), maximum.size(), decoded.data(), 65535, &count) && count == 0, "destination capacity checked");
  const std::string oversized(131074, '0');
  ok &= Check(!cy_serial_decode_hex(oversized.data(), oversized.size(), decoded.data(), decoded.size(), &count), "reject over-limit hex");
  decoded[0] = 77;
  ok &= Check(!cy_serial_decode_hex("00gg", 4, decoded.data(), decoded.size(), &count) && decoded[0] == 77, "reject entire invalid input before partial writes");
  ok &= Check(!cy_serial_decode_hex("0", 1, decoded.data(), decoded.size(), &count), "reject incomplete byte");
  ok &= Check(!cy_serial_decode_hex("", 0, decoded.data(), decoded.size(), &count), "reject empty send");

  milo::SerialDebugService service;
  const nlohmann::json empty = nlohmann::json::object();
  ok &= Check(service.Handle("poll", empty)["snapshot"]["state"] == "stopped", "initially stopped");
  ok &= Check(Rejects([&] { service.Handle("start", {{"port", "\\\\.\\NUL"}}); }), "bridge rejects arbitrary file/device");
  ok &= Check(Rejects([&] { service.Handle("start", {{"port", "COM1"}, {"baud", 115200.5}}); }), "integer settings only");
  ok &= Check(Rejects([&] { service.Handle("start", {{"port", "COM1"}, {"dataBits", 0}}); }), "invalid data bits");
  ok &= Check(Rejects([&] { service.Handle("send", {{"dataHex", "00"}}); }), "send requires open COM");
  ok &= Check(Rejects([&] { service.Handle("unknown", empty); }), "unknown operation rejected");
  const nlohmann::json listed = service.Handle("enumerate", empty);
  ok &= Check(listed["ports"].is_array(), "real COM enumeration returns array");
  std::set<std::string> ports;
  for (const auto& entry : listed["ports"]) ports.insert(entry["port"].get<std::string>());
  // Never open a listed hardware port in regression tests. A nonexistent high COM tests failure/cancellation only.
  std::string missing;
  for (int number = 65535; number > 65000; --number) { const std::string port = "COM" + std::to_string(number); if (!ports.count(port)) { missing = port; break; } }
  if (!missing.empty()) {
    const auto begin = std::chrono::steady_clock::now();
    const auto opened = service.Handle("start", {{"port", missing}});
    ok &= Check(opened["snapshot"]["state"] == "opening", "open is asynchronous");
    ok &= Check(std::chrono::steady_clock::now() - begin < std::chrono::milliseconds(500), "start never waits for COM IO");
    bool failed = false;
    for (int i = 0; i < 200; ++i) { if (service.Handle("poll", empty)["snapshot"]["state"] == "error") { failed = true; break; } std::this_thread::sleep_for(std::chrono::milliseconds(10)); }
    ok &= Check(failed, "nonexistent COM produces explicit error");
    service.Stop();
    service.Handle("start", {{"port", missing}});
    service.Handle("stop", empty);
    service.Stop();
    ok &= Check(service.Handle("poll", empty)["snapshot"]["state"] == "stopped", "close cancels worker and service can restart");
  }
  service.Stop();
  return ok ? 0 : 1;
}
