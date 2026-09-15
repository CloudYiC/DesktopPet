#ifndef CLOUDYI_PET_BEHAVIOR_H
#define CLOUDYI_PET_BEHAVIOR_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Stateless pet visibility policy. workspace_on_desktop means the workspace is
 * visible and not minimized. A reminder presentation temporarily overrides both
 * workspace visibility and an explicit manual hide; neither state is changed. */
int cloudyi_pet_should_show(int workspace_on_desktop, int manually_hidden,
                           int presenting);

/* idle_ms is the elapsed time since the last relevant interaction, not an
 * absolute tick count. Only an ordinary visible pet can tuck at its configured
 * idle threshold. Nonpositive minute values disable tucking defensively. */
int cloudyi_pet_should_tuck(int enabled, int workspace_on_desktop,
                           int manually_hidden, int presenting,
                           uint64_t idle_ms, int minutes);

#ifdef __cplusplus
}
#endif

#endif
