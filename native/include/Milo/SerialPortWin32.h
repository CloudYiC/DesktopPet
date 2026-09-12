#pragma once
/* C-only Win32 overlapped serial transport. Its owner must use it on one worker. */
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef struct cy_serial_port cy_serial_port;
typedef struct cy_serial_options {
  char port[16];
  unsigned long baud;
  int data_bits;
  int parity; /* 0 none, 1 odd, 2 even, 3 mark, 4 space */
  int stop_bits; /* 0 one, 1 one-and-half, 2 two */
  int flow; /* 0 none, 1 RTS/CTS, 2 XON/XOFF */
  int dtr;
  int rts;
} cy_serial_options;
typedef struct cy_serial_port_entry { char port[16]; char device[256]; } cy_serial_port_entry;
int cy_serial_valid_options(const cy_serial_options* options);
/* Validates the complete bounded hex input before writing any output byte. */
int cy_serial_decode_hex(const char* hex, size_t length, unsigned char* output, size_t capacity, size_t* count);
int cy_serial_enumerate(cy_serial_port_entry* ports, size_t capacity, unsigned long* error);
cy_serial_port* cy_serial_open(const cy_serial_options* options, unsigned long* error);
/* Returns bytes read, zero if pending/no data, or -1 on a device error. */
int cy_serial_read(cy_serial_port* port, unsigned char* bytes, size_t capacity, unsigned long* error);
int cy_serial_write_begin(cy_serial_port* port, const unsigned char* bytes, size_t count, unsigned long* error);
/* Returns 0 while pending, 1 on completion (including a partial write), -1 on error. */
int cy_serial_write_poll(cy_serial_port* port, size_t* written, unsigned long* error);
void cy_serial_close(cy_serial_port* port);
#ifdef __cplusplus
}
#endif
