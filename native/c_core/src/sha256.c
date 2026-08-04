#include "cloudyi/sha256.h"

static const uint32_t K[64] = {
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
};

#define ROTR(x,n) (((x) >> (n)) | ((x) << (32 - (n))))
#define CH(x,y,z) (((x) & (y)) ^ (~(x) & (z)))
#define MAJ(x,y,z) (((x) & (y)) ^ ((x) & (z)) ^ ((y) & (z)))
#define BSIG0(x) (ROTR(x,2) ^ ROTR(x,13) ^ ROTR(x,22))
#define BSIG1(x) (ROTR(x,6) ^ ROTR(x,11) ^ ROTR(x,25))
#define SSIG0(x) (ROTR(x,7) ^ ROTR(x,18) ^ ((x) >> 3))
#define SSIG1(x) (ROTR(x,17) ^ ROTR(x,19) ^ ((x) >> 10))

static void transform(cy_sha256_ctx *ctx, const unsigned char block[64]) {
    uint32_t words[64];
    uint32_t a, b, c, d, e, f, g, h;
    int i;
    for (i = 0; i < 16; ++i) {
        words[i] = ((uint32_t)block[i * 4] << 24) |
                   ((uint32_t)block[i * 4 + 1] << 16) |
                   ((uint32_t)block[i * 4 + 2] << 8) |
                   (uint32_t)block[i * 4 + 3];
    }
    for (i = 16; i < 64; ++i) {
        words[i] = SSIG1(words[i - 2]) + words[i - 7] +
                   SSIG0(words[i - 15]) + words[i - 16];
    }
    a = ctx->state[0]; b = ctx->state[1]; c = ctx->state[2]; d = ctx->state[3];
    e = ctx->state[4]; f = ctx->state[5]; g = ctx->state[6]; h = ctx->state[7];
    for (i = 0; i < 64; ++i) {
        uint32_t first = h + BSIG1(e) + CH(e, f, g) + K[i] + words[i];
        uint32_t second = BSIG0(a) + MAJ(a, b, c);
        h = g; g = f; f = e; e = d + first;
        d = c; c = b; b = a; a = first + second;
    }
    ctx->state[0] += a; ctx->state[1] += b;
    ctx->state[2] += c; ctx->state[3] += d;
    ctx->state[4] += e; ctx->state[5] += f;
    ctx->state[6] += g; ctx->state[7] += h;
}

void cy_sha256_init(cy_sha256_ctx *ctx) {
    ctx->state[0] = 0x6a09e667; ctx->state[1] = 0xbb67ae85;
    ctx->state[2] = 0x3c6ef372; ctx->state[3] = 0xa54ff53a;
    ctx->state[4] = 0x510e527f; ctx->state[5] = 0x9b05688c;
    ctx->state[6] = 0x1f83d9ab; ctx->state[7] = 0x5be0cd19;
    ctx->bitlen = 0;
    ctx->datalen = 0;
}

void cy_sha256_update(cy_sha256_ctx *ctx,
                      const unsigned char *data, size_t len) {
    size_t i;
    for (i = 0; i < len; ++i) {
        ctx->data[ctx->datalen++] = data[i];
        if (ctx->datalen == 64) {
            transform(ctx, ctx->data);
            ctx->bitlen += 512;
            ctx->datalen = 0;
        }
    }
}

void cy_sha256_final(cy_sha256_ctx *ctx, unsigned char digest[32]) {
    size_t i = ctx->datalen;
    int byte;
    int state;
    ctx->data[i++] = 0x80;
    if (i > 56) {
        while (i < 64) ctx->data[i++] = 0;
        transform(ctx, ctx->data);
        i = 0;
    }
    while (i < 56) ctx->data[i++] = 0;
    ctx->bitlen += (uint64_t)ctx->datalen * 8;
    for (byte = 7; byte >= 0; --byte) {
        ctx->data[56 + (7 - byte)] =
            (unsigned char)((ctx->bitlen >> (byte * 8)) & 0xff);
    }
    transform(ctx, ctx->data);
    for (state = 0; state < 8; ++state) {
        digest[state * 4] = (unsigned char)((ctx->state[state] >> 24) & 0xff);
        digest[state * 4 + 1] = (unsigned char)((ctx->state[state] >> 16) & 0xff);
        digest[state * 4 + 2] = (unsigned char)((ctx->state[state] >> 8) & 0xff);
        digest[state * 4 + 3] = (unsigned char)(ctx->state[state] & 0xff);
    }
}

long cy_sha256_hex(const unsigned char *data, size_t len,
                   char *out, size_t out_cap) {
    static const char HEX[] = "0123456789abcdef";
    cy_sha256_ctx ctx;
    unsigned char digest[32];
    int i;
    if (data == 0 || out == 0 || out_cap < 64) return -1;
    cy_sha256_init(&ctx);
    cy_sha256_update(&ctx, data, len);
    cy_sha256_final(&ctx, digest);
    for (i = 0; i < 32; ++i) {
        out[i * 2] = HEX[(digest[i] >> 4) & 0x0f];
        out[i * 2 + 1] = HEX[digest[i] & 0x0f];
    }
    return 64;
}
