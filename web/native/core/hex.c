#include "hex.h"

static const char HEX_LOWER[16] = "0123456789abcdef";

static int hex_digit_value(unsigned char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

size_t cy_hex_encode_size(size_t in_len) {
    return in_len * 2;
}

long cy_hex_encode(const unsigned char *in, size_t in_len,
                   char *out, size_t out_cap) {
    if (out_cap < in_len * 2) return -1;
    for (size_t i = 0; i < in_len; ++i) {
        out[i*2]     = HEX_LOWER[(in[i] >> 4) & 0x0F];
        out[i*2 + 1] = HEX_LOWER[ in[i]       & 0x0F];
    }
    return (long)(in_len * 2);
}

long cy_hex_decode(const char *in, size_t in_len,
                   unsigned char *out, size_t out_cap) {
    /* Skip leading "0x"/"0X" if present. */
    size_t start = 0;
    if (in_len >= 2 && in[0] == '0' && (in[1] == 'x' || in[1] == 'X')) start = 2;

    /* Collect hex digits, ignoring whitespace. */
    int high = -1;
    size_t o = 0;
    for (size_t i = start; i < in_len; ++i) {
        unsigned char c = (unsigned char)in[i];
        if (c == ' ' || c == '\r' || c == '\n' || c == '\t' || c == '_') continue;
        int v = hex_digit_value(c);
        if (v < 0) return -1;
        if (high < 0) {
            high = v;
        } else {
            if (o >= out_cap) return -1;
            out[o++] = (unsigned char)((high << 4) | v);
            high = -1;
        }
    }
    if (high >= 0) return -1; /* odd digit count */
    return (long)o;
}

/* ---- integer base conversion ---- */

long cy_int_convert(const char *in, size_t in_len,
                    int from_base, int to_base,
                    char *out, size_t out_cap) {
    if (in == 0 || out == 0) return -1;
    if (from_base < 2 || from_base > 16) return -1;
    if (to_base < 2 || to_base > 16) return -1;
    if (in_len == 0) return -1;

    /* Strip whitespace + optional sign + standard prefixes. */
    size_t i = 0;
    while (i < in_len && (in[i] == ' ' || in[i] == '\t')) ++i;

    int negative = 0;
    if (i < in_len && (in[i] == '+' || in[i] == '-')) {
        negative = (in[i] == '-');
        ++i;
    }

    /* Recognise 0x/0b/0o prefixes that match from_base */
    if (i + 2 <= in_len && in[i] == '0') {
        char p = in[i+1];
        if (from_base == 16 && (p == 'x' || p == 'X')) i += 2;
        else if (from_base == 2  && (p == 'b' || p == 'B')) i += 2;
        else if (from_base == 8  && (p == 'o' || p == 'O')) i += 2;
    }

    if (i >= in_len) return -1;

    /* Parse digits into a 64-bit accumulator. We're not aiming for arbitrary
     * precision here — 64 bits covers everything an interactive tool will
     * meaningfully need. Overflow returns -1. */
    uint64_t acc = 0;
    int saw_digit = 0;
    for (; i < in_len; ++i) {
        unsigned char c = (unsigned char)in[i];
        if (c == ' ' || c == '_') continue;
        int v = hex_digit_value(c);
        if (v < 0 || v >= from_base) return -1;
        uint64_t next = acc * (uint64_t)from_base + (uint64_t)v;
        if (next < acc) return -1; /* overflow */
        acc = next;
        saw_digit = 1;
    }
    if (!saw_digit) return -1;

    /* Emit to `out` in reverse, then flip. */
    char buf[80]; /* enough for 64-bit binary + sign */
    size_t blen = 0;
    if (acc == 0) {
        buf[blen++] = '0';
    } else {
        while (acc > 0) {
            int d = (int)(acc % (uint64_t)to_base);
            buf[blen++] = HEX_LOWER[d];
            acc /= (uint64_t)to_base;
        }
    }
    size_t need = blen + (negative ? 1 : 0);
    if (need > out_cap) return -1;

    size_t o = 0;
    if (negative) out[o++] = '-';
    for (size_t k = 0; k < blen; ++k) out[o++] = buf[blen - 1 - k];
    return (long)o;
}
