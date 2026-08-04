/* RFC 1321 MD5 implementation for compatibility and integrity tooling. */
#ifndef CLOUDYI_MD5_H
#define CLOUDYI_MD5_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    uint32_t state[4];
    uint64_t bitlen;
    unsigned char data[64];
    size_t datalen;
} cy_md5_ctx;

void cy_md5_init(cy_md5_ctx *ctx);
void cy_md5_update(cy_md5_ctx *ctx, const unsigned char *data, size_t len);
void cy_md5_final(cy_md5_ctx *ctx, unsigned char digest[16]);
long cy_md5_hex(const unsigned char *data, size_t len,
                char *out, size_t out_cap);

#ifdef __cplusplus
}
#endif

#endif /* CLOUDYI_MD5_H */
