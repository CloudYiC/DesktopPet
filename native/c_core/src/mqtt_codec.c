#include "cloudyi/mqtt_codec.h"

#include <string.h>

#define CY_MQTT_MAX_REMAINING_LENGTH 268435455u

static int append_byte(cy_mqtt_buffer* output, uint8_t value) {
  if (output == NULL || output->data == NULL ||
      output->length >= output->capacity) {
    return 0;
  }
  output->data[output->length++] = value;
  return 1;
}

static int append_bytes(cy_mqtt_buffer* output, const uint8_t* data,
                        size_t size) {
  if (output == NULL || (size != 0 && data == NULL) ||
      size > output->capacity - output->length) {
    return 0;
  }
  if (size != 0) memcpy(output->data + output->length, data, size);
  output->length += size;
  return 1;
}

static int append_u16(cy_mqtt_buffer* output, uint16_t value) {
  return append_byte(output, (uint8_t)(value >> 8)) &&
         append_byte(output, (uint8_t)(value & 0xffu));
}

static int valid_utf8_field(const char* value, size_t* length) {
  size_t size;
  size_t index = 0;
  if (value == NULL || length == NULL) return 0;
  size = strlen(value);
  if (size > 65535u) return 0;
  while (index < size) {
    const uint8_t first = (uint8_t)value[index++];
    uint32_t codepoint;
    unsigned continuation;
    unsigned consumed;
    if (first < 0x80u) {
      codepoint = first;
      continuation = 0;
    } else if ((first & 0xe0u) == 0xc0u) {
      codepoint = first & 0x1fu;
      continuation = 1;
      if (codepoint < 2u) return 0; /* Reject overlong 2-byte sequences. */
    } else if ((first & 0xf0u) == 0xe0u) {
      codepoint = first & 0x0fu;
      continuation = 2;
    } else if ((first & 0xf8u) == 0xf0u) {
      codepoint = first & 0x07u;
      continuation = 3;
      if (codepoint > 4u) return 0;
    } else {
      return 0;
    }
    if (index + continuation > size) return 0;
    for (consumed = 0; consumed < continuation; ++consumed) {
      const uint8_t next = (uint8_t)value[index++];
      if ((next & 0xc0u) != 0x80u) return 0;
      codepoint = (codepoint << 6u) | (next & 0x3fu);
    }
    if ((continuation == 2u && codepoint < 0x800u) ||
        (continuation == 3u && codepoint < 0x10000u) ||
        codepoint == 0u || codepoint > 0x10ffffu ||
        (codepoint >= 0xd800u && codepoint <= 0xdfffu) ||
        (codepoint >= 0xfdd0u && codepoint <= 0xfdefu) ||
        (codepoint & 0xffffu) == 0xfffeu ||
        (codepoint & 0xffffu) == 0xffffu) {
      return 0;
    }
  }
  *length = size;
  return 1;
}

static int append_utf8(cy_mqtt_buffer* output, const char* value,
                       int allow_empty) {
  size_t size = 0;
  if (!valid_utf8_field(value, &size) || (!allow_empty && size == 0)) return 0;
  return append_u16(output, (uint16_t)size) &&
         append_bytes(output, (const uint8_t*)value, size);
}

static int append_remaining_length(cy_mqtt_buffer* output, size_t length) {
  unsigned count = 0;
  if (length > CY_MQTT_MAX_REMAINING_LENGTH) return 0;
  do {
    uint8_t encoded = (uint8_t)(length % 128u);
    length /= 128u;
    if (length != 0) encoded = (uint8_t)(encoded | 0x80u);
    if (!append_byte(output, encoded)) return 0;
    ++count;
  } while (length != 0 && count < 4u);
  return length == 0;
}

static int begin_packet(cy_mqtt_buffer* output, uint8_t first_byte,
                        size_t remaining_length) {
  if (output == NULL) return 0;
  output->length = 0;
  return append_byte(output, first_byte) &&
         append_remaining_length(output, remaining_length);
}

int cy_mqtt_valid_topic_name(const char* topic) {
  size_t index;
  size_t length;
  if (!valid_utf8_field(topic, &length) || length == 0) return 0;
  for (index = 0; index < length; ++index) {
    if (topic[index] == '+' || topic[index] == '#') return 0;
  }
  return 1;
}

int cy_mqtt_valid_topic_filter(const char* filter) {
  size_t index;
  size_t length;
  if (!valid_utf8_field(filter, &length) || length == 0) return 0;
  for (index = 0; index < length; ++index) {
    if (filter[index] == '#') {
      if (index + 1u != length || (index != 0 && filter[index - 1u] != '/')) {
        return 0;
      }
    } else if (filter[index] == '+') {
      if ((index != 0 && filter[index - 1u] != '/') ||
          (index + 1u != length && filter[index + 1u] != '/')) {
        return 0;
      }
    }
  }
  return 1;
}

int cy_mqtt_encode_connect(const cy_mqtt_connect_options* options,
                           cy_mqtt_buffer* output) {
  size_t client_length = 0;
  size_t user_length = 0;
  size_t password_length = 0;
  size_t remaining;
  uint8_t flags = 0;
  if (options == NULL || output == NULL ||
      !valid_utf8_field(options->client_id, &client_length) ||
      client_length == 0) {
    return 0;
  }
  if (options->username != NULL) {
    if (!valid_utf8_field(options->username, &user_length)) return 0;
    flags = (uint8_t)(flags | 0x80u);
  }
  if (options->password != NULL) {
    if (options->username == NULL ||
        !valid_utf8_field(options->password, &password_length)) {
      return 0;
    }
    flags = (uint8_t)(flags | 0x40u);
  }
  if (options->clean_session) flags = (uint8_t)(flags | 0x02u);
  remaining = 10u + 2u + client_length;
  if (options->username != NULL) remaining += 2u + user_length;
  if (options->password != NULL) remaining += 2u + password_length;
  if (!begin_packet(output, 0x10u, remaining) ||
      !append_u16(output, 4u) ||
      !append_bytes(output, (const uint8_t*)"MQTT", 4u) ||
      !append_byte(output, 4u) || !append_byte(output, flags) ||
      !append_u16(output, options->keep_alive_seconds) ||
      !append_utf8(output, options->client_id, 0)) {
    output->length = 0;
    return 0;
  }
  if (options->username != NULL &&
      !append_utf8(output, options->username, 1)) {
    output->length = 0;
    return 0;
  }
  if (options->password != NULL &&
      !append_utf8(output, options->password, 1)) {
    output->length = 0;
    return 0;
  }
  return 1;
}

int cy_mqtt_encode_subscribe(uint16_t packet_id, const char* topic_filter,
                             uint8_t qos, cy_mqtt_buffer* output) {
  size_t length = 0;
  if (packet_id == 0 || qos > 2 || !cy_mqtt_valid_topic_filter(topic_filter) ||
      !valid_utf8_field(topic_filter, &length) ||
      !begin_packet(output, 0x82u, 2u + 2u + length + 1u) ||
      !append_u16(output, packet_id) ||
      !append_utf8(output, topic_filter, 0) || !append_byte(output, qos)) {
    if (output != NULL) output->length = 0;
    return 0;
  }
  return 1;
}

int cy_mqtt_encode_unsubscribe(uint16_t packet_id, const char* topic_filter,
                               cy_mqtt_buffer* output) {
  size_t length = 0;
  if (packet_id == 0 || !cy_mqtt_valid_topic_filter(topic_filter) ||
      !valid_utf8_field(topic_filter, &length) ||
      !begin_packet(output, 0xa2u, 2u + 2u + length) ||
      !append_u16(output, packet_id) ||
      !append_utf8(output, topic_filter, 0)) {
    if (output != NULL) output->length = 0;
    return 0;
  }
  return 1;
}

int cy_mqtt_encode_publish(uint16_t packet_id, const char* topic,
                           const uint8_t* payload, size_t payload_size,
                           uint8_t qos, int retain, cy_mqtt_buffer* output) {
  size_t topic_length = 0;
  size_t remaining;
  uint8_t first_byte;
  if (qos > 2 || (qos != 0 && packet_id == 0) ||
      !cy_mqtt_valid_topic_name(topic) ||
      !valid_utf8_field(topic, &topic_length) ||
      (payload_size != 0 && payload == NULL)) {
    if (output != NULL) output->length = 0;
    return 0;
  }
  remaining = 2u + topic_length + payload_size + (qos == 0 ? 0u : 2u);
  first_byte = (uint8_t)(0x30u | (qos << 1u) | (retain ? 1u : 0u));
  if (!begin_packet(output, first_byte, remaining) ||
      !append_utf8(output, topic, 0) ||
      (qos != 0 && !append_u16(output, packet_id)) ||
      !append_bytes(output, payload, payload_size)) {
    if (output != NULL) output->length = 0;
    return 0;
  }
  return 1;
}

int cy_mqtt_encode_packet_id(uint8_t first_byte, uint16_t packet_id,
                             cy_mqtt_buffer* output) {
  if (packet_id == 0 || !begin_packet(output, first_byte, 2u) ||
      !append_u16(output, packet_id)) {
    if (output != NULL) output->length = 0;
    return 0;
  }
  return 1;
}

int cy_mqtt_encode_simple(uint8_t first_byte, cy_mqtt_buffer* output) {
  return begin_packet(output, first_byte, 0u);
}

int cy_mqtt_frame_length(const uint8_t* data, size_t size,
                         size_t maximum_packet_size, size_t* frame_size,
                         size_t* header_size) {
  size_t remaining = 0;
  size_t multiplier = 1;
  size_t index = 1;
  unsigned count = 0;
  if (frame_size == NULL || header_size == NULL ||
      (size != 0 && data == NULL)) {
    return -1;
  }
  *frame_size = 0;
  *header_size = 0;
  if (size < 2u) return 0;
  do {
    uint8_t byte;
    if (index >= size) return 0;
    byte = data[index++];
    remaining += (size_t)(byte & 0x7fu) * multiplier;
    ++count;
    if (remaining > CY_MQTT_MAX_REMAINING_LENGTH || count > 4u) return -1;
    if ((byte & 0x80u) == 0) break;
    if (count == 4u) return -1;
    multiplier *= 128u;
  } while (1);
  if (remaining > maximum_packet_size || index > maximum_packet_size - remaining) {
    return -1;
  }
  *header_size = index;
  *frame_size = index + remaining;
  return size < *frame_size ? 0 : 1;
}
