#include "Milo/MqttDebugService.h"

#include <winsock2.h>
#include <ws2tcpip.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "cloudyi/mqtt_codec.h"

namespace {

void Expect(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

bool WaitReadable(SOCKET socket, int milliseconds) {
  fd_set sockets;
  FD_ZERO(&sockets);
  FD_SET(socket, &sockets);
  timeval timeout = {};
  timeout.tv_sec = milliseconds / 1000;
  timeout.tv_usec = (milliseconds % 1000) * 1000;
  return select(0, &sockets, nullptr, nullptr, &timeout) > 0;
}

bool SendAll(SOCKET socket, const std::vector<unsigned char>& data) {
  std::size_t offset = 0;
  while (offset < data.size()) {
    const int amount = send(socket,
                            reinterpret_cast<const char*>(data.data() + offset),
                            static_cast<int>(data.size() - offset), 0);
    if (amount <= 0) return false;
    offset += static_cast<std::size_t>(amount);
  }
  return true;
}

bool ReceiveFrame(SOCKET socket, std::vector<unsigned char>* frame) {
  frame->clear();
  const std::chrono::steady_clock::time_point deadline =
      std::chrono::steady_clock::now() + std::chrono::seconds(5);
  while (std::chrono::steady_clock::now() < deadline) {
    std::size_t size = 0;
    std::size_t header = 0;
    const int complete = cy_mqtt_frame_length(
        frame->empty() ? nullptr : frame->data(), frame->size(), 1024U * 1024U,
        &size, &header);
    if (complete == 1) {
      frame->resize(size);
      return true;
    }
    if (complete < 0 || !WaitReadable(socket, 100)) return false;
    unsigned char buffer[4096];
    const int amount = recv(socket, reinterpret_cast<char*>(buffer),
                            sizeof(buffer), 0);
    if (amount <= 0) return false;
    frame->insert(frame->end(), buffer, buffer + amount);
  }
  return false;
}

std::uint16_t PacketIdAfterTopic(const std::vector<unsigned char>& packet,
                                 std::size_t header) {
  Expect(header + 2U <= packet.size(), "PUBLISH topic length is missing.");
  const std::size_t topicLength =
      (static_cast<std::size_t>(packet[header]) << 8U) | packet[header + 1U];
  const std::size_t offset = header + 2U + topicLength;
  Expect(offset + 2U <= packet.size(), "PUBLISH packet id is missing.");
  return static_cast<std::uint16_t>((packet[offset] << 8U) | packet[offset + 1U]);
}

bool WaitForState(milo::MqttDebugService* service, const std::string& state,
                  bool* sawMessage = nullptr) {
  const std::chrono::steady_clock::time_point deadline =
      std::chrono::steady_clock::now() + std::chrono::seconds(6);
  while (std::chrono::steady_clock::now() < deadline) {
    const nlohmann::json poll = service->Handle("poll", nlohmann::json::object());
    if (sawMessage != nullptr) {
      const nlohmann::json& events = poll.at("events");
      for (nlohmann::json::const_iterator event = events.begin();
           event != events.end(); ++event) {
        if (event->value("kind", "") == "message" &&
            event->value("topic", "") == "tests/from-broker" &&
            event->value("payloadHex", "") == "6869") {
          *sawMessage = true;
        }
      }
    }
    if (poll.at("snapshot").value("state", "") == state) return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(30));
  }
  return false;
}

nlohmann::json StartPayload(std::uint16_t port) {
  return {{"host", "127.0.0.1"}, {"port", port},
          {"clientId", "cloudyi-loopback-test"}, {"username", ""},
          {"password", ""}, {"keepAlive", 10},
          {"cleanSession", true}, {"tls", false}};
}

void RunBroker(SOCKET listener, std::atomic<bool>* succeeded,
               std::string* failure) {
  try {
    for (int connectionIndex = 0; connectionIndex < 2; ++connectionIndex) {
      Expect(WaitReadable(listener, 6000), "Broker accept timed out.");
      SOCKET peer = accept(listener, nullptr, nullptr);
      Expect(peer != INVALID_SOCKET, "Broker accept failed.");
      std::vector<unsigned char> packet;
      Expect(ReceiveFrame(peer, &packet) && (packet[0] >> 4U) == 1U,
             "Broker did not receive CONNECT.");
      Expect(SendAll(peer, {0x20U, 0x02U, 0x00U, 0x00U}),
             "Broker could not send CONNACK.");
      if (connectionIndex == 0) {
        Expect(ReceiveFrame(peer, &packet) && packet[0] == 0x82U,
               "Broker did not receive SUBSCRIBE.");
        std::size_t frameSize = 0;
        std::size_t headerSize = 0;
        Expect(cy_mqtt_frame_length(packet.data(), packet.size(), 1024U,
                                    &frameSize, &headerSize) == 1,
               "SUBSCRIBE is malformed.");
        const unsigned char idHigh = packet[headerSize];
        const unsigned char idLow = packet[headerSize + 1U];
        Expect(SendAll(peer, {0x90U, 0x03U, idHigh, idLow, 0x01U}),
               "Broker could not send SUBACK.");

        std::vector<unsigned char> publish(128U);
        const unsigned char text[] = {'h', 'i'};
        cy_mqtt_buffer output = {publish.data(), publish.size(), 0};
        Expect(cy_mqtt_encode_publish(42U, "tests/from-broker", text,
                                      sizeof(text), 1U, 0, &output) == 1,
               "Broker PUBLISH encoding failed.");
        publish.resize(output.length);
        Expect(SendAll(peer, publish), "Broker could not send PUBLISH.");
        Expect(ReceiveFrame(peer, &packet) && packet[0] == 0x40U,
               "Client did not acknowledge incoming QoS 1 PUBLISH.");

        Expect(ReceiveFrame(peer, &packet) && (packet[0] & 0xf0U) == 0x30U &&
                   ((packet[0] >> 1U) & 0x03U) == 2U,
               "Broker did not receive outgoing QoS 2 PUBLISH.");
        Expect(cy_mqtt_frame_length(packet.data(), packet.size(), 1024U,
                                    &frameSize, &headerSize) == 1,
               "Outgoing PUBLISH is malformed.");
        const std::uint16_t publishId = PacketIdAfterTopic(packet, headerSize);
        Expect(SendAll(peer, {0x50U, 0x02U,
                              static_cast<unsigned char>(publishId >> 8U),
                              static_cast<unsigned char>(publishId & 0xffU)}),
               "Broker could not send PUBREC.");
        Expect(ReceiveFrame(peer, &packet) && packet[0] == 0x62U,
               "Client did not send PUBREL.");
        // A duplicated PUBREC is legal after loss of PUBREL. The client must
        // resend PUBREL instead of leaving the QoS 2 exchange stuck.
        Expect(SendAll(peer, {0x50U, 0x02U,
                              static_cast<unsigned char>(publishId >> 8U),
                              static_cast<unsigned char>(publishId & 0xffU)}),
               "Broker could not repeat PUBREC.");
        Expect(ReceiveFrame(peer, &packet) && packet[0] == 0x62U,
               "Client did not repeat PUBREL after duplicated PUBREC.");
        Expect(SendAll(peer, {0x70U, 0x02U,
                              static_cast<unsigned char>(publishId >> 8U),
                              static_cast<unsigned char>(publishId & 0xffU)}),
               "Broker could not send PUBCOMP.");
      }
      unsigned char ignored = 0;
      while (WaitReadable(peer, 100)) {
        if (recv(peer, reinterpret_cast<char*>(&ignored), 1, 0) <= 0) break;
      }
      closesocket(peer);
    }
    succeeded->store(true);
  } catch (const std::exception& error) {
    *failure = error.what();
  }
}

void TestLoopbackAndWorkerRestart() {
  SOCKET listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  Expect(listener != INVALID_SOCKET, "Listener socket failed.");
  sockaddr_in endpoint = {};
  endpoint.sin_family = AF_INET;
  endpoint.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  endpoint.sin_port = 0;
  Expect(bind(listener, reinterpret_cast<const sockaddr*>(&endpoint),
              sizeof(endpoint)) == 0 && listen(listener, 2) == 0,
         "Loopback broker listen failed.");
  int endpointSize = sizeof(endpoint);
  Expect(getsockname(listener, reinterpret_cast<sockaddr*>(&endpoint),
                     &endpointSize) == 0,
         "Loopback broker port lookup failed.");
  const std::uint16_t port = ntohs(endpoint.sin_port);

  std::atomic<bool> brokerSucceeded(false);
  std::string brokerFailure;
  std::thread broker(RunBroker, listener, &brokerSucceeded, &brokerFailure);
  try {
    milo::MqttDebugService service;
    nlohmann::json persistent = StartPayload(port);
    persistent["cleanSession"] = false;
    bool persistentRejected = false;
    try { service.Handle("start", persistent); }
    catch (const std::invalid_argument&) { persistentRejected = true; }
    Expect(persistentRejected,
           "Unsupported persistent MQTT session was not rejected.");
    service.Handle("start", StartPayload(port));
    Expect(WaitForState(&service, "connected"), "MQTT client did not connect.");
    service.Handle("subscribe", {{"topic", "tests/+"}, {"qos", 1}});
    bool sawMessage = false;
    const std::chrono::steady_clock::time_point messageDeadline =
        std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (!sawMessage && std::chrono::steady_clock::now() < messageDeadline) {
      (void)WaitForState(&service, "connected", &sawMessage);
    }
    Expect(sawMessage, "Incoming QoS 1 message was not delivered.");
    service.Handle("publish", {{"topic", "tests/to-broker"},
                                {"dataHex", "0001ff"}, {"qos", 2},
                                {"retain", false}});
    std::this_thread::sleep_for(std::chrono::milliseconds(250));

    // Application::CloseDashboard invokes Stop(). Starting again must create a
    // fresh worker rather than leaving the service forever in `connecting`.
    service.Stop();
    service.Handle("start", StartPayload(port));
    Expect(WaitForState(&service, "connected"),
           "MQTT worker did not restart after Stop().");
    service.Stop();
  } catch (...) {
    closesocket(listener);
    if (broker.joinable()) broker.join();
    throw;
  }
  if (broker.joinable()) broker.join();
  closesocket(listener);
  Expect(brokerSucceeded.load(), brokerFailure.c_str());
}

SOCKET CreateLoopbackListener(std::uint16_t* port) {
  SOCKET listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  Expect(listener != INVALID_SOCKET, "Listener socket failed.");
  sockaddr_in endpoint = {};
  endpoint.sin_family = AF_INET;
  endpoint.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  endpoint.sin_port = 0;
  if (bind(listener, reinterpret_cast<const sockaddr*>(&endpoint),
           sizeof(endpoint)) != 0 || listen(listener, 4) != 0) {
    closesocket(listener);
    throw std::runtime_error("Loopback broker listen failed.");
  }
  int endpointSize = sizeof(endpoint);
  if (getsockname(listener, reinterpret_cast<sockaddr*>(&endpoint),
                  &endpointSize) != 0) {
    closesocket(listener);
    throw std::runtime_error("Loopback broker port lookup failed.");
  }
  *port = ntohs(endpoint.sin_port);
  return listener;
}

void TestMalformedTopicsDoNotTerminateWorker() {
  std::uint16_t port = 0;
  SOCKET listener = CreateLoopbackListener(&port);
  std::atomic<bool> brokerDone(false);
  std::thread broker([listener, &brokerDone]() {
    const std::vector<std::vector<unsigned char> > malformed = {
        {0x30U, 0x05U, 0x00U, 0x03U, 'a', 0x00U, 0xffU},
        {0x30U, 0x04U, 0x00U, 0x02U, 0xc0U, 0xafU}};
    for (std::size_t index = 0; index < malformed.size(); ++index) {
      if (!WaitReadable(listener, 6000)) return;
      SOCKET peer = accept(listener, nullptr, nullptr);
      if (peer == INVALID_SOCKET) return;
      std::vector<unsigned char> connect;
      if (!ReceiveFrame(peer, &connect) ||
          !SendAll(peer, {0x20U, 0x02U, 0x00U, 0x00U}) ||
          !SendAll(peer, malformed[index])) {
        closesocket(peer);
        return;
      }
      unsigned char ignored = 0;
      while (WaitReadable(peer, 100)) {
        if (recv(peer, reinterpret_cast<char*>(&ignored), 1, 0) <= 0) break;
      }
      closesocket(peer);
    }
    brokerDone.store(true);
  });
  try {
    milo::MqttDebugService service;
    for (int index = 0; index < 2; ++index) {
      service.Handle("start", StartPayload(port));
      Expect(WaitForState(&service, "error"),
             "Malformed UTF-8 MQTT topic did not fail the session.");
      const nlohmann::json poll = service.Handle("poll", nlohmann::json::object());
      Expect(!poll.at("snapshot").value("lastError", "").empty(),
             "Malformed MQTT topic did not report an error.");
      service.Stop();
    }
  } catch (...) {
    closesocket(listener);
    if (broker.joinable()) broker.join();
    throw;
  }
  if (broker.joinable()) broker.join();
  closesocket(listener);
  Expect(brokerDone.load(), "Malformed-topic broker did not finish.");
}

void TestIncomingTrafficDoesNotSuppressKeepAlive() {
  std::uint16_t port = 0;
  SOCKET listener = CreateLoopbackListener(&port);
  std::atomic<bool> sawPing(false);
  std::thread broker([listener, &sawPing]() {
    if (!WaitReadable(listener, 6000)) return;
    SOCKET peer = accept(listener, nullptr, nullptr);
    if (peer == INVALID_SOCKET) return;
    std::vector<unsigned char> packet;
    if (!ReceiveFrame(peer, &packet) ||
        !SendAll(peer, {0x20U, 0x02U, 0x00U, 0x00U})) {
      closesocket(peer);
      return;
    }
    std::vector<unsigned char> incoming(64U);
    const unsigned char byte = 0x31U;
    cy_mqtt_buffer output = {incoming.data(), incoming.size(), 0};
    if (!cy_mqtt_encode_publish(0U, "tests/traffic", &byte, 1U, 0U, 0,
                                &output)) {
      closesocket(peer);
      return;
    }
    incoming.resize(output.length);
    const std::chrono::steady_clock::time_point deadline =
        std::chrono::steady_clock::now() + std::chrono::seconds(4);
    while (std::chrono::steady_clock::now() < deadline && !sawPing.load()) {
      if (!SendAll(peer, incoming)) break;
      if (WaitReadable(peer, 70) && ReceiveFrame(peer, &packet) &&
          packet.size() == 2U && packet[0] == 0xc0U && packet[1] == 0x00U) {
        sawPing.store(true);
        (void)SendAll(peer, {0xd0U, 0x00U});
        break;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(40));
    }
    unsigned char ignored = 0;
    while (WaitReadable(peer, 100)) {
      if (recv(peer, reinterpret_cast<char*>(&ignored), 1, 0) <= 0) break;
    }
    closesocket(peer);
  });
  try {
    milo::MqttDebugService service;
    nlohmann::json options = StartPayload(port);
    options["keepAlive"] = 5;
    service.Handle("start", options);
    Expect(WaitForState(&service, "connected"),
           "Keepalive test client did not connect.");
    const std::chrono::steady_clock::time_point deadline =
        std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (!sawPing.load() && std::chrono::steady_clock::now() < deadline) {
      (void)service.Handle("poll", nlohmann::json::object());
      std::this_thread::sleep_for(std::chrono::milliseconds(30));
    }
    Expect(sawPing.load(),
           "Continuous incoming QoS 0 traffic incorrectly suppressed PINGREQ.");
    service.Stop();
  } catch (...) {
    closesocket(listener);
    if (broker.joinable()) broker.join();
    throw;
  }
  if (broker.joinable()) broker.join();
  closesocket(listener);
}

void TestTlsHandshakeCanBeCancelled() {
  std::uint16_t port = 0;
  SOCKET listener = CreateLoopbackListener(&port);
  std::thread broker([listener]() {
    if (!WaitReadable(listener, 6000)) return;
    SOCKET peer = accept(listener, nullptr, nullptr);
    if (peer == INVALID_SOCKET) return;
    // Consume the ClientHello, then deliberately withhold a ServerHello.
    unsigned char buffer[4096];
    if (WaitReadable(peer, 3000)) {
      (void)recv(peer, reinterpret_cast<char*>(buffer), sizeof(buffer), 0);
    }
    const std::chrono::steady_clock::time_point deadline =
        std::chrono::steady_clock::now() + std::chrono::seconds(4);
    while (std::chrono::steady_clock::now() < deadline) {
      if (WaitReadable(peer, 100) &&
          recv(peer, reinterpret_cast<char*>(buffer), sizeof(buffer), 0) <= 0) {
        break;
      }
    }
    closesocket(peer);
  });
  try {
    milo::MqttDebugService service;
    nlohmann::json options = StartPayload(port);
    options["tls"] = true;
    service.Handle("start", options);
    std::this_thread::sleep_for(std::chrono::milliseconds(250));
    const std::chrono::steady_clock::time_point began =
        std::chrono::steady_clock::now();
    service.Stop();
    const std::chrono::milliseconds elapsed =
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - began);
    Expect(elapsed.count() < 2000,
           "Stop blocked while cancelling a stalled TLS handshake.");
  } catch (...) {
    closesocket(listener);
    if (broker.joinable()) broker.join();
    throw;
  }
  if (broker.joinable()) broker.join();
  closesocket(listener);
}

}  // namespace

int main() {
  WSADATA winsock = {};
  if (WSAStartup(MAKEWORD(2, 2), &winsock) != 0) {
    std::cerr << "WSAStartup failed.\n";
    return 1;
  }
  try {
    TestLoopbackAndWorkerRestart();
    TestMalformedTopicsDoNotTerminateWorker();
    TestIncomingTrafficDoesNotSuppressKeepAlive();
    TestTlsHandshakeCanBeCancelled();
    std::cout << "MQTT service loopback tests passed.\n";
    WSACleanup();
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    WSACleanup();
    return 1;
  }
}
