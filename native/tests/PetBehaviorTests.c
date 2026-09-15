#include "cloudyi/pet_behavior.h"

#include <string.h>
#include <math.h>
#include <stddef.h>
#include <stdio.h>

/* Do not use assert: these regressions must also execute in Release/NDEBUG. */
#define CHECK(condition) do { \
  if (!(condition)) { \
    fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #condition); \
    return 1; \
  } \
} while (0)

static int test_visibility_truth_table(void) {
  int workspace, manual, presenting;
  for (workspace = 0; workspace <= 1; ++workspace) {
    for (manual = 0; manual <= 1; ++manual) {
      for (presenting = 0; presenting <= 1; ++presenting) {
        const int expected = presenting ? 1 : (!workspace && !manual);
        CHECK(cloudyi_pet_should_show(workspace, manual, presenting) == expected);
      }
    }
  }
  CHECK(cloudyi_pet_should_show(42, 0, 0) == 0);
  CHECK(cloudyi_pet_should_show(0, -1, 0) == 0);
  CHECK(cloudyi_pet_should_show(42, -1, 7) == 1);
  return 0;
}

static int test_workspace_transitions(void) {
  int cycle;
  /* Repeated Show/open calls are idempotent. Closing or minimizing a workspace
   * must recompute visibility, not depend on a saved 'was visible' flag that a
   * second open call could overwrite. */
  for (cycle = 0; cycle < 64; ++cycle) {
    CHECK(cloudyi_pet_should_show(0, 0, 0) == 1); /* desktop */
    CHECK(cloudyi_pet_should_show(1, 0, 0) == 0); /* open */
    CHECK(cloudyi_pet_should_show(1, 0, 0) == 0); /* open again */
    CHECK(cloudyi_pet_should_show(0, 0, 0) == 1); /* minimize */
    CHECK(cloudyi_pet_should_show(1, 0, 0) == 0); /* restore */
    CHECK(cloudyi_pet_should_show(0, 0, 0) == 1); /* close */
  }
  /* A manual hide survives workspace transitions, but not a due reminder's
   * temporary presentation. Its original hidden preference resumes afterward. */
  CHECK(cloudyi_pet_should_show(0, 1, 0) == 0);
  CHECK(cloudyi_pet_should_show(1, 1, 0) == 0);
  CHECK(cloudyi_pet_should_show(0, 1, 0) == 0);
  CHECK(cloudyi_pet_should_show(0, 1, 1) == 1);
  CHECK(cloudyi_pet_should_show(1, 1, 1) == 1);
  CHECK(cloudyi_pet_should_show(1, 1, 0) == 0);
  CHECK(cloudyi_pet_should_show(0, 1, 0) == 0);
  CHECK(cloudyi_pet_should_show(0, 0, 0) == 1); /* explicitly show */
  /* A reminder remains visible while the workspace opens/closes/minimizes. */
  CHECK(cloudyi_pet_should_show(0, 0, 1) == 1);
  CHECK(cloudyi_pet_should_show(1, 0, 1) == 1);
  CHECK(cloudyi_pet_should_show(0, 0, 1) == 1);
  CHECK(cloudyi_pet_should_show(1, 0, 0) == 0);
  return 0;
}

static int test_shortcut_urls(void) {
  const char* valid[] = {"", "https://example.com", "HTTP://intranet:8080/path",
      "http://127.0.0.1:80", "https://finance.company.local/home?x=1&y=2#total",
      "http://[::1]:8080/study", "https://[2001:db8::2]/", "http://study_server",
      "https://example.com/%E4%B8%AD%E6%96%87?q=hello%20world"};
  const char* invalid[] = {"javascript:alert(1)", "file:///C:/Windows", "//example.com",
      "https://", "https:///foo", "https://user:pass@company", "https://user@company",
      "https://company\\@evil", "https://company/\" --flag", "https://company/\n",
      "https://company/%0a", "https://company/%00", "https://company/%22",
      "https://company/%", "https://company/%GG", "https://company:0",
      "https://company:65536", "https://company:abc", "https://company:",
      "https://company:80:90", "https://256.1.2.3", "https://1.2.3",
      "https://[::::]", "https://[::1]bad", "https://[1:2:3:4:5:6:7:8:9]",
      "https://company/|calc", "https://company/<>",
      "https://company /", "https://a..b", "https://-company", "https://company-",
      "https://co%6dpany", "https://company&calc.exe"};
  char boundary[2050];
  const char embedded_nul[] = "https://company/\0evil";
  size_t index;
  for (index = 0; index < sizeof(valid)/sizeof(valid[0]); ++index)
    CHECK(cloudyi_shortcut_url_is_valid(valid[index], strlen(valid[index])));
  for (index = 0; index < sizeof(invalid)/sizeof(invalid[0]); ++index)
    CHECK(!cloudyi_shortcut_url_is_valid(invalid[index], strlen(invalid[index])));
  CHECK(!cloudyi_shortcut_url_is_valid(NULL, 0));
  CHECK(!cloudyi_shortcut_url_is_valid(embedded_nul, sizeof(embedded_nul) - 1));
  memset(boundary, 'a', sizeof(boundary));
  memcpy(boundary, "https://company/", 16);
  CHECK(cloudyi_shortcut_url_is_valid(boundary, 2048));
  CHECK(!cloudyi_shortcut_url_is_valid(boundary, 2049));
  return 0;
}

static int test_menu_geometry(void) {
  const unsigned int dpis[] = {96, 120, 144, 192};
  size_t index;
  int single;
  for (index = 0; index < sizeof(dpis)/sizeof(dpis[0]); ++index) {
    const double scale = dpis[index] / 96.0;
    const int width = (int)(320 * scale), height = (int)(360 * scale);
    for (single = 0; single <= 1; ++single) {
      const int offsets[] = {0, 300, 650};
      size_t edge;
      for (edge = 0; edge < sizeof(offsets)/sizeof(offsets[0]); ++edge) {
        const cloudyi_pet_rect work = {-1920, -160, 0, 1400};
        const cloudyi_pet_rect rest = {-width, -160 + offsets[edge],
                                      0, -160 + offsets[edge] + height};
        const cloudyi_pet_menu_geometry result =
            cloudyi_pet_menu_bounds(rest, work, dpis[index], single);
        const int expected_top = rest.bottom - (int)((single ? 212 : 332) * scale + 0.5);
        CHECK(result.bounds.left == rest.left);
        CHECK(result.bounds.right - result.bounds.left == width);
        CHECK(result.bounds.top >= work.top && result.bounds.bottom <= work.bottom);
        CHECK(fabs(result.bounds.top + result.character_top_css * scale - expected_top) < 0.01);
      }
      {
        const cloudyi_pet_rect work = {0, 0, 1920, 1000};
        const cloudyi_pet_rect rest = {1920-width, 1000-height, 1920, 1000};
        const cloudyi_pet_menu_geometry result =
            cloudyi_pet_menu_bounds(rest, work, dpis[index], single);
        CHECK(result.above || result.side != 0);
        CHECK(result.bounds.bottom == rest.bottom);
        CHECK(result.bounds.top >= 0);
      }
    }
  }
  /* Common short/high-DPI work areas: use the ample horizontal space for the
   * sheet so the menu does not cover the visible character. */
  {
    const unsigned int short_dpis[] = {144, 192};
    size_t short_index;
    for (short_index = 0; short_index < 2; ++short_index) {
      const unsigned int dpi = short_dpis[short_index];
      const double scale = dpi / 96.0;
      const cloudyi_pet_rect work = {0, 0, short_index ? 1920 : 1366,
                                    short_index ? 1040 : 720};
      const int width = (int)(320 * scale), height = (int)(360 * scale);
      const cloudyi_pet_rect rest = {work.right-width, work.bottom-height,
                                     work.right, work.bottom};
      const cloudyi_pet_menu_geometry result = cloudyi_pet_menu_bounds(rest, work, dpi, 0);
      const double menu_left = result.character_left_css - 292 - 16;
      CHECK(result.side == -1);
      CHECK(menu_left >= 8);
      CHECK(menu_left + 292 < result.character_left_css);
      CHECK(result.bounds.left >= work.left && result.bounds.right <= work.right);
      CHECK(result.bounds.top >= work.top && result.bounds.bottom <= work.bottom);
      CHECK(fabs(result.bounds.left + result.character_left_css * scale -
          (rest.left + (width-(int)(255*scale+0.5))/2)) < 0.01);
    }
  }
  return 0;
}

static int test_dpi_menu_restore_anchor(void) {
  const unsigned int dpis[] = {96, 120, 144, 192};
  size_t old_index, new_index;
  int single;
  for (single = 0; single <= 1; ++single) {
    for (old_index = 0; old_index < 4; ++old_index) {
      for (new_index = 0; new_index < 4; ++new_index) {
        const double old_scale = dpis[old_index] / 96.0;
        const double new_scale = dpis[new_index] / 96.0;
        const cloudyi_pet_rect work = {-3840, -400, 0, 1760};
        const cloudyi_pet_rect resting = {-2000, 600,
            -2000 + (int)(320 * old_scale), 600 + (int)(360 * old_scale)};
        const cloudyi_pet_menu_geometry expanded =
            cloudyi_pet_menu_bounds(resting, work, dpis[old_index], single);
        const cloudyi_pet_rect restored = cloudyi_pet_rest_after_dpi(
            resting, work, dpis[old_index], dpis[new_index], single);
        const double old_x = (resting.left + resting.right) / 2.0;
        const double old_y = resting.bottom - (single ? 107 : 162) * old_scale;
        const double new_x = (restored.left + restored.right) / 2.0;
        const double new_y = restored.bottom - (single ? 107 : 162) * new_scale;
        CHECK(expanded.bounds.top != resting.top || expanded.bounds.left != resting.left ||
              expanded.bounds.bottom - expanded.bounds.top > resting.bottom - resting.top);
        CHECK(restored.right - restored.left == (int)(320 * new_scale));
        CHECK(restored.bottom - restored.top == (int)(360 * new_scale));
        CHECK(fabs(old_x - new_x) <= 0.5);
        CHECK(fabs(old_y - new_y) <= 0.5);
        CHECK(restored.left >= work.left && restored.right <= work.right);
        CHECK(restored.top >= work.top && restored.bottom <= work.bottom);
      }
    }
  }
  {
    const cloudyi_pet_rect work = {0, 0, 1920, 1040};
    const cloudyi_pet_rect resting = {1590, 640, 1910, 1000};
    const cloudyi_pet_rect bounded = cloudyi_pet_rest_after_dpi(resting, work, 96, 192, 1);
    CHECK(bounded.left == 1280 && bounded.right == 1920);
    CHECK(bounded.top == 320 && bounded.bottom == 1040);
  }
  {
    const cloudyi_pet_rect work = {0, 0, 2560, 1440};
    const cloudyi_pet_rect resting = {1000, 500, 1320, 860};
    const cloudyi_pet_rect single_result = cloudyi_pet_rest_after_dpi(resting, work, 96, 144, 1);
    const cloudyi_pet_rect sheet_result = cloudyi_pet_rest_after_dpi(resting, work, 96, 144, 0);
    CHECK(single_result.left == 920 && single_result.top == 374 && single_result.bottom == 914);
    CHECK(sheet_result.left == 920 && sheet_result.top == 401 && sheet_result.bottom == 941);
  }
  return 0;
}

int main(void) {
  if (test_visibility_truth_table() || test_workspace_transitions() ||
      test_shortcut_urls() || test_menu_geometry() || test_dpi_menu_restore_anchor()) return 1;
  puts("PASS pet behavior: visibility/manual hide/reminders, HTTP(S) shortcut boundaries, DPI menu positioning.");
  return 0;
}
