#include <windows.h>

#include <stdint.h>

#include "cloudyi/icon_file.h"

static int cy_write_all(HANDLE file, const void *data, size_t size) {
  const unsigned char *cursor = (const unsigned char *)data;
  while (size > 0) {
    const DWORD chunk = size > 0xffffffffU ? 0xffffffffU : (DWORD)size;
    DWORD written = 0;
    if (!WriteFile(file, cursor, chunk, &written, NULL) || written == 0) {
      return 0;
    }
    cursor += written;
    size -= written;
  }
  return 1;
}

static void cy_store_u16(unsigned char *destination, uint16_t value) {
  destination[0] = (unsigned char)(value & 0xffU);
  destination[1] = (unsigned char)((value >> 8U) & 0xffU);
}

static void cy_store_u32(unsigned char *destination, uint32_t value) {
  destination[0] = (unsigned char)(value & 0xffU);
  destination[1] = (unsigned char)((value >> 8U) & 0xffU);
  destination[2] = (unsigned char)((value >> 16U) & 0xffU);
  destination[3] = (unsigned char)((value >> 24U) & 0xffU);
}

int cy_write_png_icon(const wchar_t *path, const unsigned char *png,
                      size_t png_size) {
  unsigned char header[22] = {0};
  HANDLE file;
  int success;
  if (!path || !png || png_size < 8 || png_size > 0xffffffffU) return 0;

  /* ICONDIR followed by one ICONDIRENTRY. Width/height zero encode 256. */
  cy_store_u16(header + 2, 1);
  cy_store_u16(header + 4, 1);
  cy_store_u16(header + 10, 1);
  cy_store_u16(header + 12, 32);
  cy_store_u32(header + 14, (uint32_t)png_size);
  cy_store_u32(header + 18, (uint32_t)sizeof(header));

  file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS,
                     FILE_ATTRIBUTE_NORMAL, NULL);
  if (file == INVALID_HANDLE_VALUE) return 0;
  success = cy_write_all(file, header, sizeof(header)) &&
            cy_write_all(file, png, png_size);
  if (!CloseHandle(file)) success = 0;
  if (!success) DeleteFileW(path);
  return success;
}
