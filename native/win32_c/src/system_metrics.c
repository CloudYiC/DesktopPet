#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <iphlpapi.h>

#include <stddef.h>

#include "cloudyi/system_metrics.h"

typedef LONG(WINAPI *cy_rtl_get_version_fn)(OSVERSIONINFOW *);
typedef UINT(WINAPI *cy_get_dpi_for_system_fn)(void);

static void cy_copy_wide(wchar_t *destination, size_t capacity,
                         const wchar_t *source) {
  size_t index;
  if (!destination || capacity == 0) return;
  destination[0] = L'\0';
  if (!source) return;
  for (index = 0; index + 1 < capacity && source[index] != L'\0'; ++index) {
    destination[index] = source[index];
  }
  destination[index] = L'\0';
}

static int cy_read_registry_string(HKEY root, const wchar_t *subkey,
                                   const wchar_t *value_name,
                                   wchar_t *destination, size_t capacity) {
  HKEY key;
  DWORD bytes;
  DWORD type;
  LONG status;
  if (!destination || capacity == 0) return 0;
  destination[0] = L'\0';
  status = RegOpenKeyExW(root, subkey, 0, KEY_READ | KEY_WOW64_64KEY, &key);
  if (status != ERROR_SUCCESS) {
    status = RegOpenKeyExW(root, subkey, 0, KEY_READ, &key);
  }
  if (status != ERROR_SUCCESS) return 0;
  bytes = (DWORD)(capacity * sizeof(wchar_t));
  type = 0;
  status = RegQueryValueExW(key, value_name, NULL, &type,
                            (LPBYTE)destination, &bytes);
  RegCloseKey(key);
  if (status != ERROR_SUCCESS ||
      (type != REG_SZ && type != REG_EXPAND_SZ && type != REG_MULTI_SZ)) {
    destination[0] = L'\0';
    return 0;
  }
  destination[capacity - 1] = L'\0';
  return 1;
}

static int cy_read_registry_dword(HKEY root, const wchar_t *subkey,
                                  const wchar_t *value_name,
                                  DWORD *value) {
  HKEY key;
  DWORD bytes;
  DWORD type;
  LONG status;
  if (!value) return 0;
  status = RegOpenKeyExW(root, subkey, 0, KEY_READ | KEY_WOW64_64KEY, &key);
  if (status != ERROR_SUCCESS) {
    status = RegOpenKeyExW(root, subkey, 0, KEY_READ, &key);
  }
  if (status != ERROR_SUCCESS) return 0;
  bytes = sizeof(*value);
  type = 0;
  status = RegQueryValueExW(key, value_name, NULL, &type,
                            (LPBYTE)value, &bytes);
  RegCloseKey(key);
  return status == ERROR_SUCCESS && type == REG_DWORD;
}

static uint32_t cy_count_processor_relationship(
    LOGICAL_PROCESSOR_RELATIONSHIP relationship) {
  DWORD bytes;
  unsigned char *buffer;
  DWORD offset;
  uint32_t count;
  bytes = 0;
  GetLogicalProcessorInformationEx(relationship, NULL, &bytes);
  if (bytes == 0 || GetLastError() != ERROR_INSUFFICIENT_BUFFER) return 0;
  buffer = (unsigned char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY,
                                      (SIZE_T)bytes);
  if (!buffer) return 0;
  if (!GetLogicalProcessorInformationEx(
          relationship,
          (PSYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX)buffer, &bytes)) {
    HeapFree(GetProcessHeap(), 0, buffer);
    return 0;
  }
  offset = 0;
  count = 0;
  while (offset < bytes) {
    PSYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX item =
        (PSYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX)(buffer + offset);
    if (item->Size == 0 || offset + item->Size > bytes) break;
    ++count;
    offset += item->Size;
  }
  HeapFree(GetProcessHeap(), 0, buffer);
  return count;
}

static void cy_query_primary_graphics(wchar_t *destination,
                                      size_t capacity) {
  DISPLAY_DEVICEW device;
  DWORD index;
  wchar_t fallback[256];
  fallback[0] = L'\0';
  for (index = 0;; ++index) {
    ZeroMemory(&device, sizeof(device));
    device.cb = sizeof(device);
    if (!EnumDisplayDevicesW(NULL, index, &device, 0)) break;
    if ((device.StateFlags & DISPLAY_DEVICE_ACTIVE) == 0 ||
        (device.StateFlags & DISPLAY_DEVICE_MIRRORING_DRIVER) != 0) {
      continue;
    }
    if (fallback[0] == L'\0') {
      cy_copy_wide(fallback, sizeof(fallback) / sizeof(fallback[0]),
                   device.DeviceString);
    }
    if ((device.StateFlags & DISPLAY_DEVICE_PRIMARY_DEVICE) != 0) {
      cy_copy_wide(destination, capacity, device.DeviceString);
      return;
    }
  }
  cy_copy_wide(destination, capacity, fallback);
}

static void cy_query_network(cy_system_metrics *metrics) {
  ULONG bytes;
  ULONG result;
  IP_ADAPTER_ADDRESSES *adapters;
  IP_ADAPTER_ADDRESSES *adapter;
  bytes = 16384;
  adapters = (IP_ADAPTER_ADDRESSES *)HeapAlloc(
      GetProcessHeap(), HEAP_ZERO_MEMORY, (SIZE_T)bytes);
  if (!adapters) return;
  result = GetAdaptersAddresses(
      AF_INET, GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST |
                   GAA_FLAG_SKIP_DNS_SERVER,
      NULL, adapters, &bytes);
  if (result == ERROR_BUFFER_OVERFLOW) {
    HeapFree(GetProcessHeap(), 0, adapters);
    adapters = (IP_ADAPTER_ADDRESSES *)HeapAlloc(
        GetProcessHeap(), HEAP_ZERO_MEMORY, (SIZE_T)bytes);
    if (!adapters) return;
    result = GetAdaptersAddresses(
        AF_INET, GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST |
                     GAA_FLAG_SKIP_DNS_SERVER,
        NULL, adapters, &bytes);
  }
  if (result != NO_ERROR) {
    HeapFree(GetProcessHeap(), 0, adapters);
    return;
  }
  for (adapter = adapters; adapter != NULL; adapter = adapter->Next) {
    IP_ADAPTER_UNICAST_ADDRESS *address;
    if (adapter->OperStatus != IfOperStatusUp ||
        adapter->IfType == IF_TYPE_SOFTWARE_LOOPBACK ||
        adapter->IfType == IF_TYPE_TUNNEL) {
      continue;
    }
    ++metrics->active_network_adapters;
    if (metrics->primary_ipv4[0] != L'\0') continue;
    for (address = adapter->FirstUnicastAddress; address != NULL;
         address = address->Next) {
      SOCKADDR *socket_address = address->Address.lpSockaddr;
      if (socket_address && socket_address->sa_family == AF_INET) {
        SOCKADDR_IN *ipv4 = (SOCKADDR_IN *)socket_address;
        if (InetNtopW(AF_INET, &ipv4->sin_addr, metrics->primary_ipv4,
                      (DWORD)(sizeof(metrics->primary_ipv4) /
                              sizeof(metrics->primary_ipv4[0])))) {
          cy_copy_wide(metrics->primary_network_adapter,
                       sizeof(metrics->primary_network_adapter) /
                           sizeof(metrics->primary_network_adapter[0]),
                       adapter->FriendlyName);
          break;
        }
      }
    }
  }
  HeapFree(GetProcessHeap(), 0, adapters);
}

int cy_query_system_metrics(cy_system_metrics *metrics) {
  SYSTEM_INFO system_info;
  MEMORYSTATUSEX memory_status;
  OSVERSIONINFOW version_info;
  ULARGE_INTEGER disk_free;
  ULARGE_INTEGER disk_total;
  ULARGE_INTEGER disk_available;
  SYSTEM_POWER_STATUS power_status;
  DYNAMIC_TIME_ZONE_INFORMATION time_zone;
  wchar_t windows_directory[MAX_PATH];
  wchar_t system_drive[4];
  DWORD computer_name_size;
  DWORD user_name_size;
  DWORD registry_value;
  HMODULE ntdll;
  HMODULE user32;
  cy_rtl_get_version_fn rtl_get_version;
  cy_get_dpi_for_system_fn get_dpi_for_system;

  if (!metrics) return 0;
  ZeroMemory(metrics, sizeof(*metrics));
  metrics->battery_percent = 255;
  metrics->ac_line_status = 255;

  ZeroMemory(&system_info, sizeof(system_info));
  GetNativeSystemInfo(&system_info);
  metrics->architecture = system_info.wProcessorArchitecture;
  metrics->logical_processors = system_info.dwNumberOfProcessors;
  metrics->physical_cores =
      cy_count_processor_relationship(RelationProcessorCore);
  metrics->processor_packages =
      cy_count_processor_relationship(RelationProcessorPackage);
  if (metrics->physical_cores == 0) {
    metrics->physical_cores = metrics->logical_processors;
  }
  if (metrics->processor_packages == 0 && metrics->logical_processors > 0) {
    metrics->processor_packages = 1;
  }
  metrics->uptime_milliseconds = GetTickCount64();
  metrics->virtualization_enabled =
      IsProcessorFeaturePresent(PF_VIRT_FIRMWARE_ENABLED) ? 1U : 0U;

  ZeroMemory(&memory_status, sizeof(memory_status));
  memory_status.dwLength = sizeof(memory_status);
  if (!GlobalMemoryStatusEx(&memory_status)) return 0;
  metrics->memory_load_percent = memory_status.dwMemoryLoad;
  metrics->total_memory_bytes = memory_status.ullTotalPhys;
  metrics->available_memory_bytes = memory_status.ullAvailPhys;
  metrics->total_page_file_bytes = memory_status.ullTotalPageFile;
  metrics->available_page_file_bytes = memory_status.ullAvailPageFile;

  if (GetWindowsDirectoryW(windows_directory, MAX_PATH) > 0) {
    system_drive[0] = windows_directory[0];
    system_drive[1] = L':';
    system_drive[2] = L'\\';
    system_drive[3] = L'\0';
    cy_copy_wide(metrics->system_drive,
                 sizeof(metrics->system_drive) /
                     sizeof(metrics->system_drive[0]),
                 system_drive);
    if (GetDiskFreeSpaceExW(windows_directory, &disk_available, &disk_total,
                            &disk_free)) {
      metrics->system_disk_total_bytes = disk_total.QuadPart;
      metrics->system_disk_free_bytes = disk_free.QuadPart;
    }
  }

  computer_name_size =
      (DWORD)(sizeof(metrics->computer_name) / sizeof(wchar_t));
  if (!GetComputerNameW(metrics->computer_name, &computer_name_size)) {
    metrics->computer_name[0] = L'\0';
  }
  user_name_size = (DWORD)(sizeof(metrics->user_name) / sizeof(wchar_t));
  if (!GetUserNameW(metrics->user_name, &user_name_size)) {
    metrics->user_name[0] = L'\0';
  }

  ZeroMemory(&version_info, sizeof(version_info));
  version_info.dwOSVersionInfoSize = sizeof(version_info);
  ntdll = GetModuleHandleW(L"ntdll.dll");
  rtl_get_version = ntdll
                        ? (cy_rtl_get_version_fn)GetProcAddress(
                              ntdll, "RtlGetVersion")
                        : NULL;
  if (rtl_get_version && rtl_get_version(&version_info) >= 0) {
    metrics->os_major = version_info.dwMajorVersion;
    metrics->os_minor = version_info.dwMinorVersion;
    metrics->os_build = version_info.dwBuildNumber;
  }

  cy_read_registry_string(
      HKEY_LOCAL_MACHINE,
      L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", L"ProductName",
      metrics->os_product_name,
      sizeof(metrics->os_product_name) /
          sizeof(metrics->os_product_name[0]));
  if (!cy_read_registry_string(
          HKEY_LOCAL_MACHINE,
          L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion",
          L"DisplayVersion", metrics->os_display_version,
          sizeof(metrics->os_display_version) /
              sizeof(metrics->os_display_version[0]))) {
    cy_read_registry_string(
        HKEY_LOCAL_MACHINE,
        L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", L"ReleaseId",
        metrics->os_display_version,
        sizeof(metrics->os_display_version) /
            sizeof(metrics->os_display_version[0]));
  }
  registry_value = 0;
  if (cy_read_registry_dword(
          HKEY_LOCAL_MACHINE,
          L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion",
          L"InstallDate", &registry_value)) {
    metrics->install_unix_seconds = registry_value;
  }
  cy_read_registry_string(
      HKEY_LOCAL_MACHINE,
      L"HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0",
      L"ProcessorNameString", metrics->processor_name,
      sizeof(metrics->processor_name) / sizeof(metrics->processor_name[0]));
  registry_value = 0;
  if (cy_read_registry_dword(
          HKEY_LOCAL_MACHINE,
          L"HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0",
          L"~MHz", &registry_value)) {
    metrics->processor_max_mhz = registry_value;
  }
  cy_read_registry_string(
      HKEY_LOCAL_MACHINE, L"HARDWARE\\DESCRIPTION\\System\\BIOS",
      L"SystemManufacturer", metrics->manufacturer,
      sizeof(metrics->manufacturer) / sizeof(metrics->manufacturer[0]));
  cy_read_registry_string(
      HKEY_LOCAL_MACHINE, L"HARDWARE\\DESCRIPTION\\System\\BIOS",
      L"SystemProductName", metrics->model,
      sizeof(metrics->model) / sizeof(metrics->model[0]));
  cy_read_registry_string(
      HKEY_LOCAL_MACHINE, L"HARDWARE\\DESCRIPTION\\System\\BIOS",
      L"BIOSVersion", metrics->bios_version,
      sizeof(metrics->bios_version) / sizeof(metrics->bios_version[0]));
  cy_read_registry_string(
      HKEY_LOCAL_MACHINE, L"HARDWARE\\DESCRIPTION\\System\\BIOS",
      L"BIOSReleaseDate", metrics->bios_date,
      sizeof(metrics->bios_date) / sizeof(metrics->bios_date[0]));

  metrics->primary_display_width = (uint32_t)GetSystemMetrics(SM_CXSCREEN);
  metrics->primary_display_height = (uint32_t)GetSystemMetrics(SM_CYSCREEN);
  metrics->primary_display_dpi = 96;
  user32 = GetModuleHandleW(L"user32.dll");
  get_dpi_for_system = user32
                           ? (cy_get_dpi_for_system_fn)GetProcAddress(
                                 user32, "GetDpiForSystem")
                           : NULL;
  if (get_dpi_for_system) {
    metrics->primary_display_dpi = get_dpi_for_system();
  }
  cy_query_primary_graphics(
      metrics->primary_graphics,
      sizeof(metrics->primary_graphics) /
          sizeof(metrics->primary_graphics[0]));

  if (GetDynamicTimeZoneInformation(&time_zone) != TIME_ZONE_ID_INVALID) {
    cy_copy_wide(metrics->time_zone,
                 sizeof(metrics->time_zone) / sizeof(metrics->time_zone[0]),
                 time_zone.StandardName[0] != L'\0' ? time_zone.StandardName
                                                    : time_zone.DaylightName);
  }
  GetUserDefaultLocaleName(
      metrics->locale_name,
      (int)(sizeof(metrics->locale_name) / sizeof(metrics->locale_name[0])));
  cy_query_network(metrics);

  ZeroMemory(&power_status, sizeof(power_status));
  if (GetSystemPowerStatus(&power_status)) {
    metrics->battery_percent = power_status.BatteryLifePercent;
    metrics->ac_line_status = power_status.ACLineStatus;
  }
  return 1;
}
