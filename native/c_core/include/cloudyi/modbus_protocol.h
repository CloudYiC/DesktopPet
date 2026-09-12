#ifndef CLOUDYI_MODBUS_PROTOCOL_H
#define CLOUDYI_MODBUS_PROTOCOL_H
/* Portable Modbus application framing. No IO, allocation, or device access.
 * Limits follow Modbus Application Protocol V1.1b3. Addresses are zero-based. */
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
#define CY_MB_MAX_VALUES 2000
#define CY_MB_MAX_ADU 260
typedef struct cy_mb_request {
  uint8_t unit;
  uint8_t function;
  uint16_t address;
  uint16_t quantity;
  uint16_t values[CY_MB_MAX_VALUES];
  size_t value_count;
} cy_mb_request;
typedef struct cy_mb_response {
  uint16_t values[CY_MB_MAX_VALUES];
  size_t count;
  uint8_t exception;
} cy_mb_response;
int cy_mb_is_write(unsigned function);
const char* cy_mb_validate(const cy_mb_request* request);
uint16_t cy_mb_crc16(const uint8_t* bytes, size_t size);
/* Build returns zero on invalid arguments; output capacity must be >=260. */
size_t cy_mb_build(const cy_mb_request* request, int tcp, uint16_t transaction,
                   uint8_t* output, size_t capacity);
/* Expected full ADU size, 0 while header is incomplete, -1 for invalid header. */
int cy_mb_frame_size(const uint8_t* bytes, size_t size, int tcp);
/* NULL means a valid normal or exception response. Non-NULL is an error string.
 * Exception responses are represented by response.exception, never as data. */
const char* cy_mb_parse(const cy_mb_request* request, int tcp, uint16_t transaction,
                       const uint8_t* bytes, size_t size, cy_mb_response* response);
#ifdef __cplusplus
}
#endif
#endif
