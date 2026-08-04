/* Native file pickers kept behind a small C-compatible Win32 contract. */
#ifndef CLOUDYI_FILE_DIALOG_H
#define CLOUDYI_FILE_DIALOG_H

#include <stddef.h>
#include <wchar.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Opens a SQLite open/save dialog. Returns 1 for a selected path, 0 when the
 * user cancels and -1 for an API failure. `create_new` selects save mode.
 */
int cy_pick_sqlite_database(void *owner_window, int create_new,
                            wchar_t *destination, size_t capacity);

/* Opens a format-specific image save dialog with overwrite confirmation. */
int cy_pick_image_destination(void *owner_window, const wchar_t *format,
                              const wchar_t *suggested_name,
                              wchar_t *destination, size_t capacity);

#ifdef __cplusplus
}
#endif

#endif /* CLOUDYI_FILE_DIALOG_H */
