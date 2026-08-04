/*
 * base64.h — RFC 4648 Base64 encoding/decoding.
 *
 * Supports both the standard alphabet (A-Z a-z 0-9 + /) and the URL-safe
 * variant (A-Z a-z 0-9 - _) with optional `=` padding.
 *
 * All functions write to caller-supplied buffers; callers compute size with
 * the *_max_size helpers before calling encode/decode.
 *
 * Return value convention: encode/decode return the number of bytes actually
 * written to `out`, or -1 on error (invalid input, buffer too small).
 *
 * Pure C, no allocations, no dependencies. Designed to be called from Go
 * via cgo — see internal/nativecore/nativecore.go.
 */
#ifndef CLOUDYIC_BASE64_H
#define CLOUDYIC_BASE64_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Buffer-size helpers. encode_max_size includes the trailing NUL the caller
 * may want to add (we do not write NUL ourselves). */
size_t cy_base64_encode_max_size(size_t in_len);
size_t cy_base64_decode_max_size(size_t in_len);

/* Encode `in_len` bytes from `in` into `out`. If `url_safe` is non-zero, use
 * the URL-safe alphabet. If `pad` is non-zero, append `=` to align to 4-byte
 * groups (standard); the URL-safe variant typically omits padding so pass 0.
 *
 * Returns: bytes written (no trailing NUL), or -1 if out_cap is insufficient. */
long cy_base64_encode(const unsigned char *in, size_t in_len,
                      char *out, size_t out_cap,
                      int url_safe, int pad);

/* Decode the Base64 text in `in` (length `in_len`) into raw bytes in `out`.
 * Accepts either alphabet (auto-detects from input characters). Whitespace
 * inside the input is silently skipped.
 *
 * Returns: bytes written, or -1 on malformed input / insufficient buffer. */
long cy_base64_decode(const char *in, size_t in_len,
                      unsigned char *out, size_t out_cap);

#ifdef __cplusplus
}
#endif

#endif /* CLOUDYIC_BASE64_H */
