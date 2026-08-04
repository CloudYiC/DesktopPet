/*
 * md5.c — RFC 1321 reference-style implementation.
 *
 * Uses the same streaming context shape as SHA-256 for consistency. MD5 reads
 * input as little-endian 32-bit words and emits a little-endian 16-byte digest.
 */
#include "md5.h"

#define LROT(x,n) (((x) << (n)) | ((x) >> (32 - (n))))

static const uint32_t K[64] = {
    0xd76aa478,0xe8c7b756,0x242070db,0xc1bdceee,0xf57c0faf,0x4787c62a,0xa8304613,0xfd469501,
    0x698098d8,0x8b44f7af,0xffff5bb1,0x895cd7be,0x6b901122,0xfd987193,0xa679438e,0x49b40821,
    0xf61e2562,0xc040b340,0x265e5a51,0xe9b6c7aa,0xd62f105d,0x02441453,0xd8a1e681,0xe7d3fbc8,
    0x21e1cde6,0xc33707d6,0xf4d50d87,0x455a14ed,0xa9e3e905,0xfcefa3f8,0x676f02d9,0x8d2a4c8a,
    0xfffa3942,0x8771f681,0x6d9d6122,0xfde5380c,0xa4beea44,0x4bdecfa9,0xf6bb4b60,0xbebfbc70,
    0x289b7ec6,0xeaa127fa,0xd4ef3085,0x04881d05,0xd9d4d039,0xe6db99e5,0x1fa27cf8,0xc4ac5665,
    0xf4292244,0x432aff97,0xab9423a7,0xfc93a039,0x655b59c3,0x8f0ccc92,0xffeff47d,0x85845dd1,
    0x6fa87e4f,0xfe2ce6e0,0xa3014314,0x4e0811a1,0xf7537e82,0xbd3af235,0x2ad7d2bb,0xeb86d391
};

static const int S[64] = {
    7,12,17,22, 7,12,17,22, 7,12,17,22, 7,12,17,22,
    5, 9,14,20, 5, 9,14,20, 5, 9,14,20, 5, 9,14,20,
    4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23,
    6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21
};

static void transform(cy_md5_ctx *ctx, const unsigned char block[64]) {
    uint32_t M[16];
    for (int i = 0; i < 16; ++i) {
        /* MD5 reads little-endian */
        M[i] = ((uint32_t)block[i*4    ]      ) |
               ((uint32_t)block[i*4 + 1] <<  8) |
               ((uint32_t)block[i*4 + 2] << 16) |
               ((uint32_t)block[i*4 + 3] << 24);
    }

    uint32_t a = ctx->state[0];
    uint32_t b = ctx->state[1];
    uint32_t c = ctx->state[2];
    uint32_t d = ctx->state[3];

    for (int i = 0; i < 64; ++i) {
        uint32_t f, g;
        if (i < 16) {
            f = (b & c) | (~b & d);
            g = (uint32_t)i;
        } else if (i < 32) {
            f = (d & b) | (~d & c);
            g = (uint32_t)((5*i + 1) % 16);
        } else if (i < 48) {
            f = b ^ c ^ d;
            g = (uint32_t)((3*i + 5) % 16);
        } else {
            f = c ^ (b | ~d);
            g = (uint32_t)((7*i) % 16);
        }

        uint32_t temp = d;
        d = c;
        c = b;
        b = b + LROT(a + f + K[i] + M[g], S[i]);
        a = temp;
    }

    ctx->state[0] += a;
    ctx->state[1] += b;
    ctx->state[2] += c;
    ctx->state[3] += d;
}

void cy_md5_init(cy_md5_ctx *ctx) {
    ctx->state[0] = 0x67452301;
    ctx->state[1] = 0xefcdab89;
    ctx->state[2] = 0x98badcfe;
    ctx->state[3] = 0x10325476;
    ctx->bitlen = 0;
    ctx->datalen = 0;
}

void cy_md5_update(cy_md5_ctx *ctx, const unsigned char *data, size_t len) {
    for (size_t i = 0; i < len; ++i) {
        ctx->data[ctx->datalen++] = data[i];
        if (ctx->datalen == 64) {
            transform(ctx, ctx->data);
            ctx->bitlen += 512;
            ctx->datalen = 0;
        }
    }
}

void cy_md5_final(cy_md5_ctx *ctx, unsigned char digest[16]) {
    size_t i = ctx->datalen;
    ctx->data[i++] = 0x80;
    if (i > 56) {
        while (i < 64) ctx->data[i++] = 0;
        transform(ctx, ctx->data);
        i = 0;
    }
    while (i < 56) ctx->data[i++] = 0;

    ctx->bitlen += (uint64_t)ctx->datalen * 8;
    /* little-endian length */
    for (int b = 0; b < 8; ++b) {
        ctx->data[56 + b] = (unsigned char)((ctx->bitlen >> (b * 8)) & 0xFF);
    }
    transform(ctx, ctx->data);

    for (int s = 0; s < 4; ++s) {
        digest[s*4    ] = (unsigned char)( ctx->state[s]        & 0xFF);
        digest[s*4 + 1] = (unsigned char)((ctx->state[s] >>  8) & 0xFF);
        digest[s*4 + 2] = (unsigned char)((ctx->state[s] >> 16) & 0xFF);
        digest[s*4 + 3] = (unsigned char)((ctx->state[s] >> 24) & 0xFF);
    }
}

long cy_md5_hex(const unsigned char *data, size_t len, char *out, size_t out_cap) {
    if (out_cap < 32) return -1;
    cy_md5_ctx ctx;
    unsigned char digest[16];
    cy_md5_init(&ctx);
    cy_md5_update(&ctx, data, len);
    cy_md5_final(&ctx, digest);
    static const char HEX[16] = "0123456789abcdef";
    for (int i = 0; i < 16; ++i) {
        out[i*2    ] = HEX[(digest[i] >> 4) & 0x0F];
        out[i*2 + 1] = HEX[ digest[i]       & 0x0F];
    }
    return 32;
}
