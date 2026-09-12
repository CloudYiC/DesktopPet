#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include "Milo/SerialPortWin32.h"

struct cy_serial_port {
  HANDLE handle;
  OVERLAPPED read;
  OVERLAPPED write;
  int reading;
  int writing;
  int write_ready;
  DWORD written;
  unsigned char receive[16384];
  unsigned char transmit[65536];
};

static int hex_digit(char value) {
  if (value >= '0' && value <= '9') return value - '0';
  if (value >= 'a' && value <= 'f') return value - 'a' + 10;
  if (value >= 'A' && value <= 'F') return value - 'A' + 10;
  return -1;
}

int cy_serial_decode_hex(const char* hex, size_t length, unsigned char* output, size_t capacity, size_t* count) {
  size_t index;
  if (count) *count = 0;
  if (!hex || !output || !count || !length || length % 2 || length > 131072 || capacity < length / 2) return 0;
  for (index = 0; index < length; ++index) if (hex_digit(hex[index]) < 0) return 0;
  for (index = 0; index < length; index += 2) output[index / 2] = (unsigned char)(hex_digit(hex[index]) * 16 + hex_digit(hex[index + 1]));
  *count = length / 2; return 1;
}

static int valid_port(const char* name) {
  size_t index;
  unsigned int number = 0;
  if (!name || name[0] != 'C' || name[1] != 'O' || name[2] != 'M' || name[3] < '1' || name[3] > '9') return 0;
  for (index = 3; index < 9 && name[index]; ++index) {
    if (name[index] < '0' || name[index] > '9') return 0;
    number = number * 10 + (unsigned int)(name[index] - '0');
    if (number > 65535) return 0;
  }
  return name[index] == '\0' && number > 0;
}

int cy_serial_valid_options(const cy_serial_options* options) {
  return options && valid_port(options->port) && options->baud >= 50 && options->baud <= 4000000
    && options->data_bits >= 5 && options->data_bits <= 8 && options->parity >= 0 && options->parity <= 4
    && options->stop_bits >= 0 && options->stop_bits <= 2 && options->flow >= 0 && options->flow <= 2
    && !(options->stop_bits == 1 && options->data_bits != 5) && !(options->stop_bits == 2 && options->data_bits == 5)
    && (options->dtr == 0 || options->dtr == 1) && (options->rts == 0 || options->rts == 1);
}

int cy_serial_enumerate(cy_serial_port_entry* ports, size_t capacity, unsigned long* error) {
  HKEY key;
  DWORD index;
  size_t count = 0;
  LONG result;
  if (!ports && capacity) { if (error) *error = ERROR_INVALID_PARAMETER; return -1; }
  result = RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"HARDWARE\\DEVICEMAP\\SERIALCOMM", 0, KEY_QUERY_VALUE, &key);
  if (error) *error = 0;
  if (result == ERROR_FILE_NOT_FOUND) return 0;
  if (result != ERROR_SUCCESS) { if (error) *error = (unsigned long)result; return -1; }
  for (index = 0; index < 4096 && count < capacity; ++index) {
    wchar_t name[256], value[32];
    DWORD name_size = 255, value_size = sizeof(value), type = 0;
    char port[16] = {0};
    memset(value, 0, sizeof(value));
    result = RegEnumValueW(key, index, name, &name_size, NULL, &type, (BYTE*)value, &value_size);
    if (result == ERROR_NO_MORE_ITEMS) break;
    if (result != ERROR_SUCCESS || type != REG_SZ) continue;
    value[31] = 0; name[255] = 0;
    if (!WideCharToMultiByte(CP_UTF8, 0, value, -1, port, sizeof(port), NULL, NULL) || !valid_port(port)) continue;
    memset(&ports[count], 0, sizeof(ports[count]));
    memcpy(ports[count].port, port, sizeof(port));
    WideCharToMultiByte(CP_UTF8, 0, name, -1, ports[count].device, sizeof(ports[count].device), NULL, NULL);
    ++count;
  }
  RegCloseKey(key);
  return (int)count;
}

void cy_serial_close(cy_serial_port* port) {
  DWORD transferred;
  if (!port) return;
  if (port->handle != INVALID_HANDLE_VALUE) {
    /* Await cancelled operations before their OVERLAPPED storage is released. */
    CancelIoEx(port->handle, NULL);
    if (port->reading) GetOverlappedResult(port->handle, &port->read, &transferred, TRUE);
    if (port->writing) GetOverlappedResult(port->handle, &port->write, &transferred, TRUE);
    CloseHandle(port->handle);
  }
  if (port->read.hEvent) CloseHandle(port->read.hEvent);
  if (port->write.hEvent) CloseHandle(port->write.hEvent);
  free(port);
}

cy_serial_port* cy_serial_open(const cy_serial_options* options, unsigned long* error) {
  cy_serial_port* port;
  DCB dcb;
  COMMTIMEOUTS timeouts;
  char path[24];
  if (!cy_serial_valid_options(options)) { if (error) *error = ERROR_INVALID_PARAMETER; return NULL; }
  port = (cy_serial_port*)calloc(1, sizeof(*port));
  if (!port) { if (error) *error = ERROR_NOT_ENOUGH_MEMORY; return NULL; }
  port->handle = INVALID_HANDLE_VALUE;
  sprintf_s(path, sizeof(path), "\\\\.\\%s", options->port);
  port->handle = CreateFileA(path, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING, FILE_FLAG_OVERLAPPED, NULL);
  if (port->handle == INVALID_HANDLE_VALUE) goto failure;
  port->read.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  port->write.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (!port->read.hEvent || !port->write.hEvent) goto failure;
  memset(&dcb, 0, sizeof(dcb)); dcb.DCBlength = sizeof(dcb);
  if (!GetCommState(port->handle, &dcb)) goto failure;
  dcb.BaudRate = options->baud;
  dcb.ByteSize = (BYTE)options->data_bits;
  dcb.Parity = (BYTE)options->parity;
  dcb.StopBits = (BYTE)options->stop_bits;
  dcb.fBinary = TRUE;
  dcb.fParity = options->parity != NOPARITY;
  dcb.fOutxCtsFlow = options->flow == 1;
  dcb.fOutxDsrFlow = FALSE;
  dcb.fDtrControl = options->dtr ? DTR_CONTROL_ENABLE : DTR_CONTROL_DISABLE;
  dcb.fDsrSensitivity = FALSE;
  dcb.fTXContinueOnXoff = FALSE;
  dcb.fOutX = dcb.fInX = options->flow == 2;
  dcb.fErrorChar = dcb.fNull = dcb.fAbortOnError = FALSE;
  dcb.fRtsControl = options->flow == 1 ? RTS_CONTROL_HANDSHAKE : options->rts ? RTS_CONTROL_ENABLE : RTS_CONTROL_DISABLE;
  dcb.XonChar = 17; dcb.XoffChar = 19; dcb.XonLim = 256; dcb.XoffLim = 256;
  if (!SetCommState(port->handle, &dcb) || !SetupComm(port->handle, 65536, 65536)) goto failure;
  memset(&timeouts, 0, sizeof(timeouts));
  timeouts.ReadIntervalTimeout = MAXDWORD;
  timeouts.ReadTotalTimeoutConstant = 30;
  timeouts.WriteTotalTimeoutConstant = 1000;
  if (!SetCommTimeouts(port->handle, &timeouts) || !PurgeComm(port->handle, PURGE_RXCLEAR | PURGE_TXCLEAR)) goto failure;
  return port;
failure:
  if (error) *error = GetLastError();
  cy_serial_close(port);
  return NULL;
}

int cy_serial_read(cy_serial_port* port, unsigned char* bytes, size_t capacity, unsigned long* error) {
  DWORD count = 0;
  if (!port || !bytes || capacity < sizeof(port->receive)) { if (error) *error = ERROR_INVALID_PARAMETER; return -1; }
  if (!port->reading) {
    ResetEvent(port->read.hEvent);
    if (ReadFile(port->handle, port->receive, sizeof(port->receive), &count, &port->read)) {
      if (count) memcpy(bytes, port->receive, count);
      return (int)count;
    }
    if (GetLastError() != ERROR_IO_PENDING) { if (error) *error = GetLastError(); return -1; }
    port->reading = 1;
  }
  if (!GetOverlappedResult(port->handle, &port->read, &count, FALSE)) {
    DWORD code = GetLastError();
    if (code == ERROR_IO_INCOMPLETE) return 0;
    port->reading = 0; if (error) *error = code; return -1;
  }
  port->reading = 0;
  if (count) memcpy(bytes, port->receive, count);
  return (int)count;
}

int cy_serial_write_begin(cy_serial_port* port, const unsigned char* bytes, size_t count, unsigned long* error) {
  if (!port || !bytes || !count || count > sizeof(port->transmit) || port->writing || port->write_ready) {
    if (error) *error = ERROR_INVALID_PARAMETER; return 0;
  }
  memcpy(port->transmit, bytes, count);
  ResetEvent(port->write.hEvent);
  if (WriteFile(port->handle, port->transmit, (DWORD)count, &port->written, &port->write)) { port->write_ready = 1; return 1; }
  if (GetLastError() != ERROR_IO_PENDING) { if (error) *error = GetLastError(); return 0; }
  port->writing = 1; return 1;
}

int cy_serial_write_poll(cy_serial_port* port, size_t* written, unsigned long* error) {
  if (!port || !written || (!port->writing && !port->write_ready)) { if (error) *error = ERROR_INVALID_PARAMETER; return -1; }
  if (port->writing && !GetOverlappedResult(port->handle, &port->write, &port->written, FALSE)) {
    DWORD code = GetLastError();
    if (code == ERROR_IO_INCOMPLETE) return 0;
    port->writing = 0; if (error) *error = code; return -1;
  }
  port->writing = port->write_ready = 0;
  *written = port->written; return 1;
}
