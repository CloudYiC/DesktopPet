#include "cloudyi/base64.h"

static const char STD_ALPHA[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static const char URL_ALPHA[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

static int decode_value(unsigned char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+' || c == '-') return 62;
    if (c == '/' || c == '_') return 63;
    return -1;
}

size_t cy_base64_encode_max_size(size_t in_len) {
    return ((in_len + 2) / 3) * 4;
}

size_t cy_base64_decode_max_size(size_t in_len) {
    return (in_len / 4) * 3 + 3;
}

long cy_base64_encode(const unsigned char *in, size_t in_len,
                      char *out, size_t out_cap,
                      int url_safe, int pad) {
    const char *alpha;
    size_t need;
    size_t i = 0;
    size_t o = 0;

    if (in == 0 || out == 0) return -1;
    alpha = url_safe ? URL_ALPHA : STD_ALPHA;
    need = ((in_len + 2) / 3) * 4;
    if (!pad && (in_len % 3) != 0) need -= 3 - (in_len % 3);
    if (need > out_cap) return -1;

    while (i + 3 <= in_len) {
        unsigned int value = ((unsigned int)in[i] << 16) |
                             ((unsigned int)in[i + 1] << 8) |
                             (unsigned int)in[i + 2];
        out[o++] = alpha[(value >> 18) & 0x3f];
        out[o++] = alpha[(value >> 12) & 0x3f];
        out[o++] = alpha[(value >> 6) & 0x3f];
        out[o++] = alpha[value & 0x3f];
        i += 3;
    }

    if (in_len - i == 1) {
        unsigned int value = (unsigned int)in[i] << 16;
        out[o++] = alpha[(value >> 18) & 0x3f];
        out[o++] = alpha[(value >> 12) & 0x3f];
        if (pad) {
            out[o++] = '=';
            out[o++] = '=';
        }
    } else if (in_len - i == 2) {
        unsigned int value = ((unsigned int)in[i] << 16) |
                             ((unsigned int)in[i + 1] << 8);
        out[o++] = alpha[(value >> 18) & 0x3f];
        out[o++] = alpha[(value >> 12) & 0x3f];
        out[o++] = alpha[(value >> 6) & 0x3f];
        if (pad) out[o++] = '=';
    }
    return (long)o;
}

long cy_base64_decode(const char *in, size_t in_len,
                      unsigned char *out, size_t out_cap) {
    unsigned int accumulator = 0;
    int accumulator_bits = 0;
    size_t o = 0;
    size_t i;

    if (in == 0 || out == 0) return -1;
    for (i = 0; i < in_len; ++i) {
        unsigned char c = (unsigned char)in[i];
        int value;
        if (c == '=') break;
        if (c == ' ' || c == '\r' || c == '\n' || c == '\t') continue;
        value = decode_value(c);
        if (value < 0) return -1;
        accumulator = (accumulator << 6) | (unsigned int)value;
        accumulator_bits += 6;
        if (accumulator_bits >= 8) {
            accumulator_bits -= 8;
            if (o >= out_cap) return -1;
            out[o++] = (unsigned char)((accumulator >> accumulator_bits) & 0xff);
        }
    }
    return (long)o;
}
