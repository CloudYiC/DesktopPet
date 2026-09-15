#ifndef CLOUDYI_PET_BEHAVIOR_H
#define CLOUDYI_PET_BEHAVIOR_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Stateless pet visibility policy. workspace_on_desktop means the workspace is
 * visible and not minimized. A reminder presentation temporarily overrides both
 * workspace visibility and an explicit manual hide; neither state is changed. */
int cloudyi_pet_should_show(int workspace_on_desktop, int manually_hidden,
                           int presenting);

/* Empty clears a shortcut. Nonempty values must be bounded HTTP(S) URLs. */
int cloudyi_shortcut_url_is_valid(const char* url, size_t length);

typedef struct cloudyi_pet_rect { int left, top, right, bottom; } cloudyi_pet_rect;
typedef struct cloudyi_pet_menu_geometry {
  cloudyi_pet_rect bounds;
  double character_left_css;
  double character_top_css;
  int above;
  int side; /* 0 vertical, -1 menu on left, +1 menu on right */
} cloudyi_pet_menu_geometry;

/* Grow the transparent host without moving the character. Bounds are physical
 * pixels; the resulting character offset is in CSS pixels. */
cloudyi_pet_menu_geometry cloudyi_pet_menu_bounds(
    cloudyi_pet_rect resting, cloudyi_pet_rect work, unsigned int dpi, int single);

/* Close an expanded menu on a DPI change using the resting character's screen
 * center, never the expanded popup's suggested top-left. */
cloudyi_pet_rect cloudyi_pet_rest_after_dpi(cloudyi_pet_rect resting,
    cloudyi_pet_rect work, unsigned int old_dpi, unsigned int new_dpi, int single);

#ifdef __cplusplus
}
#endif

#endif
