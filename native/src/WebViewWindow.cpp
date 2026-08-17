#include "Milo/WebViewWindow.h"

#include <dwmapi.h>
#include <windowsx.h>
#include <wrl/event.h>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <string>

#include "Milo/Application.h"
#include "Milo/Utils.h"
#include "resource.h"

namespace milo {
namespace {

constexpr wchar_t kWindowClassName[] = L"MiloDesktopPet.WebViewWindow";
constexpr UINT kReminderTimerId = 1;
constexpr UINT kPresentationTimerId = 2;
constexpr UINT kAutoTuckTimerId = 3;
constexpr UINT kTrayMessage = WM_APP + 42;
constexpr ULONGLONG kHoldDurationMs = 12000;
constexpr ULONGLONG kMoveOutDurationMs = 850;

template <typename T>
T ClampValue(T value, T lower, T upper) {
  return value < lower ? lower : (value > upper ? upper : value);
}

/** Higher-priority reminders reach the center more quickly. */
ULONGLONG MoveInDuration(const std::string& priority) {
  if (priority == "urgent") {
    return 760;
  }
  if (priority == "important") {
    return 1050;
  }
  return 1400;
}

double EaseOutCubic(double value) {
  const double inverse = 1.0 - value;
  return 1.0 - inverse * inverse * inverse;
}

double EaseInOutCubic(double value) {
  return value < 0.5 ? 4.0 * value * value * value
                     : 1.0 - std::pow(-2.0 * value + 2.0, 3.0) / 2.0;
}

LONG Interpolate(LONG start, LONG end, double progress) {
  return static_cast<LONG>(
      std::lround(start + static_cast<double>(end - start) * progress));
}

void ShowWebViewError(HWND owner, const wchar_t* stage, HRESULT result) {
  wchar_t message[256]{};
  swprintf_s(message, L"%s失败（HRESULT 0x%08X）。\n请确认已安装 WebView2 Runtime。",
             stage, static_cast<unsigned int>(result));
  MessageBoxW(owner, message, L"依依工作台", MB_OK | MB_ICONERROR);
}

}  // namespace

WebViewWindow::WebViewWindow(Application& application, WindowKind kind)
    : application_(application), kind_(kind) {}

WebViewWindow::~WebViewWindow() {
  if (controller_ != nullptr) {
    controller_->Close();
  }
  if (window_ != nullptr && IsWindow(window_)) {
    DestroyWindow(window_);
  }
}

bool WebViewWindow::Create(HINSTANCE instance) {
  WNDCLASSEXW windowClass{};
  windowClass.cbSize = sizeof(windowClass);
  if (!GetClassInfoExW(instance, kWindowClassName, &windowClass)) {
    windowClass.style = CS_DBLCLKS;
    windowClass.lpfnWndProc = &WebViewWindow::WindowProc;
    windowClass.hInstance = instance;
    windowClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    windowClass.hIcon = static_cast<HICON>(LoadImageW(
        instance, MAKEINTRESOURCEW(IDI_CUTE_YIYI_APP), IMAGE_ICON,
        GetSystemMetrics(SM_CXICON), GetSystemMetrics(SM_CYICON),
        LR_DEFAULTCOLOR | LR_SHARED));
    windowClass.hIconSm = static_cast<HICON>(LoadImageW(
        instance, MAKEINTRESOURCEW(IDI_CUTE_YIYI_APP), IMAGE_ICON,
        GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON),
        LR_DEFAULTCOLOR | LR_SHARED));
    if (windowClass.hIcon == nullptr) {
      windowClass.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
    }
    if (windowClass.hIconSm == nullptr) {
      windowClass.hIconSm = windowClass.hIcon;
    }
    windowClass.lpszClassName = kWindowClassName;
    if (RegisterClassExW(&windowClass) == 0) {
      return false;
    }
  }

  DWORD style = WS_OVERLAPPEDWINDOW;
  DWORD extendedStyle = WS_EX_APPWINDOW;
  RECT bounds{};

  // The pet is an always-on-top transparent tool window; the dashboard is a
  // conventional taskbar window with resize/minimize behavior.
  if (kind_ == WindowKind::Pet) {
    style = WS_POPUP;
    extendedStyle = WS_EX_TOOLWINDOW | WS_EX_TOPMOST;

    RECT workArea{};
    SystemParametersInfoW(SPI_GETWORKAREA, 0, &workArea, 0);
    constexpr int width = 320;
    constexpr int height = 360;
    int left = workArea.right - width - 18;
    int top = workArea.bottom - height - 18;
    if (application_.HasPetPosition()) {
      const POINT saved = application_.PetPosition();
      const HMONITOR monitor =
          MonitorFromPoint(saved, MONITOR_DEFAULTTONEAREST);
      MONITORINFO monitorInfo{sizeof(monitorInfo)};
      if (GetMonitorInfoW(monitor, &monitorInfo)) {
        left = ClampValue(saved.x, monitorInfo.rcWork.left,
                          monitorInfo.rcWork.right - width);
        top = ClampValue(saved.y, monitorInfo.rcWork.top,
                         monitorInfo.rcWork.bottom - height);
      }
    }
    bounds = {left, top, left + width, top + height};
  } else {
    RECT workArea{};
    SystemParametersInfoW(SPI_GETWORKAREA, 0, &workArea, 0);
    const int availableWidth = workArea.right - workArea.left;
    const int availableHeight = workArea.bottom - workArea.top;
    // The merged CloudYi workbench benefits from a wider editor while still
    // leaving a margin on smaller displays. The window remains resizable.
    const int width = (std::min)(
        availableWidth, (std::max)(720, (std::min)(1120, availableWidth - 48)));
    const int height = (std::min)(
        availableHeight, (std::max)(560, (std::min)(740, availableHeight - 48)));
    const int left = workArea.left + (availableWidth - width) / 2;
    const int top = workArea.top + (availableHeight - height) / 2;
    bounds = {left, top, left + width, top + height};
  }

  const std::wstring petName = Utf8ToWide(application_.PetName());
  const std::wstring title =
      kind_ == WindowKind::Pet ? petName : L"依依工作台";
  window_ = CreateWindowExW(
      extendedStyle, kWindowClassName, title.c_str(), style,
      bounds.left, bounds.top, bounds.right - bounds.left,
      bounds.bottom - bounds.top, nullptr, nullptr, instance, this);
  if (window_ != nullptr && kind_ == WindowKind::Pet) {
    ConfigureTransparentHost();
  }
  return window_ != nullptr;
}

void WebViewWindow::Show() {
  if (window_ == nullptr) {
    return;
  }
  if (kind_ == WindowKind::Pet) {
    ResetAutoTuck(true);
    ShowWindow(window_, SW_SHOWNOACTIVATE);
    SetWindowPos(window_, HWND_TOPMOST, 0, 0, 0, 0,
                 SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
  } else {
    ShowWindow(window_, SW_SHOW);
    SetForegroundWindow(window_);
  }
}

void WebViewWindow::Hide() {
  if (window_ != nullptr) {
    ResetAutoTuck(true);
    ShowWindow(window_, SW_HIDE);
  }
}

void WebViewWindow::SetTitle(const std::wstring& title) {
  if (window_ != nullptr) {
    SetWindowTextW(window_, title.c_str());
  }
}

void WebViewWindow::SetIcons(HICON largeIcon, HICON smallIcon) {
  if (window_ == nullptr) return;
  if (largeIcon != nullptr) SendMessageW(window_, WM_SETICON, ICON_BIG,
                                         reinterpret_cast<LPARAM>(largeIcon));
  if (smallIcon != nullptr) SendMessageW(window_, WM_SETICON, ICON_SMALL,
                                         reinterpret_cast<LPARAM>(smallIcon));
}

void WebViewWindow::BeginDrag() {
  if (window_ == nullptr || kind_ != WindowKind::Pet ||
      presentationState_ != PresentationState::Idle ||
      autoTuckState_ != AutoTuckState::Visible) {
    return;
  }
  if (!GetCursorPos(&manualDragStartCursor_) ||
      !GetWindowRect(window_, &manualDragStartBounds_)) {
    return;
  }
  manualDragActive_ = true;
}

void WebViewWindow::UpdateDrag() {
  if (!manualDragActive_ || window_ == nullptr) return;
  POINT cursor{};
  if (!GetCursorPos(&cursor)) return;
  const int x = manualDragStartBounds_.left +
                (cursor.x - manualDragStartCursor_.x);
  const int y = manualDragStartBounds_.top +
                (cursor.y - manualDragStartCursor_.y);
  SetWindowPos(window_, nullptr, x, y, 0, 0,
               SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
}

void WebViewWindow::EndDrag() {
  if (!manualDragActive_) return;
  UpdateDrag();
  manualDragActive_ = false;
  SnapPetToWorkArea();
  application_.SavePetPosition(window_);
}

void WebViewWindow::BeginReminderPresentation(const std::string& priority) {
  if (window_ == nullptr || kind_ != WindowKind::Pet) {
    return;
  }

  ResetAutoTuck(true);
  RECT current{};
  if (!GetWindowRect(window_, &current)) {
    return;
  }
  if (presentationState_ == PresentationState::Idle) {
    restBounds_ = current;
  }
  presentationPriority_ = priority;

  const HMONITOR monitor =
      MonitorFromWindow(window_, MONITOR_DEFAULTTONEAREST);
  MONITORINFO monitorInfo{sizeof(monitorInfo)};
  if (!GetMonitorInfoW(monitor, &monitorInfo)) {
    return;
  }

  // Center within the monitor work area so the reminder never covers the
  // taskbar and remains correct on multi-monitor desktops.
  const int workWidth = monitorInfo.rcWork.right - monitorInfo.rcWork.left;
  const int workHeight = monitorInfo.rcWork.bottom - monitorInfo.rcWork.top;
  const int preferredWidth = priority == "urgent" ? 500
                             : priority == "important" ? 480
                                                        : 460;
  const int preferredHeight = priority == "urgent" ? 540
                              : priority == "important" ? 520
                                                         : 500;
  const int targetWidth = std::min(preferredWidth, workWidth - 40);
  const int targetHeight = std::min(preferredHeight, workHeight - 40);
  const int targetX = monitorInfo.rcWork.left + (workWidth - targetWidth) / 2;
  const int targetY = monitorInfo.rcWork.top + (workHeight - targetHeight) / 2;

  animationFrom_ = current;
  animationTo_ = {targetX, targetY, targetX + targetWidth,
                  targetY + targetHeight};
  presentationState_ = PresentationState::MovingIn;
  presentationPhaseStarted_ = GetTickCount64();
  KillTimer(window_, kPresentationTimerId);
  SetTimer(window_, kPresentationTimerId, 16, nullptr);
  Show();
}

void WebViewWindow::EndReminderPresentation() {
  if (presentationState_ == PresentationState::Idle ||
      presentationState_ == PresentationState::MovingOut) {
    return;
  }
  StartPresentationReturn(false);
}

void WebViewWindow::SetAutoTucked(bool tucked) {
  if (window_ == nullptr || kind_ != WindowKind::Pet ||
      presentationState_ != PresentationState::Idle ||
      !IsWindowVisible(window_)) {
    return;
  }
  if (tucked && (autoTuckState_ == AutoTuckState::MovingOut ||
                 autoTuckState_ == AutoTuckState::Tucked)) {
    return;
  }
  if (!tucked && (autoTuckState_ == AutoTuckState::Visible ||
                  autoTuckState_ == AutoTuckState::MovingIn)) {
    return;
  }

  RECT current{};
  if (!GetWindowRect(window_, &current)) {
    return;
  }

  if (tucked) {
    autoTuckRestBounds_ = current;
    const HMONITOR monitor =
        MonitorFromWindow(window_, MONITOR_DEFAULTTONEAREST);
    MONITORINFO monitorInfo{sizeof(monitorInfo)};
    if (!GetMonitorInfoW(monitor, &monitorInfo)) {
      return;
    }
    // Leave a narrow visible strip so the pet can still be discovered while
    // inactive. Choose the nearest horizontal edge to avoid crossing the screen.
    constexpr LONG kVisibleStrip = 42;
    const LONG width = current.right - current.left;
    const LONG height = current.bottom - current.top;
    const LONG leftDistance =
        std::abs(current.left - monitorInfo.rcWork.left);
    const LONG rightDistance =
        std::abs(monitorInfo.rcWork.right - current.right);
    const LONG targetX =
        leftDistance <= rightDistance
            ? monitorInfo.rcWork.left - width + kVisibleStrip
            : monitorInfo.rcWork.right - kVisibleStrip;
    const LONG targetY = ClampValue(
        current.top, monitorInfo.rcWork.top,
        monitorInfo.rcWork.bottom - height);
    autoTuckFrom_ = current;
    autoTuckTo_ = {targetX, targetY, targetX + width, targetY + height};
    autoTuckState_ = AutoTuckState::MovingOut;
  } else {
    autoTuckFrom_ = current;
    autoTuckTo_ = autoTuckRestBounds_;
    autoTuckState_ = AutoTuckState::MovingIn;
  }

  autoTuckStarted_ = GetTickCount64();
  KillTimer(window_, kAutoTuckTimerId);
  SetTimer(window_, kAutoTuckTimerId, 16, nullptr);
}

void WebViewWindow::PostJson(const std::string& json) {
  if (webView_ == nullptr) {
    return;
  }
  const std::wstring wideJson = Utf8ToWide(json);
  webView_->PostWebMessageAsJson(wideJson.c_str());
}

LRESULT CALLBACK WebViewWindow::WindowProc(HWND window, UINT message,
                                           WPARAM wParam, LPARAM lParam) {
  WebViewWindow* self = reinterpret_cast<WebViewWindow*>(
      GetWindowLongPtrW(window, GWLP_USERDATA));

  // WM_NCCREATE is the earliest point at which the C++ instance can be attached
  // to the HWND for subsequent static-window-procedure dispatch.
  if (message == WM_NCCREATE) {
    const auto* create = reinterpret_cast<CREATESTRUCTW*>(lParam);
    self = static_cast<WebViewWindow*>(create->lpCreateParams);
    self->window_ = window;
    SetWindowLongPtrW(window, GWLP_USERDATA,
                      reinterpret_cast<LONG_PTR>(self));
  }

  if (self != nullptr) {
    return self->HandleMessage(message, wParam, lParam);
  }
  return DefWindowProcW(window, message, wParam, lParam);
}

LRESULT WebViewWindow::HandleMessage(UINT message, WPARAM wParam,
                                     LPARAM lParam) {
  switch (message) {
    case WM_CREATE:
      InitializeWebView();
      if (kind_ == WindowKind::Pet) {
        SetTimer(window_, kReminderTimerId, 1000, nullptr);
      }
      return 0;

    case WM_SIZE:
      ResizeWebView();
      return 0;

    case WM_DPICHANGED: {
      const auto* suggested = reinterpret_cast<RECT*>(lParam);
      SetWindowPos(window_, nullptr, suggested->left, suggested->top,
                   suggested->right - suggested->left,
                   suggested->bottom - suggested->top,
                   SWP_NOACTIVATE | SWP_NOZORDER);
      return 0;
    }

    case WM_GETMINMAXINFO:
      if (kind_ == WindowKind::Dashboard) {
        auto* limits = reinterpret_cast<MINMAXINFO*>(lParam);
        limits->ptMinTrackSize = {760, 560};
      }
      return 0;

    case WM_EXITSIZEMOVE:
      if (kind_ == WindowKind::Pet) {
        SnapPetToWorkArea();
        application_.SavePetPosition(window_);
      }
      return 0;

    case WM_DISPLAYCHANGE:
      if (kind_ == WindowKind::Pet) {
        SnapPetToWorkArea();
        application_.SavePetPosition(window_);
      }
      return 0;

    case WM_DWMCOMPOSITIONCHANGED:
      if (kind_ == WindowKind::Pet) {
        ConfigureTransparentHost();
      }
      return 0;

    case WM_TIMER:
      if (kind_ == WindowKind::Pet && wParam == kReminderTimerId) {
        application_.HandleTimer();
      } else if (kind_ == WindowKind::Pet &&
                 wParam == kPresentationTimerId) {
        UpdatePresentationAnimation();
      } else if (kind_ == WindowKind::Pet &&
                 wParam == kAutoTuckTimerId) {
        UpdateAutoTuckAnimation();
      }
      return 0;

    case kTrayMessage:
      application_.HandleTrayMessage(lParam);
      return 0;

    case WM_ERASEBKGND:
      return 1;

    case WM_CLOSE:
      if (kind_ == WindowKind::Dashboard) {
        Hide();
      } else {
        application_.Quit();
      }
      return 0;

    case WM_DESTROY:
      if (kind_ == WindowKind::Pet) {
        KillTimer(window_, kReminderTimerId);
        KillTimer(window_, kPresentationTimerId);
        KillTimer(window_, kAutoTuckTimerId);
        PostQuitMessage(0);
      }
      return 0;

    default:
      return DefWindowProcW(window_, message, wParam, lParam);
  }
}

void WebViewWindow::InitializeWebView() {
  // WebView2 initialization is asynchronous; COM smart pointers keep every
  // object alive across the nested completion callbacks.
  const HRESULT result = CreateCoreWebView2EnvironmentWithOptions(
      nullptr, application_.WebViewDataDirectory().c_str(), nullptr,
      Microsoft::WRL::Callback<
          ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
          [this](HRESULT environmentResult,
                 ICoreWebView2Environment* environment) -> HRESULT {
            if (FAILED(environmentResult) || environment == nullptr) {
              ShowWebViewError(window_, L"创建 WebView2 环境",
                               environmentResult);
              return environmentResult;
            }

            environment_ = environment;
            auto controllerHandler = Microsoft::WRL::Callback<
                ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                [this](HRESULT controllerResult,
                       ICoreWebView2Controller* controller) -> HRESULT {
                  if (FAILED(controllerResult) || controller == nullptr) {
                    ShowWebViewError(window_, L"创建 WebView2 控件",
                                     controllerResult);
                    return controllerResult;
                  }

                  controller_ = controller;
                  controller_->get_CoreWebView2(&webView_);
                  ConfigureWebView();
                  ResizeWebView();
                  return S_OK;
                });

            // Newer runtimes support transparency at controller creation time.
            // ConfigureWebView applies a compatible fallback after creation.
            if (kind_ == WindowKind::Pet) {
              Microsoft::WRL::ComPtr<ICoreWebView2Environment10> environment10;
              Microsoft::WRL::ComPtr<ICoreWebView2ControllerOptions> options;
              if (SUCCEEDED(environment_.As(&environment10)) &&
                  environment10 != nullptr &&
                  SUCCEEDED(environment10->CreateCoreWebView2ControllerOptions(
                      &options)) &&
                  options != nullptr) {
                Microsoft::WRL::ComPtr<ICoreWebView2ControllerOptions3>
                    transparentOptions;
                if (SUCCEEDED(options.As(&transparentOptions)) &&
                    transparentOptions != nullptr) {
                  const COREWEBVIEW2_COLOR transparent{0, 0, 0, 0};
                  transparentOptions->put_DefaultBackgroundColor(transparent);
                  return environment10->CreateCoreWebView2ControllerWithOptions(
                      window_, options.Get(), controllerHandler.Get());
                }
              }
            }

            return environment_->CreateCoreWebView2Controller(
                window_, controllerHandler.Get());
          })
          .Get());

  if (FAILED(result)) {
    ShowWebViewError(window_, L"初始化 WebView2", result);
  }
}

void WebViewWindow::ConfigureTransparentHost() {
  if (window_ == nullptr || kind_ != WindowKind::Pet) {
    return;
  }
  const MARGINS glassMargins{-1, -1, -1, -1};
  DwmExtendFrameIntoClientArea(window_, &glassMargins);
}

void WebViewWindow::ConfigureWebView() {
  if (webView_ == nullptr) {
    return;
  }

  Microsoft::WRL::ComPtr<ICoreWebView2Settings> settings;
  if (SUCCEEDED(webView_->get_Settings(&settings)) && settings != nullptr) {
    settings->put_IsStatusBarEnabled(FALSE);
    settings->put_AreDefaultContextMenusEnabled(FALSE);
#ifdef NDEBUG
    settings->put_AreDevToolsEnabled(FALSE);
#else
    settings->put_AreDevToolsEnabled(TRUE);
#endif
  }

  if (kind_ == WindowKind::Pet) {
    Microsoft::WRL::ComPtr<ICoreWebView2Controller2> controller2;
    if (SUCCEEDED(controller_.As(&controller2)) && controller2 != nullptr) {
      const COREWEBVIEW2_COLOR transparent{0, 0, 0, 0};
      controller2->put_DefaultBackgroundColor(transparent);
    }
  }

  Microsoft::WRL::ComPtr<ICoreWebView2_3> webView3;
  if (SUCCEEDED(webView_.As(&webView3)) && webView3 != nullptr) {
    // Virtual HTTPS hosts give local assets a stable origin without running an
    // HTTP server. User characters receive a separate, read-only folder mapping.
    webView3->SetVirtualHostNameToFolderMapping(
        L"milo.local", application_.UiDirectory().c_str(),
        COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY_CORS);
    webView3->SetVirtualHostNameToFolderMapping(
        L"characters.local", application_.CharacterDirectory().c_str(),
        COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW);
  }

  EventRegistrationToken messageToken{};
  webView_->add_WebMessageReceived(
      Microsoft::WRL::Callback<ICoreWebView2WebMessageReceivedEventHandler>(
          [this](ICoreWebView2*,
                 ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
            LPWSTR rawMessage = nullptr;
            const HRESULT messageResult =
                args->get_WebMessageAsJson(&rawMessage);
            if (SUCCEEDED(messageResult) && rawMessage != nullptr) {
              try {
                application_.HandleWebMessage(*this, WideToUtf8(rawMessage));
              } catch (...) {
                CoTaskMemFree(rawMessage);
                return E_FAIL;
              }
              CoTaskMemFree(rawMessage);
            }
            return S_OK;
          })
          .Get(),
      &messageToken);

  webView_->Navigate(PageUrl().c_str());
}

void WebViewWindow::ResizeWebView() {
  if (controller_ == nullptr || window_ == nullptr) {
    return;
  }
  RECT bounds{};
  GetClientRect(window_, &bounds);
  controller_->put_Bounds(bounds);
}

void WebViewWindow::SnapPetToWorkArea() {
  if (kind_ != WindowKind::Pet || window_ == nullptr ||
      presentationState_ != PresentationState::Idle) {
    return;
  }

  RECT windowBounds{};
  if (!GetWindowRect(window_, &windowBounds)) {
    return;
  }
  const HMONITOR monitor =
      MonitorFromWindow(window_, MONITOR_DEFAULTTONEAREST);
  MONITORINFO monitorInfo{sizeof(monitorInfo)};
  if (!GetMonitorInfoW(monitor, &monitorInfo)) {
    return;
  }

  constexpr int snapDistance = 28;
  const int width = windowBounds.right - windowBounds.left;
  const int height = windowBounds.bottom - windowBounds.top;
  int x = ClampValue(windowBounds.left, monitorInfo.rcWork.left,
                     monitorInfo.rcWork.right - width);
  int y = ClampValue(windowBounds.top, monitorInfo.rcWork.top,
                     monitorInfo.rcWork.bottom - height);

  if (std::abs(x - monitorInfo.rcWork.left) <= snapDistance) {
    x = monitorInfo.rcWork.left;
  } else if (std::abs((x + width) - monitorInfo.rcWork.right) <=
             snapDistance) {
    x = monitorInfo.rcWork.right - width;
  }
  if (std::abs(y - monitorInfo.rcWork.top) <= snapDistance) {
    y = monitorInfo.rcWork.top;
  } else if (std::abs((y + height) - monitorInfo.rcWork.bottom) <=
             snapDistance) {
    y = monitorInfo.rcWork.bottom - height;
  }

  SetWindowPos(window_, nullptr, x, y, 0, 0,
               SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
}

void WebViewWindow::UpdateAutoTuckAnimation() {
  if (window_ == nullptr ||
      (autoTuckState_ != AutoTuckState::MovingOut &&
       autoTuckState_ != AutoTuckState::MovingIn)) {
    KillTimer(window_, kAutoTuckTimerId);
    return;
  }

  const ULONGLONG duration =
      autoTuckState_ == AutoTuckState::MovingOut ? 620 : 480;
  const double rawProgress = ClampValue(
      static_cast<double>(GetTickCount64() - autoTuckStarted_) /
          static_cast<double>(duration),
      0.0, 1.0);
  const double progress = EaseInOutCubic(rawProgress);
  const LONG x =
      Interpolate(autoTuckFrom_.left, autoTuckTo_.left, progress);
  const LONG y = Interpolate(autoTuckFrom_.top, autoTuckTo_.top, progress);
  SetWindowPos(window_, HWND_TOPMOST, x, y, 0, 0,
               SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);

  if (rawProgress < 1.0) {
    return;
  }
  SetWindowPos(window_, HWND_TOPMOST, autoTuckTo_.left, autoTuckTo_.top,
               0, 0, SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
  autoTuckState_ = autoTuckState_ == AutoTuckState::MovingOut
                       ? AutoTuckState::Tucked
                       : AutoTuckState::Visible;
  KillTimer(window_, kAutoTuckTimerId);
}

void WebViewWindow::ResetAutoTuck(bool restorePosition) {
  if (window_ == nullptr || kind_ != WindowKind::Pet ||
      autoTuckState_ == AutoTuckState::Visible) {
    return;
  }
  KillTimer(window_, kAutoTuckTimerId);
  if (restorePosition) {
    const LONG width =
        autoTuckRestBounds_.right - autoTuckRestBounds_.left;
    const LONG height =
        autoTuckRestBounds_.bottom - autoTuckRestBounds_.top;
    SetWindowPos(window_, nullptr, autoTuckRestBounds_.left,
                 autoTuckRestBounds_.top, width, height,
                 SWP_NOZORDER | SWP_NOACTIVATE);
  }
  autoTuckState_ = AutoTuckState::Visible;
}

void WebViewWindow::UpdatePresentationAnimation() {
  if (presentationState_ == PresentationState::Idle || window_ == nullptr) {
    KillTimer(window_, kPresentationTimerId);
    return;
  }

  const ULONGLONG now = GetTickCount64();
  // MovingIn -> Holding -> MovingOut -> Idle is the complete presentation
  // lifecycle. The lower-rate holding timer avoids unnecessary 60 FPS wakeups.
  if (presentationState_ == PresentationState::Holding) {
    if (now - presentationPhaseStarted_ >= kHoldDurationMs) {
      StartPresentationReturn(true);
    }
    return;
  }

  const ULONGLONG duration =
      presentationState_ == PresentationState::MovingIn
          ? MoveInDuration(presentationPriority_)
          : kMoveOutDurationMs;
  const double rawProgress = ClampValue(
      static_cast<double>(now - presentationPhaseStarted_) /
          static_cast<double>(duration),
      0.0, 1.0);
  const double progress = presentationState_ == PresentationState::MovingIn
                              ? EaseOutCubic(rawProgress)
                              : EaseInOutCubic(rawProgress);

  const LONG startWidth = animationFrom_.right - animationFrom_.left;
  const LONG startHeight = animationFrom_.bottom - animationFrom_.top;
  const LONG endWidth = animationTo_.right - animationTo_.left;
  const LONG endHeight = animationTo_.bottom - animationTo_.top;
  LONG x = Interpolate(animationFrom_.left, animationTo_.left, progress);
  LONG y = Interpolate(animationFrom_.top, animationTo_.top, progress);
  if (presentationState_ == PresentationState::MovingIn) {
    // The small arc gives normal/important reminders a playful hop. Urgent
    // reminders use a decaying horizontal shake for stronger visual emphasis.
    const double arcHeight = presentationPriority_ == "important" ? 42.0
                             : presentationPriority_ == "urgent" ? 18.0
                                                                  : 26.0;
    y -= static_cast<LONG>(
        std::lround(std::sin(rawProgress * 3.14159265) * arcHeight));
    if (presentationPriority_ == "urgent") {
      x += static_cast<LONG>(std::lround(
          std::sin(rawProgress * 6.0 * 3.14159265) *
          (1.0 - rawProgress) * 10.0));
    }
  }
  const LONG width = Interpolate(startWidth, endWidth, progress);
  const LONG height = Interpolate(startHeight, endHeight, progress);

  SetWindowPos(window_, HWND_TOPMOST, x, y, width, height,
               SWP_NOACTIVATE | SWP_SHOWWINDOW);

  if (rawProgress < 1.0) {
    return;
  }

  SetWindowPos(window_, HWND_TOPMOST, animationTo_.left, animationTo_.top,
               endWidth, endHeight, SWP_NOACTIVATE | SWP_SHOWWINDOW);
  if (presentationState_ == PresentationState::MovingIn) {
    presentationState_ = PresentationState::Holding;
    presentationPhaseStarted_ = now;
    KillTimer(window_, kPresentationTimerId);
    SetTimer(window_, kPresentationTimerId, 200, nullptr);
  } else {
    presentationState_ = PresentationState::Idle;
    KillTimer(window_, kPresentationTimerId);
  }
}

void WebViewWindow::StartPresentationReturn(bool notifyWebView) {
  RECT current{};
  if (!GetWindowRect(window_, &current)) {
    return;
  }
  animationFrom_ = current;
  animationTo_ = restBounds_;
  presentationState_ = PresentationState::MovingOut;
  presentationPhaseStarted_ = GetTickCount64();
  KillTimer(window_, kPresentationTimerId);
  SetTimer(window_, kPresentationTimerId, 16, nullptr);
  if (notifyWebView) {
    PostJson(R"({"type":"presentation.ended"})");
  }
}

std::wstring WebViewWindow::PageUrl() const {
  return kind_ == WindowKind::Pet
             ? L"https://milo.local/index.html?mode=pet"
             : L"https://milo.local/index.html?mode=dashboard";
}

}  // namespace milo
