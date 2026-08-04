#include "cloudyi/store_tools.h"

static const char CY_HEX[] = "0123456789abcdef";
static const char CY_LOWER[] = "abcdefghijklmnopqrstuvwxyz";
static const char CY_UPPER[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
static const char CY_DIGITS[] = "0123456789";
static const char CY_SYMBOLS[] = "!@#$%^&*()-_=+[]{};:,.?/";

static void cy_copy(char *dst, const char *src, size_t len) {
  size_t index;
  for (index = 0; index < len; ++index) dst[index] = src[index];
}

static int cy_is_space(unsigned char ch) {
  return ch == ' ' || ch == '\n' || ch == '\r' || ch == '\t' ||
         ch == '\f' || ch == '\v';
}

static int cy_is_digit(unsigned char ch) {
  return ch >= '0' && ch <= '9';
}

static int cy_write_uuid(const unsigned char bytes[16], char *out,
                         size_t out_cap) {
  int source;
  int target = 0;
  if (!bytes || !out || out_cap < 37) return -1;
  for (source = 0; source < 16; ++source) {
    if (source == 4 || source == 6 || source == 8 || source == 10) {
      out[target++] = '-';
    }
    out[target++] = CY_HEX[(bytes[source] >> 4) & 0x0f];
    out[target++] = CY_HEX[bytes[source] & 0x0f];
  }
  out[target] = '\0';
  return target;
}

int cy_uuid_v4(const unsigned char random16[16], char *out, size_t out_cap) {
  unsigned char bytes[16];
  int index;
  if (!random16) return -1;
  for (index = 0; index < 16; ++index) bytes[index] = random16[index];
  bytes[6] = (unsigned char)((bytes[6] & 0x0f) | 0x40);
  bytes[8] = (unsigned char)((bytes[8] & 0x3f) | 0x80);
  return cy_write_uuid(bytes, out, out_cap);
}

int cy_uuid_v7(uint64_t unix_ms, const unsigned char random10[10],
               char *out, size_t out_cap) {
  unsigned char bytes[16];
  if (!random10) return -1;
  bytes[0] = (unsigned char)((unix_ms >> 40) & 0xff);
  bytes[1] = (unsigned char)((unix_ms >> 32) & 0xff);
  bytes[2] = (unsigned char)((unix_ms >> 24) & 0xff);
  bytes[3] = (unsigned char)((unix_ms >> 16) & 0xff);
  bytes[4] = (unsigned char)((unix_ms >> 8) & 0xff);
  bytes[5] = (unsigned char)(unix_ms & 0xff);
  bytes[6] = (unsigned char)(0x70 | (random10[0] & 0x0f));
  bytes[7] = random10[1];
  bytes[8] = (unsigned char)(0x80 | (random10[2] & 0x3f));
  bytes[9] = random10[3];
  bytes[10] = random10[4];
  bytes[11] = random10[5];
  bytes[12] = random10[6];
  bytes[13] = random10[7];
  bytes[14] = random10[8];
  bytes[15] = random10[9];
  return cy_write_uuid(bytes, out, out_cap);
}

/* Rejection sampling avoids modulo bias when mapping random bytes. */
static int cy_random_index(const unsigned char *random_bytes,
                           size_t random_len, size_t *cursor,
                           size_t range, size_t *value) {
  unsigned int limit;
  if (!random_bytes || !cursor || !value || range == 0 || range > 256) {
    return 0;
  }
  limit = 256U - (256U % (unsigned int)range);
  while (*cursor < random_len) {
    const unsigned int sample = random_bytes[(*cursor)++];
    if (sample < limit) {
      *value = sample % range;
      return 1;
    }
  }
  return 0;
}

static int cy_pick_character(const unsigned char *random_bytes,
                             size_t random_len, size_t *cursor,
                             const char *alphabet, size_t alphabet_len,
                             char *value) {
  size_t index;
  if (!cy_random_index(random_bytes, random_len, cursor, alphabet_len,
                       &index)) {
    return 0;
  }
  *value = alphabet[index];
  return 1;
}

int cy_password_generate(const unsigned char *random_bytes, size_t random_len,
                         int length, int use_lower, int use_upper,
                         int use_digits, int use_symbols,
                         char *out, size_t out_cap) {
  char charset[128];
  size_t charset_len = 0;
  size_t cursor = 0;
  int position = 0;
  int group_count = 0;
  int index;

  if (!random_bytes || !out || length <= 0 ||
      out_cap < (size_t)length + 1) {
    return -1;
  }

#define CY_ADD_GROUP(enabled, alphabet)                                      \
  do {                                                                        \
    if (enabled) {                                                            \
      const size_t group_len = sizeof(alphabet) - 1;                         \
      cy_copy(charset + charset_len, alphabet, group_len);                   \
      charset_len += group_len;                                               \
      ++group_count;                                                          \
    }                                                                         \
  } while (0)

  CY_ADD_GROUP(use_lower, CY_LOWER);
  CY_ADD_GROUP(use_upper, CY_UPPER);
  CY_ADD_GROUP(use_digits, CY_DIGITS);
  CY_ADD_GROUP(use_symbols, CY_SYMBOLS);

  if (charset_len == 0 || length < group_count) return -1;

#define CY_REQUIRE_GROUP(enabled, alphabet)                                  \
  do {                                                                        \
    if (enabled &&                                                            \
        !cy_pick_character(random_bytes, random_len, &cursor, alphabet,       \
                           sizeof(alphabet) - 1, &out[position++])) {          \
      out[0] = '\0';                                                         \
      return -2;                                                              \
    }                                                                         \
  } while (0)

  CY_REQUIRE_GROUP(use_lower, CY_LOWER);
  CY_REQUIRE_GROUP(use_upper, CY_UPPER);
  CY_REQUIRE_GROUP(use_digits, CY_DIGITS);
  CY_REQUIRE_GROUP(use_symbols, CY_SYMBOLS);

  while (position < length) {
    if (!cy_pick_character(random_bytes, random_len, &cursor, charset,
                           charset_len, &out[position++])) {
      out[0] = '\0';
      return -2;
    }
  }

  /* Shuffle required leading characters into unpredictable positions. */
  for (index = length - 1; index > 0; --index) {
    size_t swap_index;
    char temporary;
    if (!cy_random_index(random_bytes, random_len, &cursor,
                         (size_t)index + 1, &swap_index)) {
      out[0] = '\0';
      return -2;
    }
    temporary = out[index];
    out[index] = out[swap_index];
    out[swap_index] = temporary;
  }
  out[length] = '\0';
  return length;

#undef CY_REQUIRE_GROUP
#undef CY_ADD_GROUP
}

static int64_t cy_floor_div(int64_t value, int64_t divisor) {
  const int64_t quotient = value / divisor;
  const int64_t remainder = value % divisor;
  return (remainder != 0 && ((remainder < 0) != (divisor < 0)))
             ? quotient - 1
             : quotient;
}

/* Gregorian civil-date conversion based on 400-year eras. */
static void cy_civil_from_days(int64_t days, int *year, int *month, int *day) {
  int calculated_year;
  unsigned int day_of_era;
  unsigned int year_of_era;
  unsigned int day_of_year;
  unsigned int month_prime;
  unsigned int calculated_day;
  unsigned int calculated_month;
  const int64_t era = ((days += 719468) >= 0 ? days : days - 146096) /
                      146097;

  day_of_era = (unsigned int)(days - era * 146097);
  year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36524 -
                 day_of_era / 146096) /
                365;
  calculated_year = (int)year_of_era + (int)era * 400;
  day_of_year = day_of_era -
                (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
  month_prime = (5 * day_of_year + 2) / 153;
  calculated_day = day_of_year - (153 * month_prime + 2) / 5 + 1;
  calculated_month = month_prime < 10 ? month_prime + 3 : month_prime - 9;
  calculated_year += calculated_month <= 2;
  *year = calculated_year;
  *month = (int)calculated_month;
  *day = (int)calculated_day;
}

static void cy_write_2(char *out, int value) {
  out[0] = (char)('0' + ((value / 10) % 10));
  out[1] = (char)('0' + (value % 10));
}

static void cy_write_3(char *out, int value) {
  out[0] = (char)('0' + ((value / 100) % 10));
  out[1] = (char)('0' + ((value / 10) % 10));
  out[2] = (char)('0' + (value % 10));
}

static void cy_write_4(char *out, int value) {
  out[0] = (char)('0' + ((value / 1000) % 10));
  out[1] = (char)('0' + ((value / 100) % 10));
  out[2] = (char)('0' + ((value / 10) % 10));
  out[3] = (char)('0' + (value % 10));
}

int cy_timestamp_to_iso(int64_t value, int unit, char *out, size_t out_cap) {
  int64_t seconds = value;
  int milliseconds = 0;
  int64_t days;
  int64_t remainder;
  int year;
  int month;
  int day;
  int hour;
  int minute;
  int second;

  if (!out || out_cap < 25) return -1;
  if (unit == 1) {
    seconds = value / 1000;
    milliseconds = (int)(value % 1000);
    if (milliseconds < 0) {
      milliseconds += 1000;
      --seconds;
    }
  } else if (unit != 0) {
    return -1;
  }

  days = cy_floor_div(seconds, 86400);
  remainder = seconds - days * 86400;
  cy_civil_from_days(days, &year, &month, &day);
  if (year < 0 || year > 9999) return -1;
  hour = (int)(remainder / 3600);
  minute = (int)((remainder % 3600) / 60);
  second = (int)(remainder % 60);

  cy_write_4(out + 0, year);
  out[4] = '-';
  cy_write_2(out + 5, month);
  out[7] = '-';
  cy_write_2(out + 8, day);
  out[10] = 'T';
  cy_write_2(out + 11, hour);
  out[13] = ':';
  cy_write_2(out + 14, minute);
  out[16] = ':';
  cy_write_2(out + 17, second);
  out[19] = '.';
  cy_write_3(out + 20, milliseconds);
  out[23] = 'Z';
  out[24] = '\0';
  return 24;
}

int cy_number_group(const char *input, size_t input_len,
                    char *out, size_t out_cap) {
  size_t start = 0;
  size_t end = input_len;
  char integer[256];
  char fraction[256];
  size_t integer_len = 0;
  size_t fraction_len = 0;
  size_t first_group;
  size_t source;
  size_t target = 0;
  char sign = '\0';
  int seen_dot = 0;
  int seen_digit = 0;

  if (!input || !out || out_cap == 0) return -1;
  while (start < input_len && cy_is_space((unsigned char)input[start])) ++start;
  while (end > start && cy_is_space((unsigned char)input[end - 1])) --end;
  if (start >= end) return -1;
  if (input[start] == '-' || input[start] == '+') {
    sign = input[start];
    ++start;
  }

  for (source = start; source < end; ++source) {
    const unsigned char ch = (unsigned char)input[source];
    if (ch == ',' || ch == '_' || cy_is_space(ch)) continue;
    if (ch == '.') {
      if (seen_dot) return -1;
      seen_dot = 1;
      continue;
    }
    if (!cy_is_digit(ch)) return -1;
    seen_digit = 1;
    if (seen_dot) {
      if (fraction_len + 1 >= sizeof(fraction)) return -1;
      fraction[fraction_len++] = (char)ch;
    } else {
      if (integer_len + 1 >= sizeof(integer)) return -1;
      integer[integer_len++] = (char)ch;
    }
  }
  if (!seen_digit) return -1;
  if (integer_len == 0) integer[integer_len++] = '0';
  first_group = integer_len % 3;
  if (first_group == 0) first_group = 3;

  if (sign) {
    if (target + 1 >= out_cap) return -1;
    out[target++] = sign;
  }
  for (source = 0; source < integer_len; ++source) {
    if (source > 0 &&
        (source == first_group ||
         (source > first_group && (source - first_group) % 3 == 0))) {
      if (target + 1 >= out_cap) return -1;
      out[target++] = ',';
    }
    if (target + 1 >= out_cap) return -1;
    out[target++] = integer[source];
  }
  if (fraction_len > 0) {
    if (target + 1 >= out_cap) return -1;
    out[target++] = '.';
    for (source = 0; source < fraction_len; ++source) {
      if (target + 1 >= out_cap) return -1;
      out[target++] = fraction[source];
    }
  }
  out[target] = '\0';
  return (int)target;
}
