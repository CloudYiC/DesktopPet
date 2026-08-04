/*
 * hex.h — Hex (base 16) encoding/decoding plus integer base conversions.
 *
 * Two distinct API groups:
 *   1. Byte-level: cy_hex_encode / cy_hex_decode — turn arbitrary bytes into
 *      hex pairs and back.
 *   2. Integer base conversion: cy_hex_convert_uint64 — given a numeric string
 *      in some base (2..16) emit it in another. Used by the Hex tool's
 *      multi-base view.
 */
#ifndef CLOUDYIC_HEX_H
#define CLOUDYIC_HEX_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

size_t cy_hex_encode_size(size_t in_len);  /* always in_len * 2 */

/* Encode bytes → lowercase hex. Returns bytes written or -1 if out_cap < 2*in_len. */
long cy_hex_encode(const unsigned char *in, size_t in_len,
                   char *out, size_t out_cap);

/* Decode hex string → bytes. Accepts upper/lower case. Whitespace and a
 * leading "0x" / "0X" are tolerated. Returns bytes written or -1 on error. */
long cy_hex_decode(const char *in, size_t in_len,
                   unsigned char *out, size_t out_cap);

/* Parse a numeric string in `from_base` (2..16), reformat as `to_base`.
 * Result written into `out`; returns bytes written (no trailing NUL) or -1.
 * Empty or invalid input → -1. Strips a leading "0x" / "0b" / "0o" when
 * from_base matches. */
long cy_int_convert(const char *in, size_t in_len,
                    int from_base, int to_base,
                    char *out, size_t out_cap);

#ifdef __cplusplus
}
#endif

#endif /* CLOUDYIC_HEX_H */
