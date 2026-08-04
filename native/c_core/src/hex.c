#include "cloudyi/hex.h"

static const char HEX_LOWER[] = "0123456789abcdef";

static int hex_value(unsigned char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

size_t cy_hex_encode_size(size_t in_len) { return in_len * 2; }

long cy_hex_encode(const unsigned char *in, size_t in_len,
                   char *out, size_t out_cap) {
    size_t i;
    if (in == 0 || out == 0 || out_cap < in_len * 2) return -1;
    for (i = 0; i < in_len; ++i) {
        out[i * 2] = HEX_LOWER[(in[i] >> 4) & 0x0f];
        out[i * 2 + 1] = HEX_LOWER[in[i] & 0x0f];
    }
    return (long)(in_len * 2);
}

long cy_hex_decode(const char *in, size_t in_len,
                   unsigned char *out, size_t out_cap) {
    size_t start = 0;
    size_t i;
    size_t o = 0;
    int high = -1;
    if (in == 0 || out == 0) return -1;
    if (in_len >= 2 && in[0] == '0' && (in[1] == 'x' || in[1] == 'X')) {
        start = 2;
    }
    for (i = start; i < in_len; ++i) {
        unsigned char c = (unsigned char)in[i];
        int value;
        if (c == ' ' || c == '\r' || c == '\n' || c == '\t' || c == '_') {
            continue;
        }
        value = hex_value(c);
        if (value < 0) return -1;
        if (high < 0) {
            high = value;
        } else {
            if (o >= out_cap) return -1;
            out[o++] = (unsigned char)((high << 4) | value);
            high = -1;
        }
    }
    return high < 0 ? (long)o : -1;
}
