#ifndef CLOUDYI_ICON_FILE_H
#define CLOUDYI_ICON_FILE_H

#include <stddef.h>
#include <wchar.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Writes a Windows ICO containing one 256 × 256 PNG frame.
 *
 * The caller supplies an already validated PNG. Returning zero means the file
 * could not be created or fully written.
 */
int cy_write_png_icon(const wchar_t *path, const unsigned char *png,
                      size_t png_size);

#ifdef __cplusplus
}
#endif

#endif
