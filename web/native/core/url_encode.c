#include "url_encode.h"

static const char HEX_UPPER[16] = "0123456789ABCDEF";

static int is_unreserved(unsigned char c) {
    return (c >= 'A' && c <= 'Z') ||
           (c >= 'a' && c <= 'z') ||
           (c >= '0' && c <= '9') ||
           c == '-' || c == '_' || c == '.' || c == '~';
}

/* Reserved set per RFC 3986 §2.2 — kept as-is when `component` mode is off. */
static int is_reserved(unsigned char c) {
    switch (c) {
        case '!': case '*': case '\'': case '(': case ')': case ';':
        case ':': case '@': case '&': case '=': case '+': case '$':
        case ',': case '/': case '?': case '#': case '[': case ']':
            return 1;
        default:
            return 0;
    }
}

size_t cy_url_encode_max_size(size_t in_len) {
    return in_len * 3;
}

long cy_url_encode(const char *in, size_t in_len,
                   char *out, size_t out_cap,
                   int component) {
    size_t o = 0;
    for (size_t i = 0; i < in_len; ++i) {
        unsigned char c = (unsigned char)in[i];
        int keep = is_unreserved(c) || (!component && is_reserved(c));
        if (keep) {
            if (o >= out_cap) return -1;
            out[o++] = (char)c;
        } else {
            if (o + 3 > out_cap) return -1;
            out[o++] = '%';
            out[o++] = HEX_UPPER[(c >> 4) & 0x0F];
            out[o++] = HEX_UPPER[ c       & 0x0F];
        }
    }
    return (long)o;
}

static int hex_value(unsigned char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

long cy_url_decode(const char *in, size_t in_len,
                   char *out, size_t out_cap) {
    size_t o = 0;
    for (size_t i = 0; i < in_len; ++i) {
        char c = in[i];
        if (c == '+') {
            /* form-urlencoded historically uses '+' for space; tolerate it */
            if (o >= out_cap) return -1;
            out[o++] = ' ';
            continue;
        }
        if (c != '%') {
            if (o >= out_cap) return -1;
            out[o++] = c;
            continue;
        }
        /* %XX */
        if (i + 2 >= in_len) return -1;
        int hi = hex_value((unsigned char)in[i+1]);
        int lo = hex_value((unsigned char)in[i+2]);
        if (hi < 0 || lo < 0) return -1;
        if (o >= out_cap) return -1;
        out[o++] = (char)((hi << 4) | lo);
        i += 2;
    }
    return (long)o;
}
