/* Byte-oriented hexadecimal codec migrated from CloudYiCSC. */
#ifndef CLOUDYI_HEX_H
#define CLOUDYI_HEX_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

size_t cy_hex_encode_size(size_t in_len);
long cy_hex_encode(const unsigned char *in, size_t in_len,
                   char *out, size_t out_cap);
long cy_hex_decode(const char *in, size_t in_len,
                   unsigned char *out, size_t out_cap);

#ifdef __cplusplus
}
#endif

#endif /* CLOUDYI_HEX_H */
