#include "cloudyi/pet_behavior.h"

int cloudyi_pet_should_show(int workspace_on_desktop, int manually_hidden,
                           int presenting) {
  return presenting || (!workspace_on_desktop && !manually_hidden);
}

int cloudyi_pet_should_tuck(int enabled, int workspace_on_desktop,
                           int manually_hidden, int presenting,
                           uint64_t idle_ms, int minutes) {
  uint64_t threshold_ms;
  if (!enabled || workspace_on_desktop || manually_hidden || presenting ||
      minutes <= 0) {
    return 0;
  }
  threshold_ms = (uint64_t)minutes * UINT64_C(60000);
  return idle_ms >= threshold_ms;
}
