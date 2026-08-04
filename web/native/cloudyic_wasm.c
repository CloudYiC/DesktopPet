#include <stdint.h>
#include <stddef.h>

#include "base64.h"
#include "hex.h"
#include "md5.h"
#include "sha256.h"
#include "store_tools.h"
#include "url_encode.h"

/*
 * Thin WASM ABI around the same C utility functions used by the desktop app.
 * TypeScript writes bytes into cy_web_input, calls one exported function, and
 * reads cy_web_output. Return value is output length; -1 means invalid input.
 */
#define CY_WEB_INPUT_CAP 1048576
#define CY_WEB_OUTPUT_CAP 3145728

/* Fixed buffers keep the WebAssembly boundary simple and avoid per-call malloc
 * across JS <-> C. Grow these only when the web tool UX can handle larger files.
 */
static unsigned char cy_web_input[CY_WEB_INPUT_CAP];
static unsigned char cy_web_output[CY_WEB_OUTPUT_CAP];

int cy_web_input_ptr(void) {
  return (int)(uintptr_t)cy_web_input;
}

int cy_web_input_cap(void) {
  return CY_WEB_INPUT_CAP;
}

int cy_web_output_ptr(void) {
  return (int)(uintptr_t)cy_web_output;
}

int cy_web_output_cap(void) {
  return CY_WEB_OUTPUT_CAP;
}

int cy_web_base64_encode(int in_len, int url_safe, int pad) {
  if (in_len < 0 || in_len > CY_WEB_INPUT_CAP) return -1;
  return (int)cy_base64_encode(
    cy_web_input,
    (size_t)in_len,
    (char *)cy_web_output,
    CY_WEB_OUTPUT_CAP,
    url_safe,
    pad
  );
}

int cy_web_base64_decode(int in_len) {
  if (in_len < 0 || in_len > CY_WEB_INPUT_CAP) return -1;
  return (int)cy_base64_decode(
    (const char *)cy_web_input,
    (size_t)in_len,
    cy_web_output,
    CY_WEB_OUTPUT_CAP
  );
}

int cy_web_hex_encode(int in_len) {
  if (in_len < 0 || in_len > CY_WEB_INPUT_CAP) return -1;
  return (int)cy_hex_encode(
    cy_web_input,
    (size_t)in_len,
    (char *)cy_web_output,
    CY_WEB_OUTPUT_CAP
  );
}

int cy_web_hex_decode(int in_len) {
  if (in_len < 0 || in_len > CY_WEB_INPUT_CAP) return -1;
  return (int)cy_hex_decode(
    (const char *)cy_web_input,
    (size_t)in_len,
    cy_web_output,
    CY_WEB_OUTPUT_CAP
  );
}

int cy_web_int_convert(int in_len, int from_base, int to_base) {
  if (in_len < 0 || in_len > CY_WEB_INPUT_CAP) return -1;
  return (int)cy_int_convert(
    (const char *)cy_web_input,
    (size_t)in_len,
    from_base,
    to_base,
    (char *)cy_web_output,
    CY_WEB_OUTPUT_CAP
  );
}

int cy_web_md5_hex(int in_len) {
  if (in_len < 0 || in_len > CY_WEB_INPUT_CAP) return -1;
  return (int)cy_md5_hex(
    cy_web_input,
    (size_t)in_len,
    (char *)cy_web_output,
    CY_WEB_OUTPUT_CAP
  );
}

int cy_web_sha256_hex(int in_len) {
  if (in_len < 0 || in_len > CY_WEB_INPUT_CAP) return -1;
  return (int)cy_sha256_hex(
    cy_web_input,
    (size_t)in_len,
    (char *)cy_web_output,
    CY_WEB_OUTPUT_CAP
  );
}

int cy_web_url_encode(int in_len, int component) {
  if (in_len < 0 || in_len > CY_WEB_INPUT_CAP) return -1;
  return (int)cy_url_encode(
    (const char *)cy_web_input,
    (size_t)in_len,
    (char *)cy_web_output,
    CY_WEB_OUTPUT_CAP,
    component
  );
}

int cy_web_url_decode(int in_len) {
  if (in_len < 0 || in_len > CY_WEB_INPUT_CAP) return -1;
  return (int)cy_url_decode(
    (const char *)cy_web_input,
    (size_t)in_len,
    (char *)cy_web_output,
    CY_WEB_OUTPUT_CAP
  );
}

int cy_web_uuid_v4(void) {
  return cy_uuid_v4(cy_web_input, (char *)cy_web_output, CY_WEB_OUTPUT_CAP);
}

int cy_web_uuid_v7(unsigned int unix_ms_hi, unsigned int unix_ms_lo) {
  uint64_t unix_ms = ((uint64_t)unix_ms_hi << 32) | (uint64_t)unix_ms_lo;
  return cy_uuid_v7(unix_ms, cy_web_input, (char *)cy_web_output, CY_WEB_OUTPUT_CAP);
}

int cy_web_password_generate(
  int random_len,
  int length,
  int use_lower,
  int use_upper,
  int use_digits,
  int use_symbols
) {
  if (random_len < 0 || random_len > CY_WEB_INPUT_CAP) return -1;
  return cy_password_generate(
    cy_web_input,
    (size_t)random_len,
    length,
    use_lower,
    use_upper,
    use_digits,
    use_symbols,
    (char *)cy_web_output,
    CY_WEB_OUTPUT_CAP
  );
}

int cy_web_timestamp_to_iso(unsigned int value_hi, unsigned int value_lo, int unit) {
  uint64_t raw = ((uint64_t)value_hi << 32) | (uint64_t)value_lo;
  return cy_timestamp_to_iso((int64_t)raw, unit, (char *)cy_web_output, CY_WEB_OUTPUT_CAP);
}

int cy_web_number_group(int in_len) {
  if (in_len < 0 || in_len > CY_WEB_INPUT_CAP) return -1;
  return cy_number_group(
    (const char *)cy_web_input,
    (size_t)in_len,
    (char *)cy_web_output,
    CY_WEB_OUTPUT_CAP
  );
}
