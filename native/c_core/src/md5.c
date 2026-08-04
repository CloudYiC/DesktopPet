#include "cloudyi/md5.h"

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
    5,9,14,20, 5,9,14,20, 5,9,14,20, 5,9,14,20,
    4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23,
    6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21
};

static void transform(cy_md5_ctx *ctx, const unsigned char block[64]) {
    uint32_t words[16];
    uint32_t a;
    uint32_t b;
    uint32_t c;
    uint32_t d;
    int i;
    for (i = 0; i < 16; ++i) {
        words[i] = ((uint32_t)block[i * 4]) |
                   ((uint32_t)block[i * 4 + 1] << 8) |
                   ((uint32_t)block[i * 4 + 2] << 16) |
                   ((uint32_t)block[i * 4 + 3] << 24);
    }
    a = ctx->state[0]; b = ctx->state[1];
    c = ctx->state[2]; d = ctx->state[3];
    for (i = 0; i < 64; ++i) {
        uint32_t function;
        uint32_t word_index;
        uint32_t previous_d;
        if (i < 16) {
            function = (b & c) | (~b & d);
            word_index = (uint32_t)i;
        } else if (i < 32) {
            function = (d & b) | (~d & c);
            word_index = (uint32_t)((5 * i + 1) % 16);
        } else if (i < 48) {
            function = b ^ c ^ d;
            word_index = (uint32_t)((3 * i + 5) % 16);
        } else {
            function = c ^ (b | ~d);
            word_index = (uint32_t)((7 * i) % 16);
        }
        previous_d = d;
        d = c; c = b;
        b = b + LROT(a + function + K[i] + words[word_index], S[i]);
        a = previous_d;
    }
    ctx->state[0] += a; ctx->state[1] += b;
    ctx->state[2] += c; ctx->state[3] += d;
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

void cy_md5_final(cy_md5_ctx *ctx, unsigned char digest[16]) {
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
    for (byte = 0; byte < 8; ++byte) {
        ctx->data[56 + byte] =
            (unsigned char)((ctx->bitlen >> (byte * 8)) & 0xff);
    }
    transform(ctx, ctx->data);
    for (state = 0; state < 4; ++state) {
        digest[state * 4] = (unsigned char)(ctx->state[state] & 0xff);
        digest[state * 4 + 1] = (unsigned char)((ctx->state[state] >> 8) & 0xff);
        digest[state * 4 + 2] = (unsigned char)((ctx->state[state] >> 16) & 0xff);
        digest[state * 4 + 3] = (unsigned char)((ctx->state[state] >> 24) & 0xff);
    }
}

long cy_md5_hex(const unsigned char *data, size_t len,
                char *out, size_t out_cap) {
    static const char HEX[] = "0123456789abcdef";
    cy_md5_ctx ctx;
    unsigned char digest[16];
    int i;
    if (data == 0 || out == 0 || out_cap < 32) return -1;
    cy_md5_init(&ctx);
    cy_md5_update(&ctx, data, len);
    cy_md5_final(&ctx, digest);
    for (i = 0; i < 16; ++i) {
        out[i * 2] = HEX[(digest[i] >> 4) & 0x0f];
        out[i * 2 + 1] = HEX[digest[i] & 0x0f];
    }
    return 32;
}
