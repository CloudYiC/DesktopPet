/* Read-only Windows system metrics exposed through a C-compatible contract. */
#ifndef CLOUDYI_SYSTEM_METRICS_H
#define CLOUDYI_SYSTEM_METRICS_H

#include <stdint.h>
#include <wchar.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct cy_system_metrics {
  uint32_t os_major;
  uint32_t os_minor;
  uint32_t os_build;
  uint32_t architecture;
  uint32_t logical_processors;
  uint32_t physical_cores;
  uint32_t processor_packages;
  uint32_t processor_max_mhz;
  uint32_t memory_load_percent;
  uint32_t primary_display_width;
  uint32_t primary_display_height;
  uint32_t primary_display_dpi;
  uint32_t active_network_adapters;
  uint32_t battery_percent;
  uint32_t ac_line_status;
  uint32_t virtualization_enabled;
  uint64_t total_memory_bytes;
  uint64_t available_memory_bytes;
  uint64_t total_page_file_bytes;
  uint64_t available_page_file_bytes;
  uint64_t system_disk_total_bytes;
  uint64_t system_disk_free_bytes;
  uint64_t uptime_milliseconds;
  uint64_t install_unix_seconds;
  wchar_t computer_name[256];
  wchar_t user_name[256];
  wchar_t os_product_name[128];
  wchar_t os_display_version[64];
  wchar_t processor_name[256];
  wchar_t system_drive[16];
  wchar_t manufacturer[128];
  wchar_t model[128];
  wchar_t bios_version[128];
  wchar_t bios_date[64];
  wchar_t primary_graphics[256];
  wchar_t time_zone[128];
  wchar_t locale_name[96];
  wchar_t primary_network_adapter[256];
  wchar_t primary_ipv4[64];
} cy_system_metrics;

/* Returns 1 when the required metrics were read, otherwise 0. */
int cy_query_system_metrics(cy_system_metrics *metrics);

#ifdef __cplusplus
}
#endif

#endif /* CLOUDYI_SYSTEM_METRICS_H */
