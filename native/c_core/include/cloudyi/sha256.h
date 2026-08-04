/* FIPS 180-4 SHA-256 implementation migrated from CloudYiCSC. */
#ifndef CLOUDYI_SHA256_H
#define CLOUDYI_SHA256_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    uint32_t state[8];
    uint64_t bitlen;
    unsigned char data[64];
    size_t datalen;
} cy_sha256_ctx;

void cy_sha256_init(cy_sha256_ctx *ctx);
void cy_sha256_update(cy_sha256_ctx *ctx, const unsigned char *data, size_t len);
void cy_sha256_final(cy_sha256_ctx *ctx, unsigned char digest[32]);
long cy_sha256_hex(const unsigned char *data, size_t len,
                   char *out, size_t out_cap);

#ifdef __cplusplus
}
#endif

#endif /* CLOUDYI_SHA256_H */
