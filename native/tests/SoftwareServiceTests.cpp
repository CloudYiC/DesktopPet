#include "Milo/SoftwareService.h"
#include "Milo/SoftwareServiceTestAccess.h"
#include "Milo/Utils.h"
#include <windows.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <winioctl.h>
#include <aclapi.h>
#include <algorithm>
#include <iostream>
#include <stdexcept>
#include <vector>

namespace {
void Expect(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
void Directory(const std::wstring& path) { Expect(CreateDirectoryW(path.c_str(), nullptr) || GetLastError() == ERROR_ALREADY_EXISTS, "fixture directory"); }
void File(const std::wstring& path) {
  HANDLE handle = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  Expect(handle != INVALID_HANDLE_VALUE, "fixture file");
  const char bytes[] = "local fixture, not an executable"; DWORD count = 0;
  const BOOL okay = WriteFile(handle, bytes, sizeof(bytes), &count, nullptr); CloseHandle(handle);
  Expect(okay && count == sizeof(bytes), "fixture bytes");
}
void Link(const std::wstring& path, const std::wstring& target) {
  IShellLinkW* link = nullptr; IPersistFile* persist = nullptr;
  Expect(SUCCEEDED(CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&link))), "fixture link");
  HRESULT result = link->SetPath(target.c_str());
  if (SUCCEEDED(result)) result = link->QueryInterface(IID_PPV_ARGS(&persist));
  if (SUCCEEDED(result)) result = persist->Save(path.c_str(), TRUE);
  if (persist) persist->Release(); link->Release(); Expect(SUCCEEDED(result), "fixture link save");
}
void Junction(const std::wstring& path, const std::wstring& destination) {
  Directory(path);
  HANDLE handle = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr);
  Expect(handle != INVALID_HANDLE_VALUE, "junction open");
  const std::wstring substitute = L"\\??\\" + destination;
  struct Header { DWORD tag; WORD bytes, reserved, substituteOffset, substituteLength, printOffset, printLength; };
  const std::size_t size = (substitute.size() + destination.size() + 2) * sizeof(wchar_t);
  std::vector<unsigned char> bytes(sizeof(Header) + size, 0);
  Header* header = reinterpret_cast<Header*>(bytes.data());
  header->tag = IO_REPARSE_TAG_MOUNT_POINT; header->bytes = static_cast<WORD>(8 + size);
  header->substituteLength = static_cast<WORD>(substitute.size() * sizeof(wchar_t));
  header->printOffset = static_cast<WORD>((substitute.size() + 1) * sizeof(wchar_t));
  header->printLength = static_cast<WORD>(destination.size() * sizeof(wchar_t));
  memcpy(bytes.data() + sizeof(Header), substitute.c_str(), (substitute.size() + 1) * sizeof(wchar_t));
  memcpy(bytes.data() + sizeof(Header) + header->printOffset, destination.c_str(), (destination.size() + 1) * sizeof(wchar_t));
  DWORD count = 0; const BOOL okay = DeviceIoControl(handle, FSCTL_SET_REPARSE_POINT, bytes.data(), static_cast<DWORD>(bytes.size()), nullptr, 0, &count, nullptr);
  CloseHandle(handle); Expect(okay, "junction fixture create");
}
// Only this exact, newly-created temp root is removed; never follow reparse nodes.
void RemoveFixture(const std::wstring& path, const std::wstring& root) {
  if (path != root && !(path.size() > root.size() && path.compare(0, root.size() + 1, root + L"\\") == 0)) return;
  const DWORD attributes = GetFileAttributesW(path.c_str()); if (attributes == INVALID_FILE_ATTRIBUTES) return;
  if (!(attributes & FILE_ATTRIBUTE_DIRECTORY)) { DeleteFileW(path.c_str()); return; }
  if (attributes & FILE_ATTRIBUTE_REPARSE_POINT) { RemoveDirectoryW(path.c_str()); return; }
  WIN32_FIND_DATAW entry{}; HANDLE search = FindFirstFileW((path + L"\\*").c_str(), &entry);
  if (search != INVALID_HANDLE_VALUE) {
    do { if (wcscmp(entry.cFileName, L".") && wcscmp(entry.cFileName, L"..")) RemoveFixture(path + L"\\" + entry.cFileName, root); } while (FindNextFileW(search, &entry));
    FindClose(search);
  }
  RemoveDirectoryW(path.c_str());
}
struct Fixture {
  std::wstring root, install, executable, unrelated, menu, commonMenu, desktop, publicDesktop;
  milo::InstalledSoftware software;
  Fixture() {
    wchar_t temporary[MAX_PATH]{}, unique[MAX_PATH]{};
    Expect(GetTempPathW(ARRAYSIZE(temporary), temporary) != 0 && GetTempFileNameW(temporary, L"cyS", 0, unique) != 0, "unique temporary fixture");
    root = unique; Expect(DeleteFileW(root.c_str()), "temp placeholder"); Directory(root);
    install = root + L"\\Fixture Product"; Directory(install); executable = install + L"\\FixtureClient.exe"; File(executable);
    unrelated = root + L"\\Other.exe"; File(unrelated);
    menu = root + L"\\User Programs"; commonMenu = root + L"\\Common Programs";
    desktop = root + L"\\User Desktop"; publicDesktop = root + L"\\Public Desktop";
    for (const auto& item : Roots()) Directory(item);
    software.id = "HKCU|64|FixtureClient"; software.displayName = "Fixture Product"; software.publisher = "Fixture Company Ltd"; software.installLocation = milo::WideToUtf8(install);
  }
  ~Fixture() { RemoveFixture(root, root); }
  std::vector<std::wstring> Roots() const { return {menu, commonMenu, desktop, publicDesktop}; }
  milo::SoftwareCleanupPlan Scan(unsigned depth = 6, unsigned entries = 16000, unsigned results = 40) const {
    return milo::SoftwareServiceTestAccess::ScanShortcuts(software, executable, Roots(), {}, depth, entries, results);
  }
};
bool Contains(const milo::SoftwareCleanupPlan& plan, const std::wstring& path) {
  return std::find_if(plan.residuals.begin(), plan.residuals.end(), [&path](const milo::SoftwareResidual& row) { return row.path == milo::WideToUtf8(path); }) != plan.residuals.end();
}
}

int main() {
  const HRESULT apartment = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  try {
    Expect(SUCCEEDED(apartment), "fixture COM"); Fixture fixture;
    Directory(fixture.menu + L"\\Shared Games"); Directory(fixture.menu + L"\\Shared Games\\Unrelated Publisher");
    const std::wstring renamed = fixture.menu + L"\\Shared Games\\Unrelated Publisher\\任意改名.lnk";
    Link(renamed, fixture.executable); Link(fixture.menu + L"\\Fixture Product.lnk", fixture.unrelated);
    Link(fixture.commonMenu + L"\\Common link.lnk", fixture.executable);
    Link(fixture.desktop + L"\\User link.lnk", fixture.executable); Link(fixture.publicDesktop + L"\\Public link.lnk", fixture.executable);
    auto plan = fixture.Scan();
    Expect(plan.residuals.size() == 4 && !plan.scanTruncated, "four roots: nested and renamed links, no incomplete scan");
    Expect(Contains(plan, renamed) && !Contains(plan, fixture.menu + L"\\Fixture Product.lnk"), "parent-name independent, actual target not display name");
    for (const auto& row : plan.residuals) {
      Expect(row.kind == "shortcut" && row.targetPath == milo::WideToUtf8(fixture.executable), "target evidence");
      Expect(milo::SoftwareServiceTestAccess::Revalidate(row), "fresh identity");
      Expect(milo::SoftwareServiceTestAccess::CanSafelyCleanup(row), "positive locked cleanup validation without deleting anything");
      Expect(!(GetFileAttributesW(milo::Utf8ToWide(row.path).c_str()) & FILE_ATTRIBUTE_DIRECTORY), "shared directories never cleanup candidates");
    }
    const auto depthLimited = fixture.Scan(0); Expect(depthLimited.scanTruncated && !Contains(depthLimited, renamed), "depth limit visible");
    const auto nodeLimited = fixture.Scan(6, 2); Expect(nodeLimited.scanTruncated && !nodeLimited.scanWarnings.empty(), "node limit visible");
    bool cancelled = false;
    try { milo::SoftwareServiceTestAccess::ScanShortcuts(fixture.software, fixture.executable, fixture.Roots(), [] { return true; }); } catch (...) { cancelled = true; }
    Expect(cancelled, "cancelled scan has no success plan");
    Directory(fixture.root + L"\\Outside Roots"); Link(fixture.root + L"\\Outside Roots\\hidden.lnk", fixture.executable);
    Junction(fixture.menu + L"\\Junction", fixture.root + L"\\Outside Roots");
    const auto junctionPlan = fixture.Scan(); Expect(junctionPlan.residuals.size() == 4 && junctionPlan.scanTruncated, "no reparse traversal");
    Expect(RemoveDirectoryW((fixture.menu + L"\\Junction").c_str()), "remove junction node only");

    const std::wstring denied = fixture.menu + L"\\Denied"; Directory(denied);
    BYTE sid[SECURITY_MAX_SID_SIZE]{}; DWORD sidSize = sizeof(sid); BYTE aclBytes[256]{}; PACL acl = reinterpret_cast<PACL>(aclBytes);
    Expect(CreateWellKnownSid(WinWorldSid, nullptr, sid, &sidSize) && InitializeAcl(acl, sizeof(aclBytes), ACL_REVISION) && AddAccessDeniedAce(acl, ACL_REVISION, FILE_LIST_DIRECTORY, sid) && AddAccessAllowedAce(acl, ACL_REVISION, GENERIC_ALL, sid), "fixture ACL");
    Expect(SetNamedSecurityInfoW(const_cast<wchar_t*>(denied.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, acl, nullptr) == ERROR_SUCCESS, "fixture deny list");
    const auto deniedPlan = fixture.Scan();
    Expect(SetNamedSecurityInfoW(const_cast<wchar_t*>(denied.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, nullptr, nullptr) == ERROR_SUCCESS, "fixture ACL restored");
    Expect(deniedPlan.scanTruncated && !deniedPlan.scanWarnings.empty(), "permission denial reported");

    plan = fixture.Scan();
    const auto original = *std::find_if(plan.residuals.begin(), plan.residuals.end(), [&renamed](const milo::SoftwareResidual& row) { return row.path == milo::WideToUtf8(renamed); });
    Link(renamed, fixture.unrelated); Expect(!milo::SoftwareServiceTestAccess::Revalidate(original), "changed target rejected");
    milo::SoftwareService service; milo::SoftwareServiceTestAccess::InstallPlan(service, plan);
    milo::SoftwareServiceTestAccess::SetRegistered(service, true);
    const auto notUninstalled = service.CleanupResiduals(plan.token, plan.displayName, {plan.residuals.back().path}, true);
    Expect(!notUninstalled.succeeded && notUninstalled.removedPaths.empty(), "registered app/cancelled uninstall blocks residual deletion");
    milo::SoftwareServiceTestAccess::SetRegistered(service, false);
    const auto rejected = service.CleanupResiduals(plan.token, plan.displayName, {original.path}, true);
    Expect(!rejected.succeeded && GetFileAttributesW(renamed.c_str()) != INVALID_FILE_ATTRIBUTES, "changed link never removed");
    const auto refreshed = service.RefreshResiduals(plan.token);
    Expect(refreshed.residuals.size() == 3 && refreshed.scanTruncated, "refresh removes changed candidate");
    Expect(!service.RevealResidual(plan.token, milo::WideToUtf8(fixture.unrelated)).succeeded, "foreign reveal refused, no Explorer open");
    const auto forged = service.CleanupResiduals(plan.token, plan.displayName, {refreshed.residuals.front().path, milo::WideToUtf8(fixture.unrelated)}, true);
    Expect(!forged.succeeded && forged.removedPaths.empty(), "mixed forged selection no partial deletion");
    const auto retained = refreshed.residuals.front();
    Expect(DeleteFileW(fixture.executable.c_str()), "fixture uninstall target removal");
    Expect(milo::SoftwareServiceTestAccess::Revalidate(retained), "cached evidence survives missing target");
    Expect(service.RefreshResiduals(plan.token).residuals.size() == 3, "post-uninstall refresh keeps exact evidence"); File(fixture.executable);
    const auto batch = service.RefreshResiduals(plan.token);
    Expect(DeleteFileW(milo::Utf8ToWide(batch.residuals.front().path).c_str()), "fixture first cleanup item already removed by uninstaller");
    const auto cleanedBatch = service.CleanupResiduals(batch.token, batch.displayName, {batch.residuals.front().path}, true);
    Expect(cleanedBatch.succeeded && cleanedBatch.removedPaths.size() == 1, "missing exact locked item is acknowledged without filesystem deletion");
    const auto remainingBatch = service.RefreshResiduals(batch.token);
    Expect(remainingBatch.token == batch.token && remainingBatch.residuals.size() == batch.residuals.size() - 1, "partial cleanup preserves unselected candidates and token");
    Expect(GetFileAttributesW((fixture.menu + L"\\Shared Games").c_str()) != INVALID_FILE_ATTRIBUTES, "shared menu parent retained");
    for (int index = 0; index < 45; ++index) Link(fixture.publicDesktop + L"\\Many " + std::to_wstring(index) + L".lnk", fixture.executable);
    auto capped = fixture.Scan(); Expect(capped.residuals.size() == 40 && capped.scanTruncated && !capped.scanWarnings.empty(), "40 result limit visible");
    auto expired = capped; expired.nativeCreatedTick = GetTickCount64() - 16U * 60U * 1000U;
    milo::SoftwareServiceTestAccess::InstallPlan(service, expired);
    Expect(!service.CleanupResiduals(expired.token, expired.displayName, {expired.residuals.front().path}, true).succeeded, "TTL blocks cleanup");
    const auto renewed = service.RefreshResiduals(expired.token);
    Expect(renewed.token == expired.token && renewed.residuals.size() == expired.residuals.size(), "expired refresh revalidates original identities and renews stable token");
    Expect(std::all_of(renewed.residuals.begin(), renewed.residuals.end(), [](const milo::SoftwareResidual& row) { return !row.defaultSelected; }), "renewal requires renewed user selection");
    service.CancelScan();
    Expect(!service.CleanupResiduals(renewed.token, renewed.displayName, {renewed.residuals.front().path}, true).succeeded, "cancel immediately invalidates deletion generation");
    const auto recovered = service.RefreshResiduals(renewed.token);
    Expect(recovered.token == renewed.token && recovered.residuals.size() == renewed.residuals.size(), "stable token recovers cancelled result delivery by revalidation");
    const auto replacement = recovered.residuals.front();
    const std::wstring replacementPath = milo::Utf8ToWide(replacement.path);
    Expect(MoveFileW(replacementPath.c_str(), (replacementPath + L".old").c_str()), "fixture preserve old link identity");
    Link(replacementPath, fixture.executable);
    Expect(!milo::SoftwareServiceTestAccess::Revalidate(replacement), "replacement file with same target still rejected by native identity");
    auto sharedSoftware = fixture.software;
    sharedSoftware.installLocation = milo::WideToUtf8(fixture.root + L"\\Shared Publisher");
    Expect(!milo::SoftwareServiceTestAccess::ProductNameMatches(sharedSoftware, fixture.executable, L"Shared Publisher"), "install path leaf is not self-authenticating product evidence");
    Expect(milo::SoftwareServiceTestAccess::SharedDirectory(fixture.install, {fixture.install}), "same registered location is conservatively shared");
    Expect(milo::SoftwareServiceTestAccess::SharedDirectory(fixture.install, {fixture.install + L"\\Other Product\\app.exe"}), "other executable nested in candidate protects parent");
    Expect(!milo::SoftwareServiceTestAccess::SharedDirectory(fixture.install, {fixture.install + L" Extra"}), "shared test respects path component boundaries");
    const std::wstring uninstaller = fixture.install + L"\\Uninstall Tool.exe"; File(uninstaller);
    Expect(milo::SoftwareServiceTestAccess::UninstallerExecutable(uninstaller + L" /remove") == uninstaller, "space path explicit executable");
    Expect(milo::SoftwareServiceTestAccess::UninstallerExecutable(L"\"" + uninstaller + L"\" /remove") == uninstaller, "quoted executable");
    Expect(milo::SoftwareServiceTestAccess::UninstallerExecutable(L"relative.exe /remove").empty(), "no PATH/current-directory executable search");
    std::cout << "PASS software isolated fixtures: four roots, nested/renamed, targets, shared folders, junction/permissions, cancellation/limits, identity/TTL, refresh and explicit EXE.\n";
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n'; if (SUCCEEDED(apartment)) CoUninitialize(); return 1;
  }
  if (SUCCEEDED(apartment)) CoUninitialize(); return 0;
}
