#include "cloudyi/mqtt_codec.h"

#include <cstring>
#include <iostream>
#include <stdexcept>
#include <vector>

namespace {

void Expect(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

void TestConnectPacket() {
  std::vector<unsigned char> storage(256U);
  cy_mqtt_buffer output = {storage.data(), storage.size(), 0};
  cy_mqtt_connect_options options = {};
  options.client_id = "cloudyi-test";
  options.username = "user";
  options.password = "secret";
  options.keep_alive_seconds = 30;
  options.clean_session = 1;
  Expect(cy_mqtt_encode_connect(&options, &output) == 1,
         "CONNECT encoding failed.");
  Expect(output.length > 20U && storage[0] == 0x10U,
         "CONNECT fixed header is invalid.");
  Expect(storage[9] == 0xc2U, "CONNECT flags are invalid.");
  std::size_t frame = 0;
  std::size_t header = 0;
  Expect(cy_mqtt_frame_length(storage.data(), output.length, 1024U, &frame,
                              &header) == 1 &&
             frame == output.length && header == 2U,
         "CONNECT frame length was not decoded.");
}

void TestTopicsAndCommands() {
  Expect(cy_mqtt_valid_topic_name("devices/demo/value") == 1,
         "A publish topic was rejected.");
  Expect(cy_mqtt_valid_topic_name("devices/+/value") == 0,
         "A wildcard publish topic was accepted.");
  Expect(cy_mqtt_valid_topic_filter("devices/+/value") == 1 &&
             cy_mqtt_valid_topic_filter("devices/#") == 1,
         "Valid subscription filters were rejected.");
  Expect(cy_mqtt_valid_topic_filter("devices/#/value") == 0 &&
             cy_mqtt_valid_topic_filter("device+bad") == 0,
         "Malformed subscription filters were accepted.");

  std::vector<unsigned char> storage(256U);
  cy_mqtt_buffer output = {storage.data(), storage.size(), 0};
  Expect(cy_mqtt_encode_subscribe(7U, "devices/+", 1U, &output) == 1 &&
             storage[0] == 0x82U,
         "SUBSCRIBE encoding failed.");
  const unsigned char payload[] = {0x00U, 0x7fU, 0xffU};
  Expect(cy_mqtt_encode_publish(8U, "devices/value", payload,
                                sizeof(payload), 2U, 1, &output) == 1 &&
             storage[0] == 0x35U,
         "QoS 2 retained PUBLISH encoding failed.");
}

void TestFrameBounds() {
  const unsigned char incomplete[] = {0x30U, 0x80U};
  std::size_t frame = 0;
  std::size_t header = 0;
  Expect(cy_mqtt_frame_length(incomplete, sizeof(incomplete), 1024U, &frame,
                              &header) == 0,
         "Incomplete remaining length was not detected.");
  const unsigned char malformed[] = {0x30U, 0xffU, 0xffU, 0xffU, 0xffU, 0x01U};
  Expect(cy_mqtt_frame_length(malformed, sizeof(malformed), 1024U, &frame,
                              &header) == -1,
         "Five-byte remaining length was accepted.");
}

}  // namespace

int main() {
  try {
    TestConnectPacket();
    TestTopicsAndCommands();
    TestFrameBounds();
    std::cout << "MQTT codec tests passed.\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
