/*
 * url_encode.h — Percent encoding (RFC 3986).
 *
 * `component` mode: encodes everything except unreserved chars
 *   (A-Z a-z 0-9 - _ . ~). Use for query / path component values.
 * Non-`component` mode: also preserves reserved chars (! * ' ( ) ; : @ &
 *   = + $ , / ? # [ ]). Use for entire URLs where structure matters.
 *
 * UTF-8 in input is encoded byte-by-byte (each byte ≥ 0x80 becomes %XX),
 * which is correct for any well-formed UTF-8 string.
 */
#ifndef CLOUDYIC_URL_ENCODE_H
#define CLOUDYIC_URL_ENCODE_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Worst-case output size: every byte expands to %XX (3 bytes). */
size_t cy_url_encode_max_size(size_t in_len);

long cy_url_encode(const char *in, size_t in_len,
                   char *out, size_t out_cap,
                   int component);

long cy_url_decode(const char *in, size_t in_len,
                   char *out, size_t out_cap);

#ifdef __cplusplus
}
#endif

#endif /* CLOUDYIC_URL_ENCODE_H */
