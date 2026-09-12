#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include "Milo/ModbusDebugService.h"
#include <atomic>
#include <chrono>
#include <iostream>
#include <stdexcept>
#include <thread>
#include <vector>

namespace {
using nlohmann::json;
void Expect(bool condition, const char* text) { if (!condition) throw std::runtime_error(text); }
bool ReadExact(SOCKET socket, unsigned char* bytes, size_t count) {
  size_t read = 0; while (read < count) { int n = recv(socket, reinterpret_cast<char*>(bytes + read), static_cast<int>(count - read), 0); if (n <= 0) return false; read += n; } return true;
}
// Test fixture binds loopback only and never contacts an external device.
class Device {
 public:
  Device() : listener(INVALID_SOCKET), requests(0), writes(0), fault(0), stop(false) {
    listener = socket(AF_INET, SOCK_STREAM, 0); Expect(listener != INVALID_SOCKET, "fixture socket");
    sockaddr_in addr = {}; addr.sin_family = AF_INET; addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK); addr.sin_port = 0;
    Expect(bind(listener, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0, "fixture bind");
    int size = sizeof(addr); getsockname(listener, reinterpret_cast<sockaddr*>(&addr), &size); port = ntohs(addr.sin_port);
    Expect(listen(listener, 4) == 0, "fixture listen"); worker = std::thread([this] { Run(); });
  }
  ~Device() { stop = true; closesocket(listener); if (worker.joinable()) worker.join(); }
  void Run() {
    while (!stop) {
      SOCKET peer = accept(listener, nullptr, nullptr); if (peer == INVALID_SOCKET) break;
      DWORD timeout = 300; setsockopt(peer, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<char*>(&timeout), sizeof(timeout));
      while (!stop) {
        unsigned char query[260]; if (!ReadExact(peer, query, 6)) break;
        unsigned length = query[4] * 256U + query[5]; if (length > 254 || length < 6 || !ReadExact(peer, query + 6, length)) break;
        ++requests; bool write = query[7] == 5 || query[7] == 6 || query[7] == 15 || query[7] == 16; if (write) ++writes;
        int mode = fault.exchange(0); if (mode == 3) { Sleep(500); break; }
        std::vector<unsigned char> response(query, query + 12);
        if (mode == 2) { response.resize(9); response[5] = 3; response[7] |= 0x80; response[8] = 2; }
        else if (!write) {
          unsigned count = query[10] * 256U + query[11]; const bool bits = query[7] <= 2; unsigned bytes = bits ? (count + 7) / 8 : count * 2;
          response.resize(9 + bytes); response[4] = 0; response[5] = static_cast<unsigned char>(3 + bytes); response[8] = static_cast<unsigned char>(bytes);
          for (unsigned i = 0; i < bytes; ++i) response[9 + i] = bits ? 0x55 : static_cast<unsigned char>(i % 2 ? (i / 2 + 1) * 25 : 0);
        } else { response[4] = 0; response[5] = 6; }
        if (mode == 1) response[1] ^= 0x20;
        // Exercise both fragmented MBAP headers and fragmented response bodies.
        for (size_t i = 0; i < response.size(); ++i) { if (send(peer, reinterpret_cast<const char*>(&response[i]), 1, 0) != 1) break; Sleep(1); }
      }
      closesocket(peer);
    }
  }
  SOCKET listener; unsigned short port; std::atomic<int> requests, writes, fault; std::atomic<bool> stop; std::thread worker;
};
json Wait(milo::ModbusDebugService& service, const std::string& state, bool completed = false) {
  const auto deadline = GetTickCount64() + 5000;
  json snapshot;
  do {
    snapshot = service.Handle("poll", json::object())["snapshot"];
    if (snapshot["state"] == state && (!completed || !snapshot["pending"].get<bool>())) return snapshot;
    Sleep(5);
  } while (GetTickCount64() < deadline);
  throw std::runtime_error("worker state timeout; expected=" + state + "; last=" + snapshot.dump());
}
}
int main() {
  WSADATA data; WSAStartup(MAKEWORD(2,2), &data);
  try {
    Device device; milo::ModbusDebugService service;
    // Sleep(1) can occupy a full Windows scheduler quantum. Keep fragmented
    // success cases independent of timer resolution; timeout cases use 200ms below.
    json options = {{"transport","tcp"},{"host","127.0.0.1"},{"port",device.port},{"unitId",1},{"timeoutMs",1000},{"retries",0}};
    auto connect = [&] { service.Handle("start", options); Wait(service, "connected"); };
    connect();
    json read = {{"functionCode",3},{"address",0},{"quantity",3}};
    service.Handle("request", read); json result = Wait(service, "connected", true);
    Expect(result["result"]["values"] == json::array({25,50,75}), "fragmented TCP read values");
    bool rejected = false; try { service.Handle("request", {{"functionCode",6},{"address",0},{"quantity",1},{"values",json::array({123})}}); } catch (...) { rejected = true; }
    Expect(rejected && device.writes == 0, "write requires explicit native confirmation");
    service.Handle("request", {{"functionCode",6},{"address",0},{"quantity",1},{"values",json::array({123})},{"confirmed",true}});
    result = Wait(service, "connected", true); Expect(result["result"]["written"].get<bool>() && device.writes == 1, "confirmed write acknowledgement");
    device.fault = 2; service.Handle("request", read); result = Wait(service, "connected", true);
    Expect(result["error"].get<std::string>().find("2") != std::string::npos && result["result"].is_null(), "exception surfaced without invented values");
    device.fault = 1; service.Handle("request", read); Wait(service, "error");
    service.Stop(); Expect(service.Handle("poll", json::object())["snapshot"]["state"] == "stopped", "synchronous close barrier");
    options["retries"] = 2; connect(); device.fault = 1;
    const int beforeReadRetry = device.requests;
    service.Handle("request", read); result = Wait(service, "connected", true);
    Expect(result["result"]["values"].size() == 3 && device.requests == beforeReadRetry + 2, "read may retry once after invalid transaction on a fresh connection");
    service.Stop(); options["timeoutMs"] = 200; connect();
    device.fault = 3;
    const int beforeWrites = device.writes;
    service.Handle("request", {{"functionCode",6},{"address",0},{"quantity",1},{"values",json::array({456})},{"confirmed",true}});
    result = Wait(service, "error"); Sleep(350);
    Expect(device.writes == beforeWrites + 1, "timed-out writes are never automatically retried");
    Expect(result["error"].get<std::string>().find("不确定") != std::string::npos, "ambiguous write outcome is explicit");
    service.Stop(); options["timeoutMs"] = 1000; options["retries"] = 0; connect(); device.fault = 3;
    service.Handle("request", read); Sleep(30); const auto beforeStop = GetTickCount64(); service.Stop();
    Expect(GetTickCount64() - beforeStop < 300, "stop cancels IO promptly");
    result = service.Handle("poll", json::object())["snapshot"]; Expect(result["state"] == "stopped" && result["result"].is_null(), "cancelled request cannot publish data later");
    bool badUnit = false; options["unitId"] = 0; try { service.Handle("start", options); } catch (...) { badUnit = true; } Expect(badUnit, "broadcast unit rejected");
    options["unitId"] = 1; options["transport"] = "rtu"; options["serialPort"] = "C:\\should-not-be-opened";
    bool badPort = false; try { service.Handle("start", options); } catch (...) { badPort = true; } Expect(badPort, "RTU rejects arbitrary device or file paths before IO");
    std::cout << "PASS Modbus worker: local mock TCP fragments, values, exceptions, confirmation, no write retry, cancellation.\n";
  } catch (const std::exception& e) { std::cerr << e.what() << '\n'; WSACleanup(); return 1; }
  WSACleanup(); return 0;
}
