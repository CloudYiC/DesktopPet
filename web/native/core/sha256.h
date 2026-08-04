/*
 * sha256.h — SHA-256 (FIPS 180-4) implementation.
 *
 * Streaming API:
 *   cy_sha256_init     — zero out a context
 *   cy_sha256_update   — feed bytes; can be called many times
 *   cy_sha256_final    — emit the 32-byte digest
 *
 * One-shot wrapper cy_sha256_hex produces a 64-char lowercase hex string.
 */
#ifndef CLOUDYIC_SHA256_H
#define CLOUDYIC_SHA256_H

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

void cy_sha256_init  (cy_sha256_ctx *ctx);
void cy_sha256_update(cy_sha256_ctx *ctx, const unsigned char *data, size_t len);
void cy_sha256_final (cy_sha256_ctx *ctx, unsigned char digest[32]);

/* One-shot helper: write 64 lowercase hex chars into `out` (no NUL). out_cap >= 64. */
long cy_sha256_hex(const unsigned char *data, size_t len, char *out, size_t out_cap);

#ifdef __cplusplus
}
#endif

#endif /* CLOUDYIC_SHA256_H */
