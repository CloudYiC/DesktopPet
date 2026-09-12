#include "cloudyi/modbus_protocol.h"
#include <string.h>

static uint16_t be16(const uint8_t* p) { return (uint16_t)(((unsigned)p[0] << 8) | p[1]); }
static void put16(uint8_t* p, uint16_t n) { p[0] = (uint8_t)(n >> 8); p[1] = (uint8_t)n; }
int cy_mb_is_write(unsigned f) { return f == 5 || f == 6 || f == 15 || f == 16; }

const char* cy_mb_validate(const cy_mb_request* r) {
  unsigned limit;
  size_t i;
  if (!r) return "Missing request";
  if (r->unit < 1 || r->unit > 247) return "Unit ID must be 1..247; broadcast is prohibited";
  switch (r->function) {
    case 1: case 2: limit = 2000; break;
    case 3: case 4: limit = 125; break;
    case 5: case 6: limit = 1; break;
    case 15: limit = 1968; break;
    case 16: limit = 123; break;
    default: return "Unsupported function code";
  }
  if (r->quantity < 1 || r->quantity > limit) return "Quantity is outside the function limit";
  if ((unsigned)r->address + r->quantity > 65536U) return "Address range exceeds 65535";
  if (cy_mb_is_write(r->function)) {
    if (r->value_count != r->quantity) return "Write value count must match quantity";
    if (r->function == 5 || r->function == 15)
      for (i = 0; i < r->value_count; ++i) if (r->values[i] > 1) return "Coils accept only 0 or 1";
  } else if (r->value_count) return "Read requests must not contain write values";
  return NULL;
}

uint16_t cy_mb_crc16(const uint8_t* bytes, size_t size) {
  uint16_t crc = 0xffff;
  size_t i;
  unsigned bit;
  for (i = 0; i < size; ++i) {
    crc ^= bytes[i];
    for (bit = 0; bit < 8; ++bit) crc = (uint16_t)((crc >> 1) ^ ((crc & 1) ? 0xa001 : 0));
  }
  return crc;
}

size_t cy_mb_build(const cy_mb_request* r, int tcp, uint16_t transaction, uint8_t* out, size_t capacity) {
  size_t p = tcp ? 7 : 1, i, bytes;
  uint16_t crc;
  if (!out || capacity < CY_MB_MAX_ADU || cy_mb_validate(r)) return 0;
  memset(out, 0, capacity);
  out[tcp ? 6 : 0] = r->unit;
  out[p++] = r->function;
  put16(out + p, r->address); p += 2;
  if (r->function == 5 || r->function == 6) {
    put16(out + p, r->function == 5 ? (r->values[0] ? 0xff00 : 0) : r->values[0]); p += 2;
  } else {
    put16(out + p, r->quantity); p += 2;
    if (r->function == 15) {
      bytes = (r->quantity + 7U) / 8U; out[p++] = (uint8_t)bytes;
      for (i = 0; i < r->quantity; ++i) if (r->values[i]) out[p + i / 8] |= (uint8_t)(1U << (i % 8));
      p += bytes;
    } else if (r->function == 16) {
      out[p++] = (uint8_t)(r->quantity * 2U);
      for (i = 0; i < r->quantity; ++i) { put16(out + p, r->values[i]); p += 2; }
    }
  }
  if (tcp) { put16(out, transaction); put16(out + 4, (uint16_t)(p - 6)); }
  else { crc = cy_mb_crc16(out, p); out[p++] = (uint8_t)crc; out[p++] = (uint8_t)(crc >> 8); }
  return p;
}

int cy_mb_frame_size(const uint8_t* p, size_t n, int tcp) {
  unsigned f;
  if (!p) return -1;
  if (tcp) {
    unsigned length;
    if (n < 6) return 0;
    length = be16(p + 4);
    if (be16(p + 2) != 0 || length < 3 || length > 254) return -1;
    return (int)(6 + length);
  }
  if (n < 2) return 0;
  f = p[1];
  if (f & 0x80) return 5;
  if (f == 5 || f == 6 || f == 15 || f == 16) return 8;
  if (f < 1 || f > 4) return -1;
  if (n < 3) return 0;
  if (p[2] < 1 || p[2] > 250) return -1;
  return p[2] + 5;
}

const char* cy_mb_parse(const cy_mb_request* r, int tcp, uint16_t transaction, const uint8_t* bytes, size_t size, cy_mb_response* result) {
  const uint8_t* p;
  size_t n, i;
  unsigned expected;
  uint16_t crc;
  if (cy_mb_validate(r) || !bytes || !result) return "Invalid parser arguments";
  memset(result, 0, sizeof(*result));
  if (size < 5 || cy_mb_frame_size(bytes, size, tcp) != (int)size) return "Invalid or truncated response length";
  if (tcp) {
    if (be16(bytes) != transaction) return "Transaction ID mismatch";
    if (bytes[6] != r->unit) return "Unit ID mismatch";
    p = bytes + 7; n = size - 7;
  } else {
    crc = cy_mb_crc16(bytes, size - 2);
    if (bytes[size - 2] != (uint8_t)crc || bytes[size - 1] != (uint8_t)(crc >> 8)) return "RTU CRC mismatch";
    if (bytes[0] != r->unit) return "Unit ID mismatch";
    p = bytes + 1; n = size - 3;
  }
  if (p[0] == (uint8_t)(r->function | 0x80)) {
    if (n != 2 || p[1] == 0) return "Invalid exception response";
    result->exception = p[1]; return NULL;
  }
  if (p[0] != r->function) return "Function code mismatch";
  if (cy_mb_is_write(r->function)) {
    expected = r->function == 5 ? (r->values[0] ? 0xff00 : 0) : r->function == 6 ? r->values[0] : r->quantity;
    if (n != 5 || be16(p + 1) != r->address || be16(p + 3) != expected) return "Write acknowledgement does not match request";
    result->count = r->quantity;
    for (i = 0; i < result->count; ++i) result->values[i] = r->values[i];
  } else {
    expected = r->function <= 2 ? (r->quantity + 7U) / 8U : r->quantity * 2U;
    if (n != 2 + expected || p[1] != expected) return "Byte count does not match requested quantity";
    result->count = r->quantity;
    for (i = 0; i < result->count; ++i) result->values[i] = r->function <= 2 ? (uint16_t)((p[2 + i / 8] >> (i % 8)) & 1) : be16(p + 2 + i * 2);
  }
  return NULL;
}
