/*
 * base64.c — RFC 4648 implementation.
 *
 * The decode table is built lazily on the first decode call; it maps every
 * ASCII byte to its 6-bit value (or sentinel 0xFF for "not a base64 char").
 * Both alphabets share the same table because the URL-safe substitutions
 * (- and _) sit in slots that the standard alphabet never uses.
 */
#include "base64.h"

static const char STD_ALPHA[64] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static const char URL_ALPHA[64] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

static unsigned char DECODE_TABLE[256];
static int decode_table_ready = 0;

static void init_decode_table(void) {
    for (int i = 0; i < 256; ++i) DECODE_TABLE[i] = 0xFF;
    for (int i = 0; i < 64; ++i) DECODE_TABLE[(unsigned char)STD_ALPHA[i]] = (unsigned char)i;
    /* URL-safe extras (62 & 63 are - and _) */
    DECODE_TABLE[(unsigned char)'-'] = 62;
    DECODE_TABLE[(unsigned char)'_'] = 63;
    decode_table_ready = 1;
}

size_t cy_base64_encode_max_size(size_t in_len) {
    /* Each 3-byte group becomes 4 chars; round up. */
    return ((in_len + 2) / 3) * 4;
}

size_t cy_base64_decode_max_size(size_t in_len) {
    /* Worst case: every 4 chars become 3 bytes. */
    return (in_len / 4) * 3 + 3;
}

long cy_base64_encode(const unsigned char *in, size_t in_len,
                      char *out, size_t out_cap,
                      int url_safe, int pad) {
    if (in == 0 || out == 0) return -1;
    const char *alpha = url_safe ? URL_ALPHA : STD_ALPHA;

    size_t need = ((in_len + 2) / 3) * 4;
    if (!pad && (in_len % 3) != 0) {
        /* Unpadded: trim 1 or 2 chars worth of trailing `=`. */
        need -= (3 - (in_len % 3));
    }
    if (need > out_cap) return -1;

    size_t i = 0, o = 0;
    while (i + 3 <= in_len) {
        unsigned int v = ((unsigned int)in[i] << 16) |
                         ((unsigned int)in[i+1] << 8) |
                         ((unsigned int)in[i+2]);
        out[o++] = alpha[(v >> 18) & 0x3F];
        out[o++] = alpha[(v >> 12) & 0x3F];
        out[o++] = alpha[(v >> 6)  & 0x3F];
        out[o++] = alpha[ v        & 0x3F];
        i += 3;
    }

    size_t rem = in_len - i;
    if (rem == 1) {
        unsigned int v = (unsigned int)in[i] << 16;
        out[o++] = alpha[(v >> 18) & 0x3F];
        out[o++] = alpha[(v >> 12) & 0x3F];
        if (pad) { out[o++] = '='; out[o++] = '='; }
    } else if (rem == 2) {
        unsigned int v = ((unsigned int)in[i] << 16) | ((unsigned int)in[i+1] << 8);
        out[o++] = alpha[(v >> 18) & 0x3F];
        out[o++] = alpha[(v >> 12) & 0x3F];
        out[o++] = alpha[(v >> 6)  & 0x3F];
        if (pad) { out[o++] = '='; }
    }

    return (long)o;
}

long cy_base64_decode(const char *in, size_t in_len,
                      unsigned char *out, size_t out_cap) {
    if (in == 0 || out == 0) return -1;
    if (!decode_table_ready) init_decode_table();

    unsigned int acc = 0;
    int acc_bits = 0;
    size_t o = 0;

    for (size_t i = 0; i < in_len; ++i) {
        unsigned char c = (unsigned char)in[i];
        if (c == '=' ) break;                          /* padding signals end */
        if (c == ' ' || c == '\r' || c == '\n' || c == '\t') continue;
        unsigned char val = DECODE_TABLE[c];
        if (val == 0xFF) return -1;                    /* invalid char */

        acc = (acc << 6) | val;
        acc_bits += 6;
        if (acc_bits >= 8) {
            acc_bits -= 8;
            if (o >= out_cap) return -1;
            out[o++] = (unsigned char)((acc >> acc_bits) & 0xFF);
        }
    }

    return (long)o;
}
