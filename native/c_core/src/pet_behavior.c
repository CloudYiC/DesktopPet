#include "cloudyi/pet_behavior.h"

#include <ctype.h>
#include <string.h>

int cloudyi_pet_should_show(int workspace_on_desktop, int manually_hidden,
                           int presenting) {
  return presenting || (!workspace_on_desktop && !manually_hidden);
}

static int hex_digit(unsigned char value) {
  if (value >= '0' && value <= '9') return value - '0';
  if (value >= 'a' && value <= 'f') return value - 'a' + 10;
  if (value >= 'A' && value <= 'F') return value - 'A' + 10;
  return -1;
}

static int scheme_matches(const char* value, size_t length, const char* scheme) {
  size_t index, expected = strlen(scheme);
  if (length < expected) return 0;
  for (index = 0; index < expected; ++index) {
    if (tolower((unsigned char)value[index]) != scheme[index]) return 0;
  }
  return 1;
}

static int ipv4_valid(const char* text, size_t length) {
  size_t index;
  int pieces = 0, digits = 0, value = 0;
  for (index = 0; index <= length; ++index) {
    const char character = index == length ? '.' : text[index];
    if (character == '.') {
      if (!digits || value > 255 || ++pieces > 4) return 0;
      digits = 0; value = 0;
    } else {
      if (character < '0' || character > '9' || ++digits > 3) return 0;
      value = value * 10 + character - '0';
    }
  }
  return pieces == 4;
}

static int ipv6_valid(const char* text, size_t length) {
  size_t index = 0;
  int groups = 0, compressed = 0;
  if (!length) return 0;
  if (text[0] == ':') {
    if (length < 2 || text[1] != ':') return 0;
    compressed = 1; index = 2;
  }
  while (index < length) {
    size_t start = index;
    while (index < length && text[index] != ':') ++index;
    if (memchr(text + start, '.', index - start)) {
      if (!ipv4_valid(text + start, index - start) || index != length) return 0;
      groups += 2;
    } else {
      size_t digit;
      if (index == start || index - start > 4) return 0;
      for (digit = start; digit < index; ++digit)
        if (hex_digit((unsigned char)text[digit]) < 0) return 0;
      ++groups;
    }
    if (index < length) {
      ++index;
      if (index < length && text[index] == ':') {
        if (compressed) return 0;
        compressed = 1; ++index;
      } else if (index == length) return 0;
    }
  }
  return compressed ? groups < 8 : groups == 8;
}

int cloudyi_shortcut_url_is_valid(const char* url, size_t length) {
  size_t start, end, host_end, index;
  if (!url || length > 2048) return 0;
  if (!length) return 1;
  if (scheme_matches(url, length, "https://")) start = 8;
  else if (scheme_matches(url, length, "http://")) start = 7;
  else return 0;
  for (index = 0; index < length; ++index) {
    unsigned char character = (unsigned char)url[index];
    if (character <= 32 || character == 127 || character == '\\' ||
        character == '"' || character == '<' || character == '>' ||
        character == '`' || character == '|' || character == '^') return 0;
    if (character == '%') {
      int high, low, decoded;
      if (index + 2 >= length) return 0;
      high = hex_digit((unsigned char)url[index + 1]);
      low = hex_digit((unsigned char)url[index + 2]);
      if (high < 0 || low < 0) return 0;
      decoded = high * 16 + low;
      if (decoded < 32 || decoded == 127 || decoded == '\\' || decoded == '"') return 0;
      index += 2;
    }
  }
  end = start;
  while (end < length && url[end] != '/' && url[end] != '?' && url[end] != '#') ++end;
  if (start == end) return 0;
  host_end = end;
  if (url[start] == '[') {
    host_end = start + 1;
    while (host_end < end && url[host_end] != ']') ++host_end;
    if (host_end == end || !ipv6_valid(url + start + 1, host_end - start - 1)) return 0;
    ++host_end;
    if (host_end < end && url[host_end] != ':') return 0;
  } else {
    int numeric = 1, has_dot = 0;
    size_t label_start = start;
    for (index = start; index < end; ++index) {
      const unsigned char character = (unsigned char)url[index];
      if (character == ':') { host_end = index; break; }
      if (character == '.') {
        if (index == label_start || url[index - 1] == '-' || index - label_start > 63) return 0;
        label_start = index + 1; has_dot = 1;
      } else {
        if (!((character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
              (character >= '0' && character <= '9') || character == '-' || character == '_')) return 0;
        if (index == label_start && character == '-') return 0;
        if (character < '0' || character > '9') numeric = 0;
      }
    }
    if (host_end == start || host_end - start > 253 || url[host_end - 1] == '-' ||
        label_start == host_end || host_end - label_start > 63) return 0;
    if (numeric && has_dot && !ipv4_valid(url + start, host_end - start)) return 0;
  }
  if (host_end < end) {
    unsigned int port = 0;
    if (++host_end == end) return 0;
    for (index = host_end; index < end; ++index) {
      if (url[index] < '0' || url[index] > '9' || index - host_end >= 5) return 0;
      port = port * 10 + (unsigned int)(url[index] - '0');
    }
    if (!port || port > 65535) return 0;
  }
  return 1;
}

static int clamp_int(int value, int lower, int upper) {
  if (upper < lower) return lower;
  return value < lower ? lower : (value > upper ? upper : value);
}

static int round_coordinate(double value) {
  return (int)(value < 0 ? value - 0.5 : value + 0.5);
}

cloudyi_pet_rect cloudyi_pet_rest_after_dpi(cloudyi_pet_rect resting,
    cloudyi_pet_rect work, unsigned int old_dpi, unsigned int new_dpi, int single) {
  cloudyi_pet_rect result;
  const double old_scale = (old_dpi ? old_dpi : 96) / 96.0;
  const double new_scale = (new_dpi ? new_dpi : 96) / 96.0;
  const double center_x = (resting.left + (double)resting.right) / 2;
  const double center_y = resting.bottom - (single ? 107 : 162) * old_scale;
  const int width = round_coordinate(320 * new_scale);
  const int height = round_coordinate(360 * new_scale);
  result.left = clamp_int(round_coordinate(center_x - width / 2.0),
                          work.left, work.right - width);
  result.top = clamp_int(round_coordinate(center_y + (single ? 107 : 162) * new_scale) - height,
                         work.top, work.bottom - height);
  result.right = result.left + width;
  result.bottom = result.top + height;
  return result;
}

cloudyi_pet_menu_geometry cloudyi_pet_menu_bounds(
    cloudyi_pet_rect resting, cloudyi_pet_rect work, unsigned int dpi, int single) {
  cloudyi_pet_menu_geometry result;
  double scale = (dpi ? dpi : 96) / 96.0;
  int width = resting.right - resting.left;
  int height = (int)(620 * scale + 0.5);
  int character_width = (int)((single ? 210 : 255) * scale + 0.5);
  int character_left = resting.left + (width - character_width) / 2;
  int character_top = resting.bottom - (int)((single ? 212 : 332) * scale + 0.5);
  int character_bottom = character_top + (int)((single ? 210 : 340) * scale + 0.5);
  int above_y, below_y, left, top;
  result.side = 0;
  /* Short/high-DPI desktops may have room beside the character, but not above
   * or below. Keep both the character and all three buttons unobscured. */
  if (character_top - work.top < (int)(248 * scale) &&
      work.bottom - character_bottom < (int)(248 * scale)) {
    int left_space = character_left - work.left;
    int right_space = work.right - character_left - character_width;
    if (left_space >= (int)(316 * scale) || right_space >= (int)(316 * scale)) {
      result.side = left_space >= right_space ? -1 : 1;
      width = (int)(650 * scale + 0.5);
      if (width > work.right - work.left) width = work.right - work.left;
      height = resting.bottom - resting.top;
      if (height > work.bottom - work.top) height = work.bottom - work.top;
      left = result.side < 0 ? character_left - (int)(316 * scale + 0.5)
                            : character_left - (int)(8 * scale + 0.5);
      left = clamp_int(left, work.left, work.right - width);
      top = clamp_int(resting.top, work.top, work.bottom - height);
      result.bounds.left = left; result.bounds.top = top;
      result.bounds.right = left + width; result.bounds.bottom = top + height;
      result.character_left_css = (character_left - left) / scale;
      result.character_top_css = (character_top - top) / scale;
      result.above = 0;
      return result;
    }
  }
  if (height > work.bottom - work.top) height = work.bottom - work.top;
  above_y = resting.bottom - height;
  below_y = character_top - (int)(2 * scale + 0.5);
  result.above = above_y >= work.top ||
      (below_y + height > work.bottom && character_top - work.top >= work.bottom - character_bottom);
  top = clamp_int(result.above ? above_y : below_y, work.top, work.bottom - height);
  left = clamp_int(resting.left, work.left, work.right - width);
  result.bounds.left = left; result.bounds.top = top;
  result.bounds.right = left + width; result.bounds.bottom = top + height;
  result.character_left_css = (character_left - left) / scale;
  result.character_top_css = (character_top - top) / scale;
  return result;
}
