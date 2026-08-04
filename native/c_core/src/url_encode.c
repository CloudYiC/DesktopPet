#include "cloudyi/url_encode.h"

static const char HEX_UPPER[] = "0123456789ABCDEF";

static int is_unreserved(unsigned char c) {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
           (c >= '0' && c <= '9') || c == '-' || c == '_' ||
           c == '.' || c == '~';
}

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

static int hex_value(unsigned char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

size_t cy_url_encode_max_size(size_t in_len) { return in_len * 3; }

long cy_url_encode(const char *in, size_t in_len,
                   char *out, size_t out_cap, int component) {
    size_t i;
    size_t o = 0;
    if (in == 0 || out == 0) return -1;
    for (i = 0; i < in_len; ++i) {
        unsigned char c = (unsigned char)in[i];
        int keep = is_unreserved(c) || (!component && is_reserved(c));
        if (keep) {
            if (o >= out_cap) return -1;
            out[o++] = (char)c;
        } else {
            if (o + 3 > out_cap) return -1;
            out[o++] = '%';
            out[o++] = HEX_UPPER[(c >> 4) & 0x0f];
            out[o++] = HEX_UPPER[c & 0x0f];
        }
    }
    return (long)o;
}

long cy_url_decode(const char *in, size_t in_len,
                   char *out, size_t out_cap) {
    size_t i;
    size_t o = 0;
    if (in == 0 || out == 0) return -1;
    for (i = 0; i < in_len; ++i) {
        char c = in[i];
        if (c == '+') {
            if (o >= out_cap) return -1;
            out[o++] = ' ';
        } else if (c != '%') {
            if (o >= out_cap) return -1;
            out[o++] = c;
        } else {
            int high;
            int low;
            if (i + 2 >= in_len) return -1;
            high = hex_value((unsigned char)in[i + 1]);
            low = hex_value((unsigned char)in[i + 2]);
            if (high < 0 || low < 0 || o >= out_cap) return -1;
            out[o++] = (char)((high << 4) | low);
            i += 2;
        }
    }
    return (long)o;
}
