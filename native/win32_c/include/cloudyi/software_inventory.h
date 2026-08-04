/* Installed-software registry inventory exposed through a C-compatible API. */
#ifndef CLOUDYI_SOFTWARE_INVENTORY_H
#define CLOUDYI_SOFTWARE_INVENTORY_H

#include <stdint.h>
#include <wchar.h>

#ifdef __cplusplus
extern "C" {
#endif

enum cy_software_flags {
  CY_SOFTWARE_CURRENT_USER = 1u << 0,
  CY_SOFTWARE_SYSTEM_COMPONENT = 1u << 1,
  CY_SOFTWARE_NO_REMOVE = 1u << 2,
  CY_SOFTWARE_64_BIT_VIEW = 1u << 3,
  CY_SOFTWARE_WINDOWS_INSTALLER = 1u << 4
};

typedef struct cy_installed_software {
  wchar_t entry_id[768];
  wchar_t display_name[384];
  wchar_t display_version[192];
  wchar_t publisher[256];
  wchar_t install_location[1024];
  wchar_t display_icon[2048];
  wchar_t uninstall_command[2048];
  wchar_t quiet_uninstall_command[2048];
  uint64_t estimated_size_bytes;
  uint32_t flags;
} cy_installed_software;

typedef int (*cy_software_callback)(const cy_installed_software *entry,
                                    void *context);

/*
 * Enumerates HKCU/HKLM uninstall records in both registry views. The callback
 * may return 0 to stop enumeration early. Returns 1 on a completed scan.
 */
int cy_enumerate_installed_software(cy_software_callback callback,
                                    void *context);

#ifdef __cplusplus
}
#endif

#endif /* CLOUDYI_SOFTWARE_INVENTORY_H */
