/* Local generators and number utilities migrated from CloudYiCSC. */
#ifndef CLOUDYI_STORE_TOOLS_H
#define CLOUDYI_STORE_TOOLS_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* UUID functions return 36 on success and -1 for invalid arguments. */
int cy_uuid_v4(const unsigned char random16[16], char *out, size_t out_cap);
int cy_uuid_v7(uint64_t unix_ms, const unsigned char random10[10],
               char *out, size_t out_cap);

/*
 * Generates a password from caller-provided random bytes. Every enabled
 * character group is represented at least once. -2 means more random bytes
 * are required; all other invalid arguments return -1.
 */
int cy_password_generate(const unsigned char *random_bytes, size_t random_len,
                         int length, int use_lower, int use_upper,
                         int use_digits, int use_symbols,
                         char *out, size_t out_cap);

/* unit: 0 = Unix seconds, 1 = Unix milliseconds. */
int cy_timestamp_to_iso(int64_t value, int unit, char *out, size_t out_cap);

/* Adds decimal thousands separators while preserving sign and fraction. */
int cy_number_group(const char *input, size_t input_len,
                    char *out, size_t out_cap);

#ifdef __cplusplus
}
#endif

#endif /* CLOUDYI_STORE_TOOLS_H */
