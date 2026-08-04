#ifndef CY_STORE_TOOLS_H
#define CY_STORE_TOOLS_H

#include <stdint.h>
#include <stddef.h>

int cy_uuid_v4(const unsigned char random16[16], char *out, size_t out_cap);
int cy_uuid_v7(uint64_t unix_ms, const unsigned char random10[10], char *out, size_t out_cap);

int cy_password_generate(
  const unsigned char *random_bytes,
  size_t random_len,
  int length,
  int use_lower,
  int use_upper,
  int use_digits,
  int use_symbols,
  char *out,
  size_t out_cap
);

int cy_timestamp_to_iso(int64_t value, int unit, char *out, size_t out_cap);
int cy_number_group(const char *input, size_t input_len, char *out, size_t out_cap);

#endif
