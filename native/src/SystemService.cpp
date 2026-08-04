#include "Milo/SystemService.h"

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <iphlpapi.h>

#include <algorithm>
#include <cctype>
#include <stdexcept>
#include <vector>

#include "Milo/Utils.h"
#include "cloudyi/system_metrics.h"

namespace milo {
namespace {

class ScopedHandle final {
 public:
  explicit ScopedHandle(HANDLE value) : value_(value) {}
  ~ScopedHandle() {
    if (value_ && value_ != INVALID_HANDLE_VALUE) CloseHandle(value_);
  }
  HANDLE get() const { return value_; }
  bool valid() const { return value_ && value_ != INVALID_HANDLE_VALUE; }

 private:
  HANDLE value_{};
};

std::string ArchitectureName(std::uint32_t architecture) {
  switch (architecture) {
    case PROCESSOR_ARCHITECTURE_AMD64: return "x64";
    case PROCESSOR_ARCHITECTURE_ARM64: return "ARM64";
    case PROCESSOR_ARCHITECTURE_INTEL: return "x86";
    default: return "未知";
  }
}

std::string ProcessName(std::uint32_t processId) {
  if (processId == 0) return "System Idle";
  if (processId == 4) return "System";
  ScopedHandle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE,
                                   processId));
  if (!process.valid()) return "PID " + std::to_string(processId);
  std::vector<wchar_t> path(32768U);
  DWORD pathLength = static_cast<DWORD>(path.size());
  if (!QueryFullProcessImageNameW(process.get(), 0, path.data(), &pathLength)) {
    return "PID " + std::to_string(processId);
  }
  std::wstring name(path.data(), pathLength);
  const std::wstring::size_type separator = name.find_last_of(L"\\/");
  if (separator != std::wstring::npos) name.erase(0, separator + 1);
  try {
    return WideToUtf8(name);
  } catch (...) {
    return "PID " + std::to_string(processId);
  }
}

std::string Ipv4Address(DWORD networkAddress, bool wildcardAsStar) {
  IN_ADDR address{};
  address.S_un.S_addr = networkAddress;
  char text[INET_ADDRSTRLEN] = {};
  if (!InetNtopA(AF_INET, &address, text, sizeof(text))) return "?";
  if (wildcardAsStar && networkAddress == 0) return "*";
  return text;
}

std::string TcpState(DWORD state) {
  switch (state) {
    case MIB_TCP_STATE_CLOSED: return "已关闭";
    case MIB_TCP_STATE_LISTEN: return "监听";
    case MIB_TCP_STATE_SYN_SENT: return "正在连接";
    case MIB_TCP_STATE_SYN_RCVD: return "正在握手";
    case MIB_TCP_STATE_ESTAB: return "已连接";
    case MIB_TCP_STATE_FIN_WAIT1:
    case MIB_TCP_STATE_FIN_WAIT2: return "正在关闭";
    case MIB_TCP_STATE_CLOSE_WAIT: return "等待关闭";
    case MIB_TCP_STATE_CLOSING: return "关闭中";
    case MIB_TCP_STATE_LAST_ACK: return "最后确认";
    case MIB_TCP_STATE_TIME_WAIT: return "等待释放";
    case MIB_TCP_STATE_DELETE_TCB: return "删除中";
    default: return "未知";
  }
}

void AppendTcpEntries(std::vector<PortEntry>* entries) {
  DWORD bytes = 0;
  GetExtendedTcpTable(nullptr, &bytes, FALSE, AF_INET,
                      TCP_TABLE_OWNER_PID_ALL, 0);
  if (bytes == 0) return;
  std::vector<unsigned char> buffer(bytes);
  if (GetExtendedTcpTable(buffer.data(), &bytes, FALSE, AF_INET,
                          TCP_TABLE_OWNER_PID_ALL, 0) != NO_ERROR) {
    return;
  }
  const MIB_TCPTABLE_OWNER_PID* table =
      reinterpret_cast<const MIB_TCPTABLE_OWNER_PID*>(buffer.data());
  for (DWORD index = 0; index < table->dwNumEntries; ++index) {
    const MIB_TCPROW_OWNER_PID& row = table->table[index];
    PortEntry entry;
    entry.protocol = "TCP";
    entry.localAddress = Ipv4Address(row.dwLocalAddr, true);
    entry.localPort = ntohs(static_cast<u_short>(row.dwLocalPort));
    entry.remoteAddress = Ipv4Address(row.dwRemoteAddr, true);
    entry.remotePort = ntohs(static_cast<u_short>(row.dwRemotePort));
    entry.state = TcpState(row.dwState);
    entry.processId = row.dwOwningPid;
    entry.processName = ProcessName(entry.processId);
    entries->push_back(entry);
  }
}

void AppendUdpEntries(std::vector<PortEntry>* entries) {
  DWORD bytes = 0;
  GetExtendedUdpTable(nullptr, &bytes, FALSE, AF_INET,
                      UDP_TABLE_OWNER_PID, 0);
  if (bytes == 0) return;
  std::vector<unsigned char> buffer(bytes);
  if (GetExtendedUdpTable(buffer.data(), &bytes, FALSE, AF_INET,
                          UDP_TABLE_OWNER_PID, 0) != NO_ERROR) {
    return;
  }
  const MIB_UDPTABLE_OWNER_PID* table =
      reinterpret_cast<const MIB_UDPTABLE_OWNER_PID*>(buffer.data());
  for (DWORD index = 0; index < table->dwNumEntries; ++index) {
    const MIB_UDPROW_OWNER_PID& row = table->table[index];
    PortEntry entry;
    entry.protocol = "UDP";
    entry.localAddress = Ipv4Address(row.dwLocalAddr, true);
    entry.localPort = ntohs(static_cast<u_short>(row.dwLocalPort));
    entry.remoteAddress = "—";
    entry.remotePort = 0;
    entry.state = "监听";
    entry.processId = row.dwOwningPid;
    entry.processName = ProcessName(entry.processId);
    entries->push_back(entry);
  }
}

std::string LowerAscii(std::string value) {
  for (std::string::size_type index = 0; index < value.size(); ++index) {
    value[index] = static_cast<char>(
        std::tolower(static_cast<unsigned char>(value[index])));
  }
  return value;
}

bool IsProtectedProcessName(const std::string& processName) {
  const std::string name = LowerAscii(processName);
  static const char* protectedNames[] = {
      "system", "registry", "smss.exe", "csrss.exe", "wininit.exe",
      "services.exe", "lsass.exe", "winlogon.exe", "svchost.exe",
      "fontdrvhost.exe", "dwm.exe"};
  for (std::size_t index = 0;
       index < sizeof(protectedNames) / sizeof(protectedNames[0]); ++index) {
    if (name == protectedNames[index]) return true;
  }
  return false;
}

bool OwnsVisiblePort(std::uint32_t processId, const std::string& processName) {
  const std::vector<PortEntry> entries = ListPortEntries();
  for (std::vector<PortEntry>::const_iterator entry = entries.begin();
       entry != entries.end(); ++entry) {
    if (entry->processId == processId &&
        LowerAscii(entry->processName) == LowerAscii(processName)) {
      return true;
    }
  }
  return false;
}

}  // namespace

SystemSnapshot QuerySystemSnapshot() {
  cy_system_metrics metrics{};
  if (!cy_query_system_metrics(&metrics)) {
    throw std::runtime_error("无法读取 Windows 系统信息。");
  }
  SystemSnapshot snapshot;
  const char* family = metrics.os_build >= 22000 ? "Windows 11" : "Windows 10";
  snapshot.operatingSystem = family;
  snapshot.osEdition = WideToUtf8(metrics.os_product_name);
  if (metrics.os_build >= 22000 &&
      snapshot.osEdition.find("Windows 10") != std::string::npos) {
    snapshot.osEdition.replace(snapshot.osEdition.find("Windows 10"), 10,
                               "Windows 11");
  }
  snapshot.osDisplayVersion = WideToUtf8(metrics.os_display_version);
  snapshot.architecture = ArchitectureName(metrics.architecture);
  snapshot.computerName = WideToUtf8(metrics.computer_name);
  snapshot.userName = WideToUtf8(metrics.user_name);
  snapshot.processorName = WideToUtf8(metrics.processor_name);
  snapshot.systemDrive = WideToUtf8(metrics.system_drive);
  snapshot.manufacturer = WideToUtf8(metrics.manufacturer);
  snapshot.model = WideToUtf8(metrics.model);
  snapshot.biosVersion = WideToUtf8(metrics.bios_version);
  snapshot.biosDate = WideToUtf8(metrics.bios_date);
  snapshot.primaryGraphics = WideToUtf8(metrics.primary_graphics);
  snapshot.timeZone = WideToUtf8(metrics.time_zone);
  snapshot.localeName = WideToUtf8(metrics.locale_name);
  snapshot.primaryNetworkAdapter =
      WideToUtf8(metrics.primary_network_adapter);
  snapshot.primaryIpv4 = WideToUtf8(metrics.primary_ipv4);
  snapshot.osBuild = metrics.os_build;
  snapshot.logicalProcessors = metrics.logical_processors;
  snapshot.physicalCores = metrics.physical_cores;
  snapshot.processorPackages = metrics.processor_packages;
  snapshot.processorMaxMegahertz = metrics.processor_max_mhz;
  snapshot.memoryLoadPercent = metrics.memory_load_percent;
  snapshot.primaryDisplayWidth = metrics.primary_display_width;
  snapshot.primaryDisplayHeight = metrics.primary_display_height;
  snapshot.primaryDisplayDpi = metrics.primary_display_dpi;
  snapshot.activeNetworkAdapters = metrics.active_network_adapters;
  snapshot.batteryPercent = metrics.battery_percent;
  snapshot.acLineStatus = metrics.ac_line_status;
  snapshot.virtualizationEnabled = metrics.virtualization_enabled != 0;
  snapshot.totalMemoryBytes = metrics.total_memory_bytes;
  snapshot.availableMemoryBytes = metrics.available_memory_bytes;
  snapshot.totalPageFileBytes = metrics.total_page_file_bytes;
  snapshot.availablePageFileBytes = metrics.available_page_file_bytes;
  snapshot.systemDiskTotalBytes = metrics.system_disk_total_bytes;
  snapshot.systemDiskFreeBytes = metrics.system_disk_free_bytes;
  snapshot.uptimeMilliseconds = metrics.uptime_milliseconds;
  snapshot.installUnixSeconds = metrics.install_unix_seconds;
  return snapshot;
}

std::vector<PortEntry> ListPortEntries() {
  std::vector<PortEntry> entries;
  AppendTcpEntries(&entries);
  AppendUdpEntries(&entries);
  std::sort(entries.begin(), entries.end(),
            [](const PortEntry& left, const PortEntry& right) {
              if (left.localPort != right.localPort) {
                return left.localPort < right.localPort;
              }
              if (left.protocol != right.protocol) {
                return left.protocol < right.protocol;
              }
              return left.processId < right.processId;
            });
  return entries;
}

ProcessOperationResult TerminatePortOwner(std::uint32_t processId,
                                          const std::string& expectedName) {
  ProcessOperationResult result;
  if (processId <= 4 || processId == GetCurrentProcessId() ||
      expectedName.empty() || expectedName.size() > 260U ||
      IsProtectedProcessName(expectedName)) {
    result.message = "为保护系统稳定性，不能结束这个进程。";
    return result;
  }
  if (!OwnsVisiblePort(processId, expectedName)) {
    result.message = "端口归属已经变化，请刷新列表后重试。";
    return result;
  }

  ScopedHandle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION |
                                       PROCESS_TERMINATE,
                                   FALSE, processId));
  if (!process.valid()) {
    result.message = "无法打开目标进程，可能需要管理员权限。";
    return result;
  }

  typedef BOOL(WINAPI *is_process_critical_fn)(HANDLE, PBOOL);
  const HMODULE kernel = GetModuleHandleW(L"kernel32.dll");
  const is_process_critical_fn isCritical =
      kernel ? reinterpret_cast<is_process_critical_fn>(
                   GetProcAddress(kernel, "IsProcessCritical"))
             : nullptr;
  BOOL critical = FALSE;
  if (isCritical && isCritical(process.get(), &critical) && critical) {
    result.message = "Windows 将该进程标记为关键进程，操作已拒绝。";
    return result;
  }
  if (!TerminateProcess(process.get(), 1)) {
    result.message = "结束进程失败，可能需要管理员权限。";
    return result;
  }
  result.succeeded = true;
  result.message = "进程已结束，端口列表正在刷新。";
  return result;
}

}  // namespace milo
