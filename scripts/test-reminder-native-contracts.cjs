/**
 * Source-contract regression checks for native reminder/window wiring.
 * These assertions inspect C++ source; they do NOT run Win32/WebView2 windows,
 * install the application, wait for a real reminder, or touch user data.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const application = read('native/src/Application.cpp');
const windowHost = read('native/src/WebViewWindow.cpp');
const applicationHeader = read('native/include/Milo/Application.h');
const windowHeader = read('native/include/Milo/WebViewWindow.h');
const nativeCmake = read('native/CMakeLists.txt');

// Preserve offsets while ignoring comments and braces inside C++ literals.
const cppTokens = /R"([^ ()\\\t\r\n]{0,16})\([\s\S]*?\)\1"|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g;
const blank = (token) => token.replace(/[^\r\n]/g, ' ');
const mask = (source) => source.replace(cppTokens, blank);
const withoutComments = (source) => source.replace(cppTokens, (token) =>
  token.startsWith('//') || token.startsWith('/*') ? blank(token) : token);

function blockAfter(source, marker) {
  const code = mask(source);
  const found = marker.exec(code);
  assert.ok(found, `Source block exists: ${marker}`);
  const open = code.indexOf('{', found.index + found[0].length);
  assert.ok(open >= 0, `Source block has opening brace: ${marker}`);
  let depth = 1;
  for (let cursor = open + 1; cursor < code.length; cursor += 1) {
    if (code[cursor] === '{') depth += 1;
    if (code[cursor] === '}') depth -= 1;
    if (!depth) return withoutComments(source.slice(open + 1, cursor));
  }
  throw new Error(`Unbalanced source block: ${marker}`);
}

function method(source, qualifiedName) {
  const escapedName = qualifiedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return blockAfter(source, new RegExp(`\\b${escapedName}\\s*\\([^)]*\\)\\s*(?:const\\s*)?`));
}

let checked = 0;
function contract(name, run) {
  run();
  checked += 1;
  console.log(`PASS source contract: ${name}`);
}

const timer = method(application, 'Application::HandleTimer');
const dueLoop = blockAfter(timer, /for\s*\(const Reminder& reminder\s*:\s*due\)/);
const begin = method(windowHost, 'WebViewWindow::BeginReminderPresentation');
const animation = method(windowHost, 'WebViewWindow::UpdatePresentationAnimation');
const returnAnimation = method(windowHost, 'WebViewWindow::StartPresentationReturn');
const closeDashboard = method(application, 'Application::CloseDashboard');
const syncPet = method(application, 'Application::SyncPetVisibility');
const showDashboard = method(application, 'Application::ShowDashboard');
const presentationFinished = method(application, 'Application::OnReminderPresentationFinished');

contract('every claimed due reminder begins presentation without a dashboard visibility gate', () => {
  assert.match(timer, /reminders_\.TakeDue\(UnixTimeMilliseconds\(\)\)/);
  assert.match(dueLoop, /^\s*suppressCurrentPresentation_ = false;\s*petWindow_->BeginReminderPresentation\(\s*reminder\.priority\s*,/);
  assert.equal((dueLoop.match(/BeginReminderPresentation\(/g) || []).length, 1);
  assert.ok(dueLoop.indexOf('BeginReminderPresentation(') < dueLoop.indexOf('"reminder.triggered"'));
  assert.match(dueLoop, /PlayReminderAlert\(reminder\)/);
  assert.match(dueLoop, /ShowNativeNotification\(reminder\)/);
  assert.match(dueLoop, /Broadcast\(\{\{"type", "reminder\.triggered"\}/);
});

contract('animation-active state is separate from an unresolved reminder', () => {
  assert.match(windowHeader, /bool IsReminderPresenting\(\) const;/);
  const presenting = method(windowHost, 'WebViewWindow::IsReminderPresenting');
  assert.match(presenting, /return presentationState_ != PresentationState::Idle;/);
  assert.doesNotMatch(presenting, /hasPresentedReminder_/);
});

contract('native return completion callback fires only after returning to Idle', () => {
  assert.match(applicationHeader, /void OnReminderPresentationFinished\(\);/);
  assert.match(animation, /else\s*\{\s*presentationState_ = PresentationState::Idle;\s*KillTimer\(window_, kPresentationTimerId\);\s*application_\.OnReminderPresentationFinished\(\);\s*\}/);
  assert.equal((animation.match(/OnReminderPresentationFinished\(/g) || []).length, 1);
  assert.doesNotMatch(returnAnimation, /OnReminderPresentationFinished\(/);
  assert.match(returnAnimation, /presentationState_ = PresentationState::MovingOut;/);
});

contract('closing the dashboard never replays a previously displayed reminder', () => {
  assert.doesNotMatch(closeDashboard, /BeginReminderPresentation|reminder\.triggered|PlayReminderAlert|ShowNativeNotification/);
  assert.doesNotMatch(applicationHeader, /presentedReminderPriority_/);
});

contract('monitor anchoring ignores closed or minimized workbenches', () => {
  assert.match(windowHeader, /HWND anchorWindow = nullptr/);
  assert.match(begin, /anchorWindow != nullptr && IsWindowVisible\(anchorWindow\) &&\s*!IsIconic\(anchorWindow\)\s*\? anchorWindow\s*:\s*window_/);
  assert.match(begin, /MonitorFromWindow\(monitorWindow, MONITOR_DEFAULTTONEAREST\)/);
  assert.match(begin, /monitorInfo\.rcWork/);
  assert.ok(begin.indexOf('ResetAutoTuck(true)') < begin.indexOf('GetWindowRect(window_, &current)'));
  assert.match(begin, /if \(presentationState_ == PresentationState::Idle\)\s*\{\s*restBounds_ = current;/);
});

contract('the placard retains its 12-second hold and returns both automatically and explicitly', () => {
  assert.match(withoutComments(windowHost), /constexpr ULONGLONG kHoldDurationMs = 12000;/);
  assert.match(animation, /now - presentationPhaseStarted_ >= kHoldDurationMs/);
  assert.match(animation, /StartPresentationReturn\(true\)/);
  assert.match(method(windowHost, 'WebViewWindow::EndReminderPresentation'), /StartPresentationReturn\(false\)/);
});

contract('showing the pet stays topmost without taking keyboard focus', () => {
  const show = method(windowHost, 'WebViewWindow::Show');
  const petShow = blockAfter(show, /if\s*\(kind_ == WindowKind::Pet\)/);
  assert.match(petShow, /ShowWindow\(window_, SW_SHOWNOACTIVATE\)/);
  assert.match(petShow, /SetWindowPos\(window_, HWND_TOPMOST,[\s\S]*?SWP_NOACTIVATE/);
  assert.doesNotMatch(petShow, /SetForegroundWindow|SetFocus|SetActiveWindow/);
});

contract('production links and calls the independently unit-tested C behavior policy', () => {
  assert.match(application, /#include "cloudyi\/pet_behavior\.h"/);
  assert.match(nativeCmake, /c_core\/src\/pet_behavior\.c/);
  assert.match(nativeCmake, /add_executable\(MiloPetBehaviorTests tests\/PetBehaviorTests\.c\)/);
  assert.match(nativeCmake, /add_test\(NAME MiloPetBehaviorTests COMMAND MiloPetBehaviorTests\)/);
  assert.match(syncPet, /cloudyi_pet_should_show\(\s*IsDashboardOnDesktop\(\), petManuallyHidden_,\s*petWindow_->IsReminderPresenting\(\) && !suppressCurrentPresentation_\)/);
  assert.match(timer, /cloudyi_pet_should_tuck\(/);
});

contract('minimized workbenches are consistently excluded from desktop visibility', () => {
  const desktopVisible = method(application, 'Application::IsDashboardOnDesktop');
  assert.match(desktopVisible, /return dashboardWindow_ != nullptr &&\s*IsWindowVisible\(dashboardWindow_->Handle\(\)\) &&\s*!IsIconic\(dashboardWindow_->Handle\(\)\);/);
  assert.match(timer, /const bool dashboardVisible = IsDashboardOnDesktop\(\);/);
  assert.match(method(application, 'Application::ShowTrayMenu'), /const bool dashboardVisible = IsDashboardOnDesktop\(\);/);
  assert.match(method(windowHost, 'WebViewWindow::Show'), /ShowWindow\(window_, IsIconic\(window_\) \? SW_RESTORE : SW_SHOW\)/);
});

contract('visibility reconciliation applies transitions only and tolerates startup or shutdown', () => {
  assert.match(applicationHeader, /void SyncPetVisibility\(\);/);
  assert.match(syncPet, /^\s*if \(quitting_ \|\| petWindow_ == nullptr \|\| petWindow_->Handle\(\) == nullptr\)\s*\{\s*return;/);
  assert.match(syncPet, /const bool visible = IsWindowVisible\(petWindow_->Handle\(\)\) != FALSE;/);
  assert.match(syncPet, /if \(shouldShow && !visible\) petWindow_->Show\(\);/);
  assert.match(syncPet, /if \(!shouldShow && visible\) petWindow_->Hide\(\);/);
  assert.equal((syncPet.match(/petWindow_->Show\(/g) || []).length, 1);
  assert.equal((syncPet.match(/petWindow_->Hide\(/g) || []).length, 1);
  assert.doesNotMatch(syncPet, /ResetAutoTuck|hasPresentedReminder_/);
});

contract('opening, closing and reminder return all reconcile current state without corrupting user preference', () => {
  assert.match(showDashboard, /dashboardWindow_->Show\(\);\s*SyncPetVisibility\(\);/);
  assert.match(closeDashboard, /dashboardWindow_->Hide\(\);\s*\}\s*SyncPetVisibility\(\);/);
  assert.match(presentationFinished, /suppressCurrentPresentation_ = false;\s*SyncPetVisibility\(\);/);
  for (const body of [showDashboard, closeDashboard, presentationFinished]) {
    assert.doesNotMatch(body, /petManuallyHidden_\s*=/);
    assert.doesNotMatch(body, /hasPresentedReminder_\s*=/);
  }
  assert.doesNotMatch(application + applicationHeader, /restorePetAfterDashboard_/);
});

contract('Win32 resize and show/hide events reconcile the dashboard, not pet animation resize events', () => {
  const dispatch = method(windowHost, 'WebViewWindow::HandleMessage');
  const size = dispatch.match(/case WM_SIZE:([\s\S]*?)return 0;/)?.[1];
  const shown = dispatch.match(/case WM_SHOWWINDOW:([\s\S]*?)return 0;/)?.[1];
  assert.ok(size && shown, 'Both native window events have handlers');
  for (const body of [size, shown]) {
    assert.match(body, /if \(kind_ == WindowKind::Dashboard\) application_\.SyncPetVisibility\(\);/);
  }
  assert.match(size, /ResizeWebView\(\);\s*SyncWebViewVisibility\(\);/);
});

contract('WebView painting visibility follows the native host after show, hide, minimize and async creation', () => {
  const controllerVisibility = method(windowHost, 'WebViewWindow::SyncWebViewVisibility');
  assert.match(windowHeader, /void SyncWebViewVisibility\(\);/);
  assert.match(controllerVisibility, /if \(controller_ != nullptr && window_ != nullptr\)/);
  assert.match(controllerVisibility, /controller_->put_IsVisible\(IsWindowVisible\(window_\) && !IsIconic\(window_\)\);/);
  assert.match(method(windowHost, 'WebViewWindow::Show'), /ResizeWebView\(\);\s*SyncWebViewVisibility\(\);/);
  assert.match(method(windowHost, 'WebViewWindow::Hide'), /ShowWindow\(window_, SW_HIDE\);\s*SyncWebViewVisibility\(\);/);
  assert.match(method(windowHost, 'WebViewWindow::InitializeWebView'), /controller_ = controller;[\s\S]*?ConfigureWebView\(\);\s*ResizeWebView\(\);\s*SyncWebViewVisibility\(\);/);
});

contract('auto-tuck uses actual system idle time and animation state, not unresolved reminder state', () => {
  assert.match(timer, /SyncPetVisibility\(\);[\s\S]*?GetLastInputInfo\(&lastInput\)/);
  assert.match(timer, /const DWORD idleMilliseconds = GetTickCount\(\) - lastInput\.dwTime;/);
  assert.match(timer, /cloudyi_pet_should_tuck\(\s*autoHideEnabled_, dashboardVisible, petManuallyHidden_,\s*petWindow_->IsReminderPresenting\(\), idleMilliseconds,\s*autoHideMinutes_\)/);
  const autoTuckPolicy = timer.slice(timer.indexOf('const bool shouldTuck'), timer.indexOf('petWindow_->SetAutoTucked(shouldTuck)'));
  assert.doesNotMatch(autoTuckPolicy, /hasPresentedReminder_/);
  assert.match(timer, /petWindow_->SetAutoTucked\(shouldTuck\);/);
});

contract('manual hide is explicit and never replaced by a snapshot of temporary workspace visibility', () => {
  const manualHide = method(application, 'Application::SetPetHiddenByUser');
  assert.match(applicationHeader, /bool petManuallyHidden_\{\};/);
  assert.match(applicationHeader, /bool suppressCurrentPresentation_\{\};/);
  assert.match(manualHide, /petManuallyHidden_ = hidden;/);
  assert.match(manualHide, /suppressCurrentPresentation_ = hidden;/);
  assert.match(manualHide, /SyncPetVisibility\(\);/);
  assert.match(method(application, 'Application::HandleWebMessage'), /if \(type == "window\.hidePet"\)\s*\{\s*SetPetHiddenByUser\(true\);/);
  const tray = method(application, 'Application::ShowTrayMenu');
  assert.match(tray, /SetPetHiddenByUser\(true\)/);
  assert.match(tray, /SetPetHiddenByUser\(false\)/);
});

contract('hiding a placard synchronizes React presentation state without dismissing the reminder', () => {
  const manualHide = method(application, 'Application::SetPetHiddenByUser');
  const activeHide = blockAfter(manualHide, /if\s*\(hidden && petWindow_->IsReminderPresenting\(\)\)/);
  assert.match(activeHide, /petWindow_->EndReminderPresentation\(\);/);
  assert.match(activeHide, /petWindow_->PostJson\(R"\(\{"type":"presentation\.ended"\}\)"\);/);
  assert.doesNotMatch(manualHide, /reminder\.dismissed|reminder\.complete|hasPresentedReminder_\s*=/);
});

contract('every process startup shows the pet independently of the onboarding marker', () => {
  const run = method(application, 'Application::Run');
  assert.match(run, /AddTrayIcon\(\);\s*petWindow_->Show\(\);\s*if \(showDashboardOnStart_\)/);
});

contract('auto-tuck leaves character content visible rather than only a transparent 42px host edge', () => {
  const tuck = method(windowHost, 'WebViewWindow::SetAutoTucked');
  assert.match(tuck, /const LONG visibleStrip = \(std::max\)\(LONG\{1\}, width \/ 2\);/);
  assert.match(tuck, /monitorInfo\.rcWork\.left - width \+ visibleStrip/);
  assert.match(tuck, /monitorInfo\.rcWork\.right - visibleStrip/);
  assert.doesNotMatch(tuck, /kVisibleStrip\s*=\s*42/);
});

console.log(`PASS ${checked} native reminder source contracts. This is source inspection, not a real native UI or offline-installation test.`);
