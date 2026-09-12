#include "cloudyi/modbus_protocol.h"
#include <stdio.h>
#include <string.h>
#define CHECK(x) do { if (!(x)) { fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #x); return 1; } } while (0)
int main(void) {
  cy_mb_request r; cy_mb_response result;
  uint8_t frame[CY_MB_MAX_ADU], response[CY_MB_MAX_ADU]; size_t size;
  const uint8_t known[] = {1, 3, 0, 0, 0, 10};
  memset(&r, 0, sizeof(r)); r.unit = 1; r.function = 3; r.quantity = 2;
  CHECK(cy_mb_crc16(known, sizeof(known)) == 0xcdc5);
  CHECK(cy_mb_validate(&r) == NULL);
  size = cy_mb_build(&r, 1, 0x1234, frame, sizeof(frame));
  CHECK(size == 12 && frame[0] == 0x12 && frame[1] == 0x34 && frame[5] == 6 && frame[11] == 2);
  { const uint8_t bytes[] = {0x12,0x34,0,0,0,7,1,3,4,0,25,0xff,0xff}; memcpy(response, bytes, sizeof(bytes)); size = sizeof(bytes); }
  CHECK(cy_mb_parse(&r, 1, 0x1234, response, size, &result) == NULL);
  CHECK(result.count == 2 && result.values[0] == 25 && result.values[1] == 65535);
  CHECK(cy_mb_parse(&r, 1, 0x1235, response, size, &result) != NULL);
  CHECK(cy_mb_parse(&r, 1, 0x1234, response, 0, &result) != NULL);
  CHECK(cy_mb_frame_size(response, 5, 1) == 0);
  CHECK(cy_mb_frame_size(response, 6, 1) == 13);
  CHECK(cy_mb_parse(&r, 1, 0x1234, response, size - 1, &result) != NULL);
  response[8] = 2; CHECK(cy_mb_parse(&r, 1, 0x1234, response, size, &result) != NULL); response[8] = 4;
  response[2] = 1; CHECK(cy_mb_frame_size(response, 6, 1) == -1); response[2] = 0;
  { uint8_t bytes[] = {1,3,4,0,25,0xff,0xff,0,0}; uint16_t crc = cy_mb_crc16(bytes, 7); bytes[7] = (uint8_t)crc; bytes[8] = (uint8_t)(crc >> 8); memcpy(response, bytes, sizeof(bytes)); size = sizeof(bytes); }
  CHECK(cy_mb_parse(&r, 0, 0, response, size, &result) == NULL);
  response[size - 1] ^= 1; CHECK(cy_mb_parse(&r, 0, 0, response, size, &result) != NULL);
  { const uint8_t bytes[] = {0,1,0,0,0,3,1,0x83,2}; memcpy(response, bytes, sizeof(bytes)); size = sizeof(bytes); }
  CHECK(cy_mb_parse(&r, 1, 1, response, size, &result) == NULL && result.exception == 2 && result.count == 0);
  r.function = 1; r.quantity = 9;
  { const uint8_t bytes[] = {0,1,0,0,0,5,1,1,2,0x85,1}; memcpy(response, bytes, sizeof(bytes)); size = sizeof(bytes); }
  CHECK(cy_mb_parse(&r, 1, 1, response, size, &result) == NULL && result.count == 9 && result.values[0] == 1 && result.values[1] == 0 && result.values[8] == 1);
  r.function = 15; r.quantity = 9; r.value_count = 9; r.values[0] = 1; r.values[8] = 1;
  size = cy_mb_build(&r, 1, 1, frame, sizeof(frame)); CHECK(size == 15 && frame[12] == 2 && frame[13] == 1 && frame[14] == 1);
  { const uint8_t bytes[] = {0,1,0,0,0,6,1,15,0,0,0,9}; memcpy(response, bytes, sizeof(bytes)); size = sizeof(bytes); }
  CHECK(cy_mb_parse(&r, 1, 1, response, size, &result) == NULL && result.count == 9);
  response[11] = 8; CHECK(cy_mb_parse(&r, 1, 1, response, size, &result) != NULL);
  r.function = 5; r.quantity = 1; r.value_count = 1; r.values[0] = 1;
  CHECK(cy_mb_build(&r, 0, 0, frame, sizeof(frame)) == 8 && frame[4] == 0xff && frame[5] == 0);
  CHECK(cy_mb_parse(&r, 0, 0, frame, 8, &result) == NULL);
  r.values[0] = 2; CHECK(cy_mb_validate(&r) != NULL);
  memset(&r, 0, sizeof(r)); r.unit = 1; r.function = 16; r.quantity = 123; r.value_count = 123;
  CHECK(cy_mb_build(&r, 1, 1, frame, sizeof(frame)) == 259);
  r.quantity = 124; r.value_count = 124; CHECK(cy_mb_validate(&r) != NULL);
  r.function = 3; r.quantity = 1; r.value_count = 0; r.address = 65535; CHECK(cy_mb_validate(&r) == NULL);
  r.quantity = 2; CHECK(cy_mb_validate(&r) != NULL); r.quantity = 1; r.unit = 0; CHECK(cy_mb_validate(&r) != NULL);
  r.unit = 248; CHECK(cy_mb_validate(&r) != NULL); r.unit = 1; r.function = 7; CHECK(cy_mb_validate(&r) != NULL);
  puts("PASS Modbus C protocol: CRC, MBAP, partial headers, counts, coils, all write framing, exceptions and bounds.");
  return 0;
}
