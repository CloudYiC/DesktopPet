#include "cloudyi/pet_behavior.h"

#include <limits.h>
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

static int test_tuck_thresholds(void) {
  const int values[] = {1, 2, 5, 10, 20, 30, 60};
  size_t index;
  for (index = 0; index < sizeof(values) / sizeof(values[0]); ++index) {
    const uint64_t threshold = (uint64_t)values[index] * UINT64_C(60000);
    CHECK(cloudyi_pet_should_tuck(1, 0, 0, 0, 0, values[index]) == 0);
    CHECK(cloudyi_pet_should_tuck(1, 0, 0, 0, threshold - 1, values[index]) == 0);
    CHECK(cloudyi_pet_should_tuck(1, 0, 0, 0, threshold, values[index]) == 1);
    CHECK(cloudyi_pet_should_tuck(1, 0, 0, 0, threshold + 1, values[index]) == 1);
  }
  /* Six minutes idle: short selections tuck, 10/20/30/60 minutes do not. */
  CHECK(cloudyi_pet_should_tuck(1, 0, 0, 0, UINT64_C(360000), 1) == 1);
  CHECK(cloudyi_pet_should_tuck(1, 0, 0, 0, UINT64_C(360000), 2) == 1);
  CHECK(cloudyi_pet_should_tuck(1, 0, 0, 0, UINT64_C(360000), 5) == 1);
  CHECK(cloudyi_pet_should_tuck(1, 0, 0, 0, UINT64_C(360000), 10) == 0);
  CHECK(cloudyi_pet_should_tuck(1, 0, 0, 0, UINT64_C(360000), 20) == 0);
  CHECK(cloudyi_pet_should_tuck(1, 0, 0, 0, UINT64_C(360000), 30) == 0);
  CHECK(cloudyi_pet_should_tuck(1, 0, 0, 0, UINT64_C(360000), 60) == 0);
  /* Validate before converting a possibly negative setting to unsigned, and
   * multiply at 64-bit width so large settings cannot wrap to a short delay. */
  CHECK(cloudyi_pet_should_tuck(1, 0, 0, 0, UINT64_MAX, 0) == 0);
  CHECK(cloudyi_pet_should_tuck(1, 0, 0, 0, UINT64_MAX, -1) == 0);
  CHECK(cloudyi_pet_should_tuck(1, 0, 0, 0, UINT64_MAX, INT_MIN) == 0);
  CHECK(cloudyi_pet_should_tuck(1, 0, 0, 0, (uint64_t)INT_MAX * UINT64_C(60000) - 1, INT_MAX) == 0);
  CHECK(cloudyi_pet_should_tuck(1, 0, 0, 0, (uint64_t)INT_MAX * UINT64_C(60000), INT_MAX) == 1);
  return 0;
}

static int test_tuck_state_guards(void) {
  int enabled, workspace, manual, presenting;
  for (enabled = 0; enabled <= 1; ++enabled) {
    for (workspace = 0; workspace <= 1; ++workspace) {
      for (manual = 0; manual <= 1; ++manual) {
        for (presenting = 0; presenting <= 1; ++presenting) {
          const int expected = enabled && !workspace && !manual && !presenting;
          CHECK(cloudyi_pet_should_tuck(enabled, workspace, manual, presenting,
                                       UINT64_MAX, 1) == expected);
        }
      }
    }
  }
  CHECK(cloudyi_pet_should_tuck(-1, 0, 0, 0, UINT64_C(60000), 1) == 1);
  CHECK(cloudyi_pet_should_tuck(1, 42, 0, 0, UINT64_MAX, 1) == 0);
  CHECK(cloudyi_pet_should_tuck(1, 0, -1, 0, UINT64_MAX, 1) == 0);
  CHECK(cloudyi_pet_should_tuck(1, 0, 0, 7, UINT64_MAX, 1) == 0);
  return 0;
}

int main(void) {
  if (test_visibility_truth_table() || test_workspace_transitions() ||
      test_tuck_thresholds() || test_tuck_state_guards()) {
    return 1;
  }
  puts("PASS pet behavior C policy: visibility truth table, repeated workspace transitions, manual hide/reminder override, configurable idle thresholds and tuck guards.");
  return 0;
}
