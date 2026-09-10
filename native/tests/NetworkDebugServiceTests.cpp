#include "Milo/NetworkDebugService.h"

#include <windows.h>

#include <chrono>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

void Expect(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

void ValidateEventKinds(const std::vector<milo::NetworkDebugEvent>& events) {
  for (std::vector<milo::NetworkDebugEvent>::const_iterator event =
           events.begin();
       event != events.end(); ++event) {
    Expect(event->kind == "received" || event->kind == "sent" ||
               event->kind == "system" || event->kind == "error",
           "A network event used an unsupported kind.");
  }
}

bool WaitForState(milo::NetworkDebugService* service,
                  const std::string& desiredState,
                  std::size_t minimumPeers,
                  milo::NetworkDebugSnapshot* snapshot,
                  DWORD timeoutMilliseconds = 5000) {
  const ULONGLONG deadline = GetTickCount64() + timeoutMilliseconds;
  do {
    const milo::NetworkDebugPollResult poll = service->Poll();
    ValidateEventKinds(poll.events);
    if (poll.snapshot.state == "error") {
      throw std::runtime_error(poll.snapshot.lastError);
    }
    if (poll.snapshot.state == desiredState &&
        poll.snapshot.peers.size() >= minimumPeers) {
      if (snapshot != nullptr) *snapshot = poll.snapshot;
      return true;
    }
    Sleep(5);
  } while (GetTickCount64() < deadline);
  return false;
}

bool WaitForReceivedHex(milo::NetworkDebugService* service,
                        const std::string& expected,
                        DWORD timeoutMilliseconds = 5000) {
  const ULONGLONG deadline = GetTickCount64() + timeoutMilliseconds;
  std::string combined;
  do {
    const milo::NetworkDebugPollResult poll = service->Poll();
    ValidateEventKinds(poll.events);
    if (poll.snapshot.state == "error") {
      throw std::runtime_error(poll.snapshot.lastError);
    }
    for (std::vector<milo::NetworkDebugEvent>::const_iterator event =
             poll.events.begin();
         event != poll.events.end(); ++event) {
      if (event->kind == "received") combined += event->dataHex;
    }
    if (combined == expected) return true;
    if (combined.size() > expected.size() ||
        expected.compare(0, combined.size(), combined) != 0) {
      return false;
    }
    Sleep(5);
  } while (GetTickCount64() < deadline);
  return false;
}

bool HasReceivedData(milo::NetworkDebugService* service,
                     DWORD observationMilliseconds) {
  const ULONGLONG deadline = GetTickCount64() + observationMilliseconds;
  do {
    const milo::NetworkDebugPollResult poll = service->Poll();
    ValidateEventKinds(poll.events);
    for (std::vector<milo::NetworkDebugEvent>::const_iterator event =
             poll.events.begin();
         event != poll.events.end(); ++event) {
      if (event->kind == "received") return true;
    }
    Sleep(5);
  } while (GetTickCount64() < deadline);
  return false;
}

milo::NetworkDebugStartOptions TcpServerOptions() {
  milo::NetworkDebugStartOptions options;
  options.mode = "tcp-server";
  options.localHost = "127.0.0.1";
  options.localPort = 0;
  return options;
}

milo::NetworkDebugStartOptions TcpClientOptions(std::uint16_t port) {
  milo::NetworkDebugStartOptions options;
  options.mode = "tcp-client";
  options.remoteHost = "127.0.0.1";
  options.remotePort = port;
  return options;
}

milo::NetworkDebugStartOptions UdpOptions(std::uint16_t localPort,
                                          std::uint16_t remotePort) {
  milo::NetworkDebugStartOptions options;
  options.mode = "udp";
  options.localHost = "127.0.0.1";
  options.localPort = localPort;
  options.remoteHost = "127.0.0.1";
  options.remotePort = remotePort;
  return options;
}

void TestTcpBidirectionalAndMultipleClients() {
  milo::NetworkDebugService server;
  milo::NetworkDebugService firstClient;
  milo::NetworkDebugService secondClient;
  std::string error;

  Expect(server.Start(TcpServerOptions(), &error),
         "TCP server start request was rejected.");
  milo::NetworkDebugSnapshot serverSnapshot;
  Expect(WaitForState(&server, "listening", 0, &serverSnapshot),
         "TCP server did not begin listening.");
  Expect(serverSnapshot.localPort != 0,
         "TCP server did not report its assigned port.");

  Expect(firstClient.Start(TcpClientOptions(serverSnapshot.localPort), &error),
         "First TCP client start request was rejected.");
  Expect(secondClient.Start(TcpClientOptions(serverSnapshot.localPort), &error),
         "Second TCP client start request was rejected.");
  milo::NetworkDebugSnapshot firstSnapshot;
  milo::NetworkDebugSnapshot secondSnapshot;
  Expect(WaitForState(&firstClient, "connected", 1, &firstSnapshot),
         "First TCP client did not connect.");
  Expect(WaitForState(&secondClient, "connected", 1, &secondSnapshot),
         "Second TCP client did not connect.");
  Expect(WaitForState(&server, "listening", 2, &serverSnapshot),
         "TCP server did not expose both peers.");

  const std::string binaryHex = "007f80ff4100";
  Expect(firstClient.Send(binaryHex, 0, &error),
         "TCP client binary send was rejected.");
  Expect(WaitForReceivedHex(&server, binaryHex),
         "TCP server did not receive the binary payload.");

  const std::string broadcastHex = "1122334455";
  Expect(server.Send(broadcastHex, 0, &error),
         "TCP broadcast was rejected.");
  Expect(WaitForReceivedHex(&firstClient, broadcastHex),
         "First TCP client did not receive the broadcast.");
  Expect(WaitForReceivedHex(&secondClient, broadcastHex),
         "Second TCP client did not receive the broadcast.");

  std::uint64_t firstPeerId = 0;
  for (std::vector<milo::NetworkDebugPeer>::const_iterator peer =
           serverSnapshot.peers.begin();
       peer != serverSnapshot.peers.end(); ++peer) {
    if (peer->port == firstSnapshot.localPort) firstPeerId = peer->id;
  }
  Expect(firstPeerId != 0, "Unable to match the first TCP client peer.");
  const std::string targetedHex = "a1b2c3";
  Expect(server.Send(targetedHex, firstPeerId, &error),
         "Targeted TCP send was rejected.");
  Expect(WaitForReceivedHex(&firstClient, targetedHex),
         "Targeted TCP data did not reach the selected peer.");
  Expect(!HasReceivedData(&secondClient, 150),
         "Targeted TCP data leaked to another peer.");

  serverSnapshot = server.Snapshot();
  Expect(serverSnapshot.rxBytes >= binaryHex.size() / 2U &&
             serverSnapshot.txBytes >=
                 (broadcastHex.size() + targetedHex.size()) / 2U,
         "TCP server counters were not updated.");

  firstClient.Stop();
  secondClient.Stop();
  server.Stop();
  server.Stop();
  Expect(server.Snapshot().state == "stopped" &&
             server.Snapshot().peers.empty(),
         "TCP Stop must be idempotent and clear peers.");
}

void TestUdpBinaryDatagram() {
  milo::NetworkDebugService receiver;
  milo::NetworkDebugService sender;
  std::string error;
  Expect(receiver.Start(UdpOptions(0, 9), &error),
         "UDP receiver start request was rejected.");
  milo::NetworkDebugSnapshot receiverSnapshot;
  Expect(WaitForState(&receiver, "ready", 0, &receiverSnapshot),
         "UDP receiver did not become ready.");
  Expect(receiverSnapshot.localPort != 0,
         "UDP receiver did not report its assigned port.");

  Expect(sender.Start(UdpOptions(0, receiverSnapshot.localPort), &error),
         "UDP sender start request was rejected.");
  milo::NetworkDebugSnapshot senderSnapshot;
  Expect(WaitForState(&sender, "ready", 0, &senderSnapshot),
         "UDP sender did not become ready.");

  const std::string dataHex = "0001027f80feff00414243";
  Expect(sender.Send(dataHex, 0, &error), "UDP binary send was rejected.");
  Expect(WaitForReceivedHex(&receiver, dataHex),
         "UDP receiver did not receive the complete datagram.");
  Expect(receiver.Snapshot().rxPackets == 1 &&
             receiver.Snapshot().rxBytes == dataHex.size() / 2U,
         "UDP receive counters were not updated.");
  Expect(sender.Snapshot().txPackets == 1 &&
             sender.Snapshot().txBytes == dataHex.size() / 2U,
         "UDP send counters were not updated.");

  std::vector<unsigned char> largeDatagram(60000U);
  for (std::size_t index = 0; index < largeDatagram.size(); ++index) {
    largeDatagram[index] = static_cast<unsigned char>(index & 0xffU);
  }
  const std::string largeHex = [] (const std::vector<unsigned char>& bytes) {
    static const char digits[] = "0123456789abcdef";
    std::string value(bytes.size() * 2U, '0');
    for (std::size_t index = 0; index < bytes.size(); ++index) {
      value[index * 2U] = digits[(bytes[index] >> 4U) & 0x0fU];
      value[index * 2U + 1U] = digits[bytes[index] & 0x0fU];
    }
    return value;
  }(largeDatagram);
  Expect(sender.Send(largeDatagram, 0, &error),
         "Large legal UDP datagram was rejected.");
  Expect(WaitForReceivedHex(&receiver, largeHex),
         "Large UDP datagram was truncated or lost.");

  sender.Stop();
  receiver.Stop();
}

void TestValidationAndBoundedStop() {
  milo::NetworkDebugService service;
  milo::NetworkDebugStartOptions exposed = TcpServerOptions();
  exposed.localHost = "0.0.0.0";
  std::string error;
  Expect(!service.Start(exposed, &error) && !error.empty(),
         "A wildcard listener without LAN consent must be rejected.");

  Expect(service.Start(UdpOptions(0, 9), &error),
         "Validation test UDP service did not start.");
  Expect(WaitForState(&service, "ready", 0, nullptr),
         "Validation test UDP service did not become ready.");
  Expect(!service.Send("abc", 0, &error) && !error.empty(),
         "Odd-length hexadecimal data must be rejected.");
  Expect(!service.Send("zz", 0, &error) && !error.empty(),
         "Non-hexadecimal data must be rejected.");
  std::vector<unsigned char> tooLarge(64U * 1024U + 1U, 0x55U);
  Expect(!service.Send(tooLarge, 0, &error) && !error.empty(),
         "Payloads larger than 64 KiB must be rejected.");

  const std::chrono::steady_clock::time_point started =
      std::chrono::steady_clock::now();
  service.Stop();
  const std::chrono::milliseconds elapsed =
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now() - started);
  Expect(elapsed.count() < 1000,
         "Stop did not join the non-blocking worker in bounded time.");
}

}  // namespace

int main() {
  try {
    TestTcpBidirectionalAndMultipleClients();
    TestUdpBinaryDatagram();
    TestValidationAndBoundedStop();
    std::cout << "Milo network debugging service tests passed.\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
