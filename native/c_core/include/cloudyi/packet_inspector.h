/* Portable, allocation-free network packet inspection primitives. */
#ifndef CLOUDYI_PACKET_INSPECTOR_H
#define CLOUDYI_PACKET_INSPECTOR_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#define CY_PACKET_MAX_FIELDS 64
#define CY_PACKET_MAX_LAYERS 10
#define CY_PACKET_MAX_WARNINGS 12

typedef enum cy_packet_mode {
    CY_PACKET_MODE_AUTO = 0,
    CY_PACKET_MODE_ETHERNET,
    CY_PACKET_MODE_IPV4,
    CY_PACKET_MODE_IPV6,
    CY_PACKET_MODE_TCP,
    CY_PACKET_MODE_UDP,
    CY_PACKET_MODE_RAW
} cy_packet_mode;

typedef struct cy_packet_field {
    char layer[24];
    char name[48];
    size_t offset;
    size_t length;
    char value[128];
    char summary[160];
} cy_packet_field;

typedef struct cy_packet_layer {
    char id[24];
    char name[48];
    size_t offset;
    size_t length;
    char summary[160];
} cy_packet_layer;

typedef struct cy_packet_warning {
    char code[32];
    char message[160];
    size_t offset;
} cy_packet_warning;

typedef struct cy_packet_report {
    size_t byte_count;
    cy_packet_mode mode;
    char protocol[96];
    int confidence;
    cy_packet_field fields[CY_PACKET_MAX_FIELDS];
    size_t field_count;
    cy_packet_layer layers[CY_PACKET_MAX_LAYERS];
    size_t layer_count;
    cy_packet_warning warnings[CY_PACKET_MAX_WARNINGS];
    size_t warning_count;
} cy_packet_report;

/* Converts a normalized hexadecimal string into bytes. Whitespace, ':', '-'
 * and '_' separators plus optional 0x prefixes are accepted. */
size_t cy_packet_hex_max_decoded_size(size_t text_length);
long cy_packet_hex_decode(const char *text, size_t text_length,
                          unsigned char *output, size_t output_capacity);

/* Maps a public operation name to a parser mode. Returns zero on success. */
int cy_packet_mode_parse(const char *name, cy_packet_mode *mode);
const char *cy_packet_mode_name(cy_packet_mode mode);

/* Inspects a byte buffer without reading beyond its supplied length. The
 * report owns all metadata and contains no pointers into the input buffer. */
int cy_packet_inspect(const unsigned char *bytes, size_t length,
                      cy_packet_mode mode, cy_packet_report *report);

#ifdef __cplusplus
}
#endif

#endif /* CLOUDYI_PACKET_INSPECTOR_H */
