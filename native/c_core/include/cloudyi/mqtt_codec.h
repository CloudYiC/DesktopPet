#ifndef CLOUDYI_MQTT_CODEC_H
#define CLOUDYI_MQTT_CODEC_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* MQTT 3.1.1 packet construction is kept in C so it can be audited and reused. */

typedef struct cy_mqtt_buffer {
  uint8_t* data;
  size_t capacity;
  size_t length;
} cy_mqtt_buffer;

typedef struct cy_mqtt_connect_options {
  const char* client_id;
  const char* username;
  const char* password;
  uint16_t keep_alive_seconds;
  int clean_session;
} cy_mqtt_connect_options;

/* Returns 1 on success and 0 when input or output capacity is invalid. */
int cy_mqtt_encode_connect(const cy_mqtt_connect_options* options,
                           cy_mqtt_buffer* output);
int cy_mqtt_encode_subscribe(uint16_t packet_id, const char* topic_filter,
                             uint8_t qos, cy_mqtt_buffer* output);
int cy_mqtt_encode_unsubscribe(uint16_t packet_id, const char* topic_filter,
                               cy_mqtt_buffer* output);
int cy_mqtt_encode_publish(uint16_t packet_id, const char* topic,
                           const uint8_t* payload, size_t payload_size,
                           uint8_t qos, int retain, cy_mqtt_buffer* output);
int cy_mqtt_encode_packet_id(uint8_t first_byte, uint16_t packet_id,
                             cy_mqtt_buffer* output);
int cy_mqtt_encode_simple(uint8_t first_byte, cy_mqtt_buffer* output);

/* 1 = complete frame, 0 = more bytes required, -1 = malformed/oversized. */
int cy_mqtt_frame_length(const uint8_t* data, size_t size,
                         size_t maximum_packet_size, size_t* frame_size,
                         size_t* header_size);

/* Topic names are for publish; filters are for subscribe/unsubscribe. */
int cy_mqtt_valid_topic_name(const char* topic);
int cy_mqtt_valid_topic_filter(const char* filter);

#ifdef __cplusplus
}
#endif

#endif
