#include "store_tools.h"

static const char CY_HEX[] = "0123456789abcdef";

static void cy_copy(char *dst, const char *src, size_t len) {
  for (size_t i = 0; i < len; ++i) dst[i] = src[i];
}

static int cy_is_space(unsigned char ch) {
  return ch == ' ' || ch == '\n' || ch == '\r' || ch == '\t' || ch == '\f' || ch == '\v';
}

static int cy_is_digit(unsigned char ch) {
  return ch >= '0' && ch <= '9';
}

static int write_uuid(const unsigned char bytes[16], char *out, size_t out_cap) {
  if (!out || out_cap < 37) return -1;
  int j = 0;
  for (int i = 0; i < 16; ++i) {
    if (i == 4 || i == 6 || i == 8 || i == 10) out[j++] = '-';
    out[j++] = CY_HEX[(bytes[i] >> 4) & 0x0f];
    out[j++] = CY_HEX[bytes[i] & 0x0f];
  }
  out[j] = '\0';
  return j;
}

int cy_uuid_v4(const unsigned char random16[16], char *out, size_t out_cap) {
  if (!random16) return -1;
  unsigned char b[16];
  for (int i = 0; i < 16; ++i) b[i] = random16[i];
  b[6] = (unsigned char)((b[6] & 0x0f) | 0x40);
  b[8] = (unsigned char)((b[8] & 0x3f) | 0x80);
  return write_uuid(b, out, out_cap);
}

int cy_uuid_v7(uint64_t unix_ms, const unsigned char random10[10], char *out, size_t out_cap) {
  if (!random10) return -1;
  unsigned char b[16];
  b[0] = (unsigned char)((unix_ms >> 40) & 0xff);
  b[1] = (unsigned char)((unix_ms >> 32) & 0xff);
  b[2] = (unsigned char)((unix_ms >> 24) & 0xff);
  b[3] = (unsigned char)((unix_ms >> 16) & 0xff);
  b[4] = (unsigned char)((unix_ms >> 8) & 0xff);
  b[5] = (unsigned char)(unix_ms & 0xff);
  b[6] = (unsigned char)(0x70 | (random10[0] & 0x0f));
  b[7] = random10[1];
  b[8] = (unsigned char)(0x80 | (random10[2] & 0x3f));
  b[9] = random10[3];
  b[10] = random10[4];
  b[11] = random10[5];
  b[12] = random10[6];
  b[13] = random10[7];
  b[14] = random10[8];
  b[15] = random10[9];
  return write_uuid(b, out, out_cap);
}

int cy_password_generate(
  const unsigned char *random_bytes,
  size_t random_len,
  int length,
  int use_lower,
  int use_upper,
  int use_digits,
  int use_symbols,
  char *out,
  size_t out_cap
) {
  static const char LOWER[] = "abcdefghijklmnopqrstuvwxyz";
  static const char UPPER[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  static const char DIGITS[] = "0123456789";
  static const char SYMBOLS[] = "!@#$%^&*()-_=+[]{};:,.?/";

  if (!random_bytes || !out || length <= 0 || out_cap < (size_t)length + 1) return -1;

  char charset[128];
  size_t charset_len = 0;
  if (use_lower) {
    cy_copy(charset + charset_len, LOWER, sizeof(LOWER) - 1);
    charset_len += sizeof(LOWER) - 1;
  }
  if (use_upper) {
    cy_copy(charset + charset_len, UPPER, sizeof(UPPER) - 1);
    charset_len += sizeof(UPPER) - 1;
  }
  if (use_digits) {
    cy_copy(charset + charset_len, DIGITS, sizeof(DIGITS) - 1);
    charset_len += sizeof(DIGITS) - 1;
  }
  if (use_symbols) {
    cy_copy(charset + charset_len, SYMBOLS, sizeof(SYMBOLS) - 1);
    charset_len += sizeof(SYMBOLS) - 1;
  }
  if (charset_len == 0 || random_len < (size_t)length) return -1;

  for (int i = 0; i < length; ++i) {
    out[i] = charset[random_bytes[i] % charset_len];
  }
  out[length] = '\0';
  return length;
}

static int64_t floor_div(int64_t a, int64_t b) {
  int64_t q = a / b;
  int64_t r = a % b;
  return (r != 0 && ((r < 0) != (b < 0))) ? q - 1 : q;
}

static void civil_from_days(int64_t z, int *year, int *month, int *day) {
  z += 719468;
  int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  unsigned doe = (unsigned)(z - era * 146097);
  unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  int y = (int)yoe + (int)era * 400;
  unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  unsigned mp = (5 * doy + 2) / 153;
  unsigned d = doy - (153 * mp + 2) / 5 + 1;
  unsigned m = mp < 10 ? mp + 3 : mp - 9;
  y += m <= 2;

  *year = y;
  *month = (int)m;
  *day = (int)d;
}

static void write_2(char *out, int value) {
  out[0] = (char)('0' + ((value / 10) % 10));
  out[1] = (char)('0' + (value % 10));
}

static void write_3(char *out, int value) {
  out[0] = (char)('0' + ((value / 100) % 10));
  out[1] = (char)('0' + ((value / 10) % 10));
  out[2] = (char)('0' + (value % 10));
}

static void write_4(char *out, int value) {
  out[0] = (char)('0' + ((value / 1000) % 10));
  out[1] = (char)('0' + ((value / 100) % 10));
  out[2] = (char)('0' + ((value / 10) % 10));
  out[3] = (char)('0' + (value % 10));
}

int cy_timestamp_to_iso(int64_t value, int unit, char *out, size_t out_cap) {
  if (!out || out_cap < 25) return -1;

  int64_t seconds = value;
  int millis = 0;
  if (unit == 1) {
    seconds = value / 1000;
    millis = (int)(value % 1000);
    if (millis < 0) {
      millis += 1000;
      seconds -= 1;
    }
  } else if (unit != 0) {
    return -1;
  }

  int64_t days = floor_div(seconds, 86400);
  int64_t rem = seconds - days * 86400;
  int year = 0;
  int month = 0;
  int day = 0;
  civil_from_days(days, &year, &month, &day);
  if (year < 0 || year > 9999) return -1;

  int hour = (int)(rem / 3600);
  int minute = (int)((rem % 3600) / 60);
  int second = (int)(rem % 60);

  write_4(out + 0, year);
  out[4] = '-';
  write_2(out + 5, month);
  out[7] = '-';
  write_2(out + 8, day);
  out[10] = 'T';
  write_2(out + 11, hour);
  out[13] = ':';
  write_2(out + 14, minute);
  out[16] = ':';
  write_2(out + 17, second);
  out[19] = '.';
  write_3(out + 20, millis);
  out[23] = 'Z';
  out[24] = '\0';
  return 24;
}

int cy_number_group(const char *input, size_t input_len, char *out, size_t out_cap) {
  if (!input || !out || out_cap == 0) return -1;

  size_t start = 0;
  while (start < input_len && cy_is_space((unsigned char)input[start])) start++;
  size_t end = input_len;
  while (end > start && cy_is_space((unsigned char)input[end - 1])) end--;
  if (start >= end) return -1;

  int negative = 0;
  if (input[start] == '-' || input[start] == '+') {
    negative = input[start] == '-';
    start++;
  }

  char integer[256];
  char fraction[256];
  size_t int_len = 0;
  size_t frac_len = 0;
  int seen_dot = 0;
  int seen_digit = 0;

  for (size_t i = start; i < end; ++i) {
    unsigned char ch = (unsigned char)input[i];
    if (ch == ',' || ch == '_' || cy_is_space(ch)) continue;
    if (ch == '.') {
      if (seen_dot) return -1;
      seen_dot = 1;
      continue;
    }
    if (!cy_is_digit(ch)) return -1;
    seen_digit = 1;
    if (seen_dot) {
      if (frac_len + 1 >= sizeof(fraction)) return -1;
      fraction[frac_len++] = (char)ch;
    } else {
      if (int_len + 1 >= sizeof(integer)) return -1;
      integer[int_len++] = (char)ch;
    }
  }
  if (!seen_digit) return -1;
  if (int_len == 0) integer[int_len++] = '0';

  size_t first_group = int_len % 3;
  if (first_group == 0) first_group = 3;

  size_t j = 0;
  if (negative) {
    if (j + 1 >= out_cap) return -1;
    out[j++] = '-';
  }
  for (size_t i = 0; i < int_len; ++i) {
    if (i > 0 && (i == first_group || (i > first_group && (i - first_group) % 3 == 0))) {
      if (j + 1 >= out_cap) return -1;
      out[j++] = ',';
    }
    if (j + 1 >= out_cap) return -1;
    out[j++] = integer[i];
  }
  if (frac_len > 0) {
    if (j + 1 >= out_cap) return -1;
    out[j++] = '.';
    for (size_t i = 0; i < frac_len; ++i) {
      if (j + 1 >= out_cap) return -1;
      out[j++] = fraction[i];
    }
  }
  out[j] = '\0';
  return (int)j;
}
