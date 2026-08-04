#include "cloudyi/software_inventory.h"

#include <windows.h>
#include <strsafe.h>

#include <stddef.h>
#include <string.h>

static const wchar_t k_uninstall_path[] =
    L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall";

static void read_string_value(HKEY key, const wchar_t *name, wchar_t *output,
                              DWORD output_characters) {
  DWORD type = 0;
  DWORD bytes = output_characters * (DWORD)sizeof(wchar_t);
  if (output == NULL || output_characters == 0) return;
  output[0] = L'\0';
  if (RegQueryValueExW(key, name, NULL, &type, (LPBYTE)output, &bytes) !=
          ERROR_SUCCESS ||
      (type != REG_SZ && type != REG_EXPAND_SZ)) {
    output[0] = L'\0';
    return;
  }
  output[output_characters - 1] = L'\0';
  if (type == REG_EXPAND_SZ) {
    wchar_t expanded[2048];
    const DWORD expanded_length =
        ExpandEnvironmentStringsW(output, expanded, ARRAYSIZE(expanded));
    if (expanded_length > 0 && expanded_length <= ARRAYSIZE(expanded)) {
      StringCchCopyW(output, output_characters, expanded);
    }
  }
}

static DWORD read_dword_value(HKEY key, const wchar_t *name) {
  DWORD type = 0;
  DWORD value = 0;
  DWORD bytes = sizeof(value);
  if (RegQueryValueExW(key, name, NULL, &type, (LPBYTE)&value, &bytes) !=
          ERROR_SUCCESS ||
      type != REG_DWORD) {
    return 0;
  }
  return value;
}

static int enumerate_registry_view(HKEY root, const wchar_t *scope,
                                   REGSAM view, uint32_t base_flags,
                                   cy_software_callback callback,
                                   void *context) {
  HKEY uninstall_key = NULL;
  DWORD index = 0;
  LONG result = RegOpenKeyExW(root, k_uninstall_path, 0,
                              KEY_READ | view, &uninstall_key);
  if (result != ERROR_SUCCESS) return 1;

  for (;;) {
    wchar_t subkey_name[512];
    DWORD subkey_characters = ARRAYSIZE(subkey_name);
    HKEY application_key = NULL;
    cy_installed_software entry;
    result = RegEnumKeyExW(uninstall_key, index++, subkey_name,
                           &subkey_characters, NULL, NULL, NULL, NULL);
    if (result == ERROR_NO_MORE_ITEMS) break;
    if (result != ERROR_SUCCESS) continue;
    if (RegOpenKeyExW(uninstall_key, subkey_name, 0, KEY_READ | view,
                      &application_key) != ERROR_SUCCESS) {
      continue;
    }

    memset(&entry, 0, sizeof(entry));
    entry.flags = base_flags;
    read_string_value(application_key, L"DisplayName", entry.display_name,
                      ARRAYSIZE(entry.display_name));
    read_string_value(application_key, L"DisplayVersion",
                      entry.display_version, ARRAYSIZE(entry.display_version));
    read_string_value(application_key, L"Publisher", entry.publisher,
                      ARRAYSIZE(entry.publisher));
    read_string_value(application_key, L"InstallLocation",
                      entry.install_location,
                      ARRAYSIZE(entry.install_location));
    read_string_value(application_key, L"DisplayIcon", entry.display_icon,
                      ARRAYSIZE(entry.display_icon));
    read_string_value(application_key, L"UninstallString",
                      entry.uninstall_command,
                      ARRAYSIZE(entry.uninstall_command));
    read_string_value(application_key, L"QuietUninstallString",
                      entry.quiet_uninstall_command,
                      ARRAYSIZE(entry.quiet_uninstall_command));

    if (read_dword_value(application_key, L"SystemComponent") != 0)
      entry.flags |= CY_SOFTWARE_SYSTEM_COMPONENT;
    if (read_dword_value(application_key, L"NoRemove") != 0)
      entry.flags |= CY_SOFTWARE_NO_REMOVE;
    if (read_dword_value(application_key, L"WindowsInstaller") != 0)
      entry.flags |= CY_SOFTWARE_WINDOWS_INSTALLER;
    entry.estimated_size_bytes =
        (uint64_t)read_dword_value(application_key, L"EstimatedSize") * 1024u;
    StringCchPrintfW(entry.entry_id, ARRAYSIZE(entry.entry_id), L"%ls|%ls|%ls",
                     scope,
                     (base_flags & CY_SOFTWARE_64_BIT_VIEW) ? L"64" : L"32",
                     subkey_name);
    RegCloseKey(application_key);

    if (entry.display_name[0] == L'\0') continue;
    if (!callback(&entry, context)) {
      RegCloseKey(uninstall_key);
      return 0;
    }
  }
  RegCloseKey(uninstall_key);
  return 1;
}

int cy_enumerate_installed_software(cy_software_callback callback,
                                    void *context) {
  if (callback == NULL) return 0;
#if defined(_WIN64)
  if (!enumerate_registry_view(HKEY_CURRENT_USER, L"HKCU", KEY_WOW64_64KEY,
                               CY_SOFTWARE_CURRENT_USER |
                                   CY_SOFTWARE_64_BIT_VIEW,
                               callback, context))
    return 1;
  if (!enumerate_registry_view(HKEY_LOCAL_MACHINE, L"HKLM", KEY_WOW64_64KEY,
                               CY_SOFTWARE_64_BIT_VIEW, callback, context))
    return 1;
#endif
  if (!enumerate_registry_view(HKEY_CURRENT_USER, L"HKCU", KEY_WOW64_32KEY,
                               CY_SOFTWARE_CURRENT_USER, callback, context))
    return 1;
  if (!enumerate_registry_view(HKEY_LOCAL_MACHINE, L"HKLM", KEY_WOW64_32KEY,
                               0, callback, context))
    return 1;
  return 1;
}
