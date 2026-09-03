#include "cloudyi/packet_inspector.h"

#include <ctype.h>
#include <stdio.h>
#include <string.h>

static int has_bytes(size_t length, size_t offset, size_t count) {
    return offset <= length && count <= length - offset;
}

static unsigned int read_u16_be(const unsigned char *bytes, size_t offset) {
    return ((unsigned int)bytes[offset] << 8) | bytes[offset + 1];
}

static unsigned long read_u32_be(const unsigned char *bytes, size_t offset) {
    return ((unsigned long)bytes[offset] << 24) |
           ((unsigned long)bytes[offset + 1] << 16) |
           ((unsigned long)bytes[offset + 2] << 8) |
           (unsigned long)bytes[offset + 3];
}

static void copy_text(char *target, size_t capacity, const char *source) {
    if (target == 0 || capacity == 0) return;
    if (source == 0) source = "";
    (void)snprintf(target, capacity, "%s", source);
}

static void append_protocol(cy_packet_report *report, const char *name) {
    size_t used;
    if (report == 0 || name == 0 || *name == '\0') return;
    used = strlen(report->protocol);
    if (used != 0 && used + 3 < sizeof(report->protocol)) {
        copy_text(report->protocol + used, sizeof(report->protocol) - used,
                  " / ");
        used = strlen(report->protocol);
    }
    if (used < sizeof(report->protocol)) {
        copy_text(report->protocol + used, sizeof(report->protocol) - used,
                  name);
    }
}

static void add_warning(cy_packet_report *report, const char *code,
                        const char *message, size_t offset) {
    cy_packet_warning *warning;
    int penalty;
    if (report == 0 || report->warning_count >= CY_PACKET_MAX_WARNINGS) return;
    warning = &report->warnings[report->warning_count++];
    copy_text(warning->code, sizeof(warning->code), code);
    copy_text(warning->message, sizeof(warning->message), message);
    warning->offset = offset;
    penalty = (strncmp(code, "invalid-", 8) == 0 ||
               strncmp(code, "truncated-", 10) == 0)
                  ? 30
                  : 10;
    report->confidence = report->confidence > penalty
                             ? report->confidence - penalty
                             : 0;
}

static cy_packet_layer *add_layer(cy_packet_report *report, const char *id,
                                  const char *name, size_t offset,
                                  size_t length, const char *summary) {
    cy_packet_layer *layer;
    if (report == 0 || report->layer_count >= CY_PACKET_MAX_LAYERS) return 0;
    layer = &report->layers[report->layer_count++];
    copy_text(layer->id, sizeof(layer->id), id);
    copy_text(layer->name, sizeof(layer->name), name);
    layer->offset = offset;
    layer->length = length;
    copy_text(layer->summary, sizeof(layer->summary), summary);
    return layer;
}

static void set_layer_length(cy_packet_report *report, size_t index,
                             size_t length) {
    if (report != 0 && index < report->layer_count) {
        report->layers[index].length = length;
    }
}

static void add_field(cy_packet_report *report, const char *layer,
                      const char *name, size_t offset, size_t length,
                      const char *value, const char *summary) {
    cy_packet_field *field;
    if (report == 0 || report->field_count >= CY_PACKET_MAX_FIELDS) return;
    field = &report->fields[report->field_count++];
    copy_text(field->layer, sizeof(field->layer), layer);
    copy_text(field->name, sizeof(field->name), name);
    field->offset = offset;
    field->length = length;
    copy_text(field->value, sizeof(field->value), value);
    copy_text(field->summary, sizeof(field->summary), summary);
}

static void format_mac(const unsigned char *bytes, char *output,
                       size_t capacity) {
    (void)snprintf(output, capacity, "%02X:%02X:%02X:%02X:%02X:%02X",
                   bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]);
}

static void format_ipv4(const unsigned char *bytes, char *output,
                        size_t capacity) {
    (void)snprintf(output, capacity, "%u.%u.%u.%u", bytes[0], bytes[1],
                   bytes[2], bytes[3]);
}

static void format_ipv6(const unsigned char *bytes, char *output,
                        size_t capacity) {
    (void)snprintf(output, capacity,
                   "%02x%02x:%02x%02x:%02x%02x:%02x%02x:"
                   "%02x%02x:%02x%02x:%02x%02x:%02x%02x",
                   bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5],
                   bytes[6], bytes[7], bytes[8], bytes[9], bytes[10], bytes[11],
                   bytes[12], bytes[13], bytes[14], bytes[15]);
}

static void add_payload(cy_packet_report *report, size_t offset, size_t end,
                        const char *summary) {
    char value[64];
    if (end <= offset) return;
    (void)snprintf(value, sizeof(value), "%lu bytes",
                   (unsigned long)(end - offset));
    add_layer(report, "payload", "Payload", offset, end - offset, summary);
    add_field(report, "payload", "data", offset, end - offset, value, summary);
}

static void add_trailing(cy_packet_report *report, size_t offset, size_t end,
                         const char *summary) {
    char value[64];
    if (end <= offset) return;
    (void)snprintf(value, sizeof(value), "%lu bytes",
                   (unsigned long)(end - offset));
    add_layer(report, "trailing", "Trailing bytes", offset, end - offset,
              summary);
    add_field(report, "trailing", "data", offset, end - offset, value,
              summary);
}

static void parse_tcp(const unsigned char *bytes, size_t length, size_t offset,
                      size_t end, cy_packet_report *report);
static void parse_udp(const unsigned char *bytes, size_t length, size_t offset,
                      size_t end, cy_packet_report *report);
static void parse_icmp(const unsigned char *bytes, size_t length, size_t offset,
                       size_t end, int version, cy_packet_report *report);

static void parse_transport(const unsigned char *bytes, size_t length,
                            size_t offset, size_t end, unsigned int protocol,
                            int ip_version, cy_packet_report *report) {
    if (protocol == 6U) {
        parse_tcp(bytes, length, offset, end, report);
    } else if (protocol == 17U) {
        parse_udp(bytes, length, offset, end, report);
    } else if ((ip_version == 4 && protocol == 1U) ||
               (ip_version == 6 && protocol == 58U)) {
        parse_icmp(bytes, length, offset, end, ip_version, report);
    } else {
        char summary[96];
        (void)snprintf(summary, sizeof(summary),
                       "Unrecognized IP next-header value %u", protocol);
        add_warning(report, "unknown-transport", summary, offset);
        add_payload(report, offset, end, "Transport payload is not decoded");
    }
}

static void parse_tcp(const unsigned char *bytes, size_t length, size_t offset,
                      size_t end, cy_packet_report *report) {
    size_t header_length;
    size_t layer_index;
    char value[128];
    unsigned int flags;
    if (end > length) end = length;
    append_protocol(report, "TCP");
    layer_index = report->layer_count;
    add_layer(report, "tcp", "Transmission Control Protocol", offset,
              end > offset ? end - offset : 0, "TCP segment");
    if (!has_bytes(end, offset, 20)) {
        add_warning(report, "truncated-tcp",
                    "TCP header needs at least 20 bytes", offset);
        return;
    }
    (void)snprintf(value, sizeof(value), "%u", read_u16_be(bytes, offset));
    add_field(report, "tcp", "sourcePort", offset, 2, value,
              "Source TCP port");
    (void)snprintf(value, sizeof(value), "%u", read_u16_be(bytes, offset + 2));
    add_field(report, "tcp", "destinationPort", offset + 2, 2, value,
              "Destination TCP port");
    (void)snprintf(value, sizeof(value), "%lu", read_u32_be(bytes, offset + 4));
    add_field(report, "tcp", "sequenceNumber", offset + 4, 4, value,
              "Sequence number");
    (void)snprintf(value, sizeof(value), "%lu", read_u32_be(bytes, offset + 8));
    add_field(report, "tcp", "acknowledgmentNumber", offset + 8, 4, value,
              "Acknowledgment number");
    header_length = (size_t)((bytes[offset + 12] >> 4) * 4U);
    (void)snprintf(value, sizeof(value), "%lu bytes",
                   (unsigned long)header_length);
    add_field(report, "tcp", "headerLength", offset + 12, 1, value,
              "TCP data offset");
    flags = ((unsigned int)(bytes[offset + 12] & 1U) << 8) |
            bytes[offset + 13];
    (void)snprintf(value, sizeof(value), "0x%03X", flags);
    add_field(report, "tcp", "flags", offset + 12, 2, value,
              "NS/CWR/ECE/URG/ACK/PSH/RST/SYN/FIN flags");
    (void)snprintf(value, sizeof(value), "%u", read_u16_be(bytes, offset + 14));
    add_field(report, "tcp", "window", offset + 14, 2, value,
              "Advertised receive window");
    (void)snprintf(value, sizeof(value), "0x%04X",
                   read_u16_be(bytes, offset + 16));
    add_field(report, "tcp", "checksum", offset + 16, 2, value,
              "TCP checksum (not validated)");
    (void)snprintf(value, sizeof(value), "%u", read_u16_be(bytes, offset + 18));
    add_field(report, "tcp", "urgentPointer", offset + 18, 2, value,
              "Urgent pointer");
    if (header_length < 20) {
        add_warning(report, "invalid-tcp-header",
                    "TCP data offset is smaller than 20 bytes", offset + 12);
        return;
    }
    if (!has_bytes(end, offset, header_length)) {
        add_warning(report, "truncated-tcp-options",
                    "TCP header or options exceed available bytes", offset);
        return;
    }
    set_layer_length(report, layer_index, header_length);
    if (header_length > 20) {
        (void)snprintf(value, sizeof(value), "%lu bytes",
                       (unsigned long)(header_length - 20));
        add_field(report, "tcp", "options", offset + 20,
                  header_length - 20, value, "TCP options (raw)");
    }
    add_payload(report, offset + header_length, end, "TCP application data");
}

static void parse_udp(const unsigned char *bytes, size_t length, size_t offset,
                      size_t end, cy_packet_report *report) {
    size_t payload_end;
    unsigned int declared_length;
    char value[96];
    if (end > length) end = length;
    payload_end = end;
    append_protocol(report, "UDP");
    add_layer(report, "udp", "User Datagram Protocol", offset,
              end > offset ? (end - offset < 8 ? end - offset : 8) : 0,
              "UDP datagram header");
    if (!has_bytes(end, offset, 8)) {
        add_warning(report, "truncated-udp", "UDP header needs 8 bytes", offset);
        return;
    }
    (void)snprintf(value, sizeof(value), "%u", read_u16_be(bytes, offset));
    add_field(report, "udp", "sourcePort", offset, 2, value, "Source UDP port");
    (void)snprintf(value, sizeof(value), "%u", read_u16_be(bytes, offset + 2));
    add_field(report, "udp", "destinationPort", offset + 2, 2, value,
              "Destination UDP port");
    declared_length = read_u16_be(bytes, offset + 4);
    (void)snprintf(value, sizeof(value), "%u bytes", declared_length);
    add_field(report, "udp", "length", offset + 4, 2, value,
              "UDP header plus payload length");
    (void)snprintf(value, sizeof(value), "0x%04X",
                   read_u16_be(bytes, offset + 6));
    add_field(report, "udp", "checksum", offset + 6, 2, value,
              "UDP checksum (not validated)");
    if (declared_length < 8U) {
        add_warning(report, "invalid-udp-length",
                    "UDP length is smaller than its header", offset + 4);
    } else if (!has_bytes(end, offset, declared_length)) {
        add_warning(report, "truncated-udp-payload",
                    "UDP length exceeds available packet bytes", offset + 4);
    } else {
        payload_end = offset + declared_length;
        if (payload_end < end) {
            add_warning(report, "udp-trailing-bytes",
                        "Bytes remain after the declared UDP datagram", payload_end);
        }
    }
    add_payload(report, offset + 8, payload_end, "UDP application data");
    add_trailing(report, payload_end, end,
                 "Bytes outside the declared UDP datagram");
}

static void parse_icmp(const unsigned char *bytes, size_t length, size_t offset,
                       size_t end, int version, cy_packet_report *report) {
    char value[96];
    const char *id = version == 6 ? "icmpv6" : "icmp";
    const char *name = version == 6 ? "ICMPv6" : "ICMP";
    if (end > length) end = length;
    append_protocol(report, name);
    add_layer(report, id, name, offset,
              end > offset ? (end - offset < 4 ? end - offset : 4) : 0,
              "Control message header");
    if (!has_bytes(end, offset, 4)) {
        add_warning(report, "truncated-icmp", "ICMP header needs 4 bytes", offset);
        return;
    }
    (void)snprintf(value, sizeof(value), "%u", bytes[offset]);
    add_field(report, id, "type", offset, 1, value, "ICMP message type");
    (void)snprintf(value, sizeof(value), "%u", bytes[offset + 1]);
    add_field(report, id, "code", offset + 1, 1, value, "ICMP message code");
    (void)snprintf(value, sizeof(value), "0x%04X",
                   read_u16_be(bytes, offset + 2));
    add_field(report, id, "checksum", offset + 2, 2, value,
              "ICMP checksum (not validated)");
    add_payload(report, offset + 4, end, "ICMP message-specific data");
}

static void parse_ipv4(const unsigned char *bytes, size_t length, size_t offset,
                       size_t outer_end, cy_packet_report *report) {
    size_t header_length;
    size_t packet_end;
    size_t trailing_start;
    size_t layer_index;
    unsigned int total_length;
    unsigned int fragment;
    char value[128];
    char summary[160];
    if (outer_end > length) outer_end = length;
    packet_end = outer_end;
    trailing_start = outer_end;
    append_protocol(report, "IPv4");
    layer_index = report->layer_count;
    add_layer(report, "ipv4", "Internet Protocol Version 4", offset,
              outer_end > offset ? outer_end - offset : 0, "IPv4 packet");
    if (!has_bytes(outer_end, offset, 20)) {
        add_warning(report, "truncated-ipv4",
                    "IPv4 header needs at least 20 bytes", offset);
        return;
    }
    if ((bytes[offset] >> 4) != 4U) {
        add_warning(report, "invalid-ipv4-version",
                    "Version nibble is not 4", offset);
    }
    (void)snprintf(value, sizeof(value), "%u", bytes[offset] >> 4);
    add_field(report, "ipv4", "version", offset, 1, value,
              "High four bits identify IPv4");
    header_length = (size_t)(bytes[offset] & 0x0FU) * 4U;
    (void)snprintf(value, sizeof(value), "%lu bytes",
                   (unsigned long)header_length);
    add_field(report, "ipv4", "headerLength", offset, 1, value,
              "IPv4 Internet Header Length");
    (void)snprintf(value, sizeof(value), "0x%02X (DSCP=%u, ECN=%u)",
                   bytes[offset + 1], bytes[offset + 1] >> 2,
                   bytes[offset + 1] & 3U);
    add_field(report, "ipv4", "dscpEcn", offset + 1, 1, value,
              "DSCP and ECN bits");
    total_length = read_u16_be(bytes, offset + 2);
    (void)snprintf(value, sizeof(value), "%u bytes", total_length);
    add_field(report, "ipv4", "totalLength", offset + 2, 2, value,
              "IPv4 header plus payload length");
    (void)snprintf(value, sizeof(value), "0x%04X",
                   read_u16_be(bytes, offset + 4));
    add_field(report, "ipv4", "identification", offset + 4, 2, value,
              "Fragment identification");
    fragment = read_u16_be(bytes, offset + 6);
    (void)snprintf(value, sizeof(value), "flags=0x%X, offsetBytes=%u",
                   fragment >> 13, (fragment & 0x1FFFU) * 8U);
    add_field(report, "ipv4", "fragment", offset + 6, 2, value,
              "Fragment flags and offset");
    (void)snprintf(value, sizeof(value), "%u", bytes[offset + 8]);
    add_field(report, "ipv4", "ttl", offset + 8, 1, value, "Time to live");
    (void)snprintf(value, sizeof(value), "%u", bytes[offset + 9]);
    add_field(report, "ipv4", "protocol", offset + 9, 1, value,
              "Encapsulated protocol number");
    (void)snprintf(value, sizeof(value), "0x%04X",
                   read_u16_be(bytes, offset + 10));
    add_field(report, "ipv4", "headerChecksum", offset + 10, 2, value,
              "IPv4 header checksum (not validated)");
    format_ipv4(bytes + offset + 12, value, sizeof(value));
    add_field(report, "ipv4", "source", offset + 12, 4, value,
              "Source IPv4 address");
    format_ipv4(bytes + offset + 16, value, sizeof(value));
    add_field(report, "ipv4", "destination", offset + 16, 4, value,
              "Destination IPv4 address");
    if (header_length < 20) {
        add_warning(report, "invalid-ipv4-header",
                    "IPv4 IHL is smaller than 20 bytes", offset);
        return;
    }
    if (!has_bytes(outer_end, offset, header_length)) {
        add_warning(report, "truncated-ipv4-options",
                    "IPv4 header or options exceed available bytes", offset);
        return;
    }
    if (header_length > 20) {
        (void)snprintf(value, sizeof(value), "%lu bytes",
                       (unsigned long)(header_length - 20));
        add_field(report, "ipv4", "options", offset + 20,
                  header_length - 20, value, "IPv4 options (raw)");
    }
    if (total_length < header_length) {
        add_warning(report, "invalid-ipv4-length",
                    "IPv4 total length is smaller than its header", offset + 2);
        return;
    }
    if (!has_bytes(outer_end, offset, total_length)) {
        add_warning(report, "truncated-ipv4-payload",
                    "IPv4 total length exceeds available bytes", offset + 2);
        packet_end = outer_end;
    } else {
        packet_end = offset + total_length;
        if (packet_end < outer_end) {
            add_warning(report, "ipv4-trailing-bytes",
                        "Bytes remain after the declared IPv4 packet", packet_end);
            trailing_start = packet_end;
        }
    }
    set_layer_length(report, layer_index, header_length);
    if ((fragment & 0x1FFFU) != 0U) {
        (void)snprintf(summary, sizeof(summary),
                       "Non-initial IPv4 fragment; protocol %u not decoded",
                       bytes[offset + 9]);
        add_warning(report, "ipv4-fragment", summary, offset + 6);
        add_payload(report, offset + header_length, packet_end,
                    "Fragment payload");
        add_trailing(report, trailing_start, outer_end,
                     "Bytes outside the declared IPv4 packet");
        return;
    }
    parse_transport(bytes, length, offset + header_length, packet_end,
                    bytes[offset + 9], 4, report);
    add_trailing(report, trailing_start, outer_end,
                 "Bytes outside the declared IPv4 packet");
}

static int is_ipv6_extension(unsigned int next_header) {
    return next_header == 0U || next_header == 43U || next_header == 44U ||
           next_header == 50U || next_header == 51U || next_header == 60U ||
           next_header == 135U;
}

static void parse_ipv6(const unsigned char *bytes, size_t length, size_t offset,
                       size_t outer_end, cy_packet_report *report) {
    size_t packet_end;
    size_t trailing_start;
    unsigned int payload_length;
    unsigned int next_header;
    unsigned long flow;
    char value[160];
    if (outer_end > length) outer_end = length;
    packet_end = outer_end;
    trailing_start = outer_end;
    append_protocol(report, "IPv6");
    add_layer(report, "ipv6", "Internet Protocol Version 6", offset,
              outer_end > offset ? (outer_end - offset < 40 ? outer_end - offset : 40) : 0,
              "IPv6 fixed header");
    if (!has_bytes(outer_end, offset, 40)) {
        add_warning(report, "truncated-ipv6", "IPv6 header needs 40 bytes", offset);
        return;
    }
    if ((bytes[offset] >> 4) != 6U) {
        add_warning(report, "invalid-ipv6-version",
                    "Version nibble is not 6", offset);
    }
    (void)snprintf(value, sizeof(value), "%u", bytes[offset] >> 4);
    add_field(report, "ipv6", "version", offset, 1, value,
              "High four bits identify IPv6");
    flow = read_u32_be(bytes, offset) & 0x0FFFFFFFUL;
    (void)snprintf(value, sizeof(value), "trafficClass=%lu, flowLabel=0x%05lX",
                   (flow >> 20) & 0xFFUL, flow & 0xFFFFFUL);
    add_field(report, "ipv6", "trafficClassAndFlowLabel", offset, 4, value,
              "Traffic class and flow label");
    payload_length = read_u16_be(bytes, offset + 4);
    (void)snprintf(value, sizeof(value), "%u bytes", payload_length);
    add_field(report, "ipv6", "payloadLength", offset + 4, 2, value,
              "Bytes following the fixed IPv6 header");
    next_header = bytes[offset + 6];
    (void)snprintf(value, sizeof(value), "%u", next_header);
    add_field(report, "ipv6", "nextHeader", offset + 6, 1, value,
              "IPv6 next-header number");
    (void)snprintf(value, sizeof(value), "%u", bytes[offset + 7]);
    add_field(report, "ipv6", "hopLimit", offset + 7, 1, value,
              "IPv6 hop limit");
    format_ipv6(bytes + offset + 8, value, sizeof(value));
    add_field(report, "ipv6", "source", offset + 8, 16, value,
              "Source IPv6 address");
    format_ipv6(bytes + offset + 24, value, sizeof(value));
    add_field(report, "ipv6", "destination", offset + 24, 16, value,
              "Destination IPv6 address");
    if (!has_bytes(outer_end, offset + 40, payload_length)) {
        add_warning(report, "truncated-ipv6-payload",
                    "IPv6 payload length exceeds available bytes", offset + 4);
    } else {
        packet_end = offset + 40 + payload_length;
        if (packet_end < outer_end) {
            add_warning(report, "ipv6-trailing-bytes",
                        "Bytes remain after the declared IPv6 packet", packet_end);
            trailing_start = packet_end;
        }
    }
    if (is_ipv6_extension(next_header)) {
        add_warning(report, "ipv6-extension-header",
                    "IPv6 extension headers are preserved as raw payload", offset + 40);
        add_payload(report, offset + 40, packet_end,
                    "IPv6 extension header and payload");
        add_trailing(report, trailing_start, outer_end,
                     "Bytes outside the declared IPv6 packet");
        return;
    }
    parse_transport(bytes, length, offset + 40, packet_end, next_header, 6,
                    report);
    add_trailing(report, trailing_start, outer_end,
                 "Bytes outside the declared IPv6 packet");
}

static void parse_arp(const unsigned char *bytes, size_t length, size_t offset,
                      size_t end, cy_packet_report *report) {
    unsigned int hardware_length;
    unsigned int protocol_length;
    size_t needed;
    size_t cursor;
    size_t layer_index;
    char value[128];
    if (end > length) end = length;
    append_protocol(report, "ARP");
    layer_index = report->layer_count;
    add_layer(report, "arp", "Address Resolution Protocol", offset,
              end > offset ? end - offset : 0, "ARP message");
    if (!has_bytes(end, offset, 8)) {
        add_warning(report, "truncated-arp", "ARP fixed header needs 8 bytes", offset);
        return;
    }
    (void)snprintf(value, sizeof(value), "%u", read_u16_be(bytes, offset));
    add_field(report, "arp", "hardwareType", offset, 2, value,
              "Link-layer address type");
    (void)snprintf(value, sizeof(value), "0x%04X", read_u16_be(bytes, offset + 2));
    add_field(report, "arp", "protocolType", offset + 2, 2, value,
              "Network protocol EtherType");
    hardware_length = bytes[offset + 4];
    protocol_length = bytes[offset + 5];
    (void)snprintf(value, sizeof(value), "%u", hardware_length);
    add_field(report, "arp", "hardwareAddressLength", offset + 4, 1, value,
              "Hardware address size");
    (void)snprintf(value, sizeof(value), "%u", protocol_length);
    add_field(report, "arp", "protocolAddressLength", offset + 5, 1, value,
              "Protocol address size");
    (void)snprintf(value, sizeof(value), "%u", read_u16_be(bytes, offset + 6));
    add_field(report, "arp", "operation", offset + 6, 2, value,
              "ARP request/reply operation");
    if ((size_t)hardware_length > ((size_t)-1 - 8U) / 2U ||
        (size_t)protocol_length >
            ((size_t)-1 - 8U - (size_t)hardware_length * 2U) / 2U) {
        add_warning(report, "invalid-arp-length", "ARP address sizes overflow", offset + 4);
        return;
    }
    needed = 8U + (size_t)hardware_length * 2U +
             (size_t)protocol_length * 2U;
    if (!has_bytes(end, offset, needed)) {
        add_warning(report, "truncated-arp-addresses",
                    "ARP address fields exceed available bytes", offset + 8);
        return;
    }
    set_layer_length(report, layer_index, needed);
    cursor = offset + 8;
    if (hardware_length == 6U) {
        format_mac(bytes + cursor, value, sizeof(value));
    } else {
        (void)snprintf(value, sizeof(value), "%u bytes", hardware_length);
    }
    add_field(report, "arp", "senderHardwareAddress", cursor,
              hardware_length, value, "Sender hardware address");
    cursor += hardware_length;
    if (protocol_length == 4U &&
        read_u16_be(bytes, offset + 2) == 0x0800U) {
        format_ipv4(bytes + cursor, value, sizeof(value));
    } else {
        (void)snprintf(value, sizeof(value), "%u bytes", protocol_length);
    }
    add_field(report, "arp", "senderProtocolAddress", cursor,
              protocol_length, value, "Sender protocol address");
    cursor += protocol_length;
    if (hardware_length == 6U) {
        format_mac(bytes + cursor, value, sizeof(value));
    } else {
        (void)snprintf(value, sizeof(value), "%u bytes", hardware_length);
    }
    add_field(report, "arp", "targetHardwareAddress", cursor,
              hardware_length, value, "Target hardware address");
    cursor += hardware_length;
    if (protocol_length == 4U &&
        read_u16_be(bytes, offset + 2) == 0x0800U) {
        format_ipv4(bytes + cursor, value, sizeof(value));
    } else {
        (void)snprintf(value, sizeof(value), "%u bytes", protocol_length);
    }
    add_field(report, "arp", "targetProtocolAddress", cursor,
              protocol_length, value, "Target protocol address");
    add_trailing(report, offset + needed, end,
                 "Bytes outside the computed ARP message");
}

static void parse_ethernet(const unsigned char *bytes, size_t length,
                           cy_packet_report *report) {
    size_t cursor = 14;
    unsigned int ether_type;
    char value[128];
    append_protocol(report, "Ethernet II");
    add_layer(report, "ethernet", "Ethernet II", 0,
              length < 14 ? length : 14, "Ethernet frame header");
    if (!has_bytes(length, 0, 14)) {
        add_warning(report, "truncated-ethernet",
                    "Ethernet II header needs 14 bytes", 0);
        return;
    }
    format_mac(bytes, value, sizeof(value));
    add_field(report, "ethernet", "destination", 0, 6, value,
              "Destination MAC address");
    format_mac(bytes + 6, value, sizeof(value));
    add_field(report, "ethernet", "source", 6, 6, value,
              "Source MAC address");
    ether_type = read_u16_be(bytes, 12);
    (void)snprintf(value, sizeof(value), "0x%04X", ether_type);
    add_field(report, "ethernet", "etherType", 12, 2, value,
              "Encapsulated protocol EtherType");
    if (ether_type == 0x8100U || ether_type == 0x88A8U) {
        unsigned int tag;
        if (!has_bytes(length, cursor, 4)) {
            add_warning(report, "truncated-vlan", "802.1Q tag needs 4 bytes", cursor);
            return;
        }
        append_protocol(report, "802.1Q");
        add_layer(report, "vlan", "IEEE 802.1Q VLAN", cursor, 4,
                  "VLAN tag");
        tag = read_u16_be(bytes, cursor);
        (void)snprintf(value, sizeof(value), "priority=%u, dei=%u, vlanId=%u",
                       (tag >> 13) & 7U, (tag >> 12) & 1U, tag & 0xFFFU);
        add_field(report, "vlan", "tagControl", cursor, 2, value,
                  "Priority, drop eligibility and VLAN identifier");
        ether_type = read_u16_be(bytes, cursor + 2);
        (void)snprintf(value, sizeof(value), "0x%04X", ether_type);
        add_field(report, "vlan", "etherType", cursor + 2, 2, value,
                  "Encapsulated protocol EtherType");
        cursor += 4;
    }
    if (ether_type == 0x0800U) {
        parse_ipv4(bytes, length, cursor, length, report);
    } else if (ether_type == 0x86DDU) {
        parse_ipv6(bytes, length, cursor, length, report);
    } else if (ether_type == 0x0806U) {
        parse_arp(bytes, length, cursor, length, report);
    } else {
        (void)snprintf(value, sizeof(value),
                       "EtherType 0x%04X is not decoded", ether_type);
        add_warning(report, "unknown-ethertype", value, 12);
        add_payload(report, cursor, length, "Ethernet payload is not decoded");
    }
}

static int hex_digit(unsigned char character) {
    if (character >= '0' && character <= '9') return character - '0';
    if (character >= 'a' && character <= 'f') return character - 'a' + 10;
    if (character >= 'A' && character <= 'F') return character - 'A' + 10;
    return -1;
}

size_t cy_packet_hex_max_decoded_size(size_t text_length) {
    return text_length / 2U + 1U;
}

long cy_packet_hex_decode(const char *text, size_t text_length,
                          unsigned char *output, size_t output_capacity) {
    size_t index;
    size_t written = 0;
    int high = -1;
    if (text == 0 || output == 0) return -1;
    for (index = 0; index < text_length; ++index) {
        unsigned char character = (unsigned char)text[index];
        int digit;
        if (isspace(character) || character == ':' || character == '-' ||
            character == '_' || character == ',') {
            continue;
        }
        if (high < 0 && character == '0' && index + 1 < text_length &&
            (text[index + 1] == 'x' || text[index + 1] == 'X')) {
            ++index;
            continue;
        }
        digit = hex_digit(character);
        if (digit < 0) return -2;
        if (high < 0) {
            high = digit;
        } else {
            if (written >= output_capacity) return -3;
            output[written++] = (unsigned char)((high << 4) | digit);
            high = -1;
        }
    }
    if (high >= 0) return -4;
    return (long)written;
}

int cy_packet_mode_parse(const char *name, cy_packet_mode *mode) {
    if (name == 0 || mode == 0) return -1;
    if (strcmp(name, "auto") == 0) *mode = CY_PACKET_MODE_AUTO;
    else if (strcmp(name, "ethernet") == 0) *mode = CY_PACKET_MODE_ETHERNET;
    else if (strcmp(name, "ipv4") == 0) *mode = CY_PACKET_MODE_IPV4;
    else if (strcmp(name, "ipv6") == 0) *mode = CY_PACKET_MODE_IPV6;
    else if (strcmp(name, "tcp") == 0) *mode = CY_PACKET_MODE_TCP;
    else if (strcmp(name, "udp") == 0) *mode = CY_PACKET_MODE_UDP;
    else if (strcmp(name, "raw") == 0) *mode = CY_PACKET_MODE_RAW;
    else return -1;
    return 0;
}

const char *cy_packet_mode_name(cy_packet_mode mode) {
    switch (mode) {
        case CY_PACKET_MODE_AUTO: return "auto";
        case CY_PACKET_MODE_ETHERNET: return "ethernet";
        case CY_PACKET_MODE_IPV4: return "ipv4";
        case CY_PACKET_MODE_IPV6: return "ipv6";
        case CY_PACKET_MODE_TCP: return "tcp";
        case CY_PACKET_MODE_UDP: return "udp";
        case CY_PACKET_MODE_RAW: return "raw";
        default: return "unknown";
    }
}

static int looks_like_ipv4(const unsigned char *bytes, size_t length,
                           size_t offset) {
    size_t header_length;
    unsigned int total_length;
    if (!has_bytes(length, offset, 20) || (bytes[offset] >> 4) != 4U) return 0;
    header_length = (size_t)(bytes[offset] & 0x0FU) * 4U;
    if (header_length < 20U || !has_bytes(length, offset, header_length)) return 0;
    total_length = read_u16_be(bytes, offset + 2);
    return total_length >= header_length &&
           has_bytes(length, offset, (size_t)total_length);
}

static int looks_like_ipv6(const unsigned char *bytes, size_t length,
                           size_t offset) {
    unsigned int payload_length;
    if (!has_bytes(length, offset, 40) || (bytes[offset] >> 4) != 6U) return 0;
    payload_length = read_u16_be(bytes, offset + 4);
    return has_bytes(length, offset + 40U, (size_t)payload_length);
}

static int looks_like_arp(const unsigned char *bytes, size_t length,
                          size_t offset) {
    size_t needed;
    if (!has_bytes(length, offset, 8)) return 0;
    needed = 8U + (size_t)bytes[offset + 4] * 2U +
             (size_t)bytes[offset + 5] * 2U;
    return has_bytes(length, offset, needed);
}

static int looks_like_ethernet(const unsigned char *bytes, size_t length) {
    size_t offset = 14U;
    unsigned int ether_type;
    if (!has_bytes(length, 0, 14)) return 0;
    ether_type = read_u16_be(bytes, 12);
    if (ether_type == 0x8100U || ether_type == 0x88A8U) {
        if (!has_bytes(length, offset, 4)) return 0;
        ether_type = read_u16_be(bytes, offset + 2);
        offset += 4;
    }
    if (ether_type == 0x0800U) return looks_like_ipv4(bytes, length, offset);
    if (ether_type == 0x86DDU) return looks_like_ipv6(bytes, length, offset);
    if (ether_type == 0x0806U) return looks_like_arp(bytes, length, offset);
    return 0;
}

int cy_packet_inspect(const unsigned char *bytes, size_t length,
                      cy_packet_mode mode, cy_packet_report *report) {
    cy_packet_mode selected = mode;
    if (bytes == 0 || report == 0) return -1;
    if (mode < CY_PACKET_MODE_AUTO || mode > CY_PACKET_MODE_RAW) return -2;
    memset(report, 0, sizeof(*report));
    report->byte_count = length;
    report->mode = mode;
    report->confidence = mode == CY_PACKET_MODE_AUTO
                             ? 20
                             : (mode == CY_PACKET_MODE_RAW ? 0 : 65);
    if (length == 0) {
        copy_text(report->protocol, sizeof(report->protocol), "Empty");
        add_warning(report, "empty-input", "No packet bytes were supplied", 0);
        return 0;
    }
    if (mode == CY_PACKET_MODE_AUTO) {
        if (looks_like_ethernet(bytes, length)) {
            selected = CY_PACKET_MODE_ETHERNET;
            report->confidence = 98;
        }
        if (selected == CY_PACKET_MODE_AUTO &&
            looks_like_ipv4(bytes, length, 0)) {
            selected = CY_PACKET_MODE_IPV4;
            report->confidence = 88;
        } else if (selected == CY_PACKET_MODE_AUTO &&
                   looks_like_ipv6(bytes, length, 0)) {
            selected = CY_PACKET_MODE_IPV6;
            report->confidence = 88;
        } else if (selected == CY_PACKET_MODE_AUTO) {
            selected = CY_PACKET_MODE_RAW;
        }
    }
    switch (selected) {
        case CY_PACKET_MODE_ETHERNET:
            parse_ethernet(bytes, length, report);
            break;
        case CY_PACKET_MODE_IPV4:
            parse_ipv4(bytes, length, 0, length, report);
            break;
        case CY_PACKET_MODE_IPV6:
            parse_ipv6(bytes, length, 0, length, report);
            break;
        case CY_PACKET_MODE_TCP:
            parse_tcp(bytes, length, 0, length, report);
            break;
        case CY_PACKET_MODE_UDP:
            parse_udp(bytes, length, 0, length, report);
            break;
        case CY_PACKET_MODE_RAW:
            copy_text(report->protocol, sizeof(report->protocol), "Raw bytes");
            add_payload(report, 0, length,
                        "No protocol boundary can be inferred safely");
            if (mode == CY_PACKET_MODE_AUTO) {
                add_warning(report, "unknown-protocol",
                            "Automatic detection found no reliable standard header", 0);
            }
            break;
        default:
            return -2;
    }
    if (report->protocol[0] == '\0') {
        copy_text(report->protocol, sizeof(report->protocol), "Unknown");
    }
    return 0;
}
