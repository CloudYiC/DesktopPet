/*
 * RFC 4648 Base64 codec migrated from CloudYiCSC.
 *
 * The API is allocation-free: callers provide every output buffer and use
 * the size helpers before encoding or decoding. Both standard and URL-safe
 * alphabets are accepted by the decoder.
 */
#ifndef CLOUDYI_BASE64_H
#define CLOUDYI_BASE64_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

size_t cy_base64_encode_max_size(size_t in_len);
size_t cy_base64_decode_max_size(size_t in_len);

/* Returns the number of bytes written, or -1 when input/output is invalid. */
long cy_base64_encode(const unsigned char *in, size_t in_len,
                      char *out, size_t out_cap, int url_safe, int pad);
long cy_base64_decode(const char *in, size_t in_len,
                      unsigned char *out, size_t out_cap);

#ifdef __cplusplus
}
#endif

#endif /* CLOUDYI_BASE64_H */
