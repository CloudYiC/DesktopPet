/* RFC 3986 percent codec migrated from CloudYiCSC. */
#ifndef CLOUDYI_URL_ENCODE_H
#define CLOUDYI_URL_ENCODE_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

size_t cy_url_encode_max_size(size_t in_len);
long cy_url_encode(const char *in, size_t in_len,
                   char *out, size_t out_cap, int component);
long cy_url_decode(const char *in, size_t in_len,
                   char *out, size_t out_cap);

#ifdef __cplusplus
}
#endif

#endif /* CLOUDYI_URL_ENCODE_H */
