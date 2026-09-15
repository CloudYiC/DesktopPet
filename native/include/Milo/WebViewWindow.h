#pragma once

/// @file
/// @brief Win32/WebView2 host used by the pet overlay and dashboard window.

#include <windows.h>
#include <wrl.h>

#include <string>

#include <WebView2.h>

namespace milo {

class Application;

/// Identifies which frontend surface a WebViewWindow hosts.
enum class WindowKind { Pet, Dashboard };

/// Hosts one WebView2 surface and owns its native window animations.
class WebViewWindow final {
 public:
  /// Creates an uninitialized window wrapper for the requested surface.
  WebViewWindow(Application& application, WindowKind kind);
  ~WebViewWindow();

  WebViewWindow(const WebViewWindow&) = delete;
  WebViewWindow& operator=(const WebViewWindow&) = delete;

  /// Registers/creates the Win32 window; WebView2 initializes asynchronously.
  bool Create(HINSTANCE instance);
  /// Shows the window without stealing focus for the desktop pet.
  void Show();
  /// Hides the window and closes its expanded shortcut menu first.
  void Hide();
  /// Updates the native title used by the taskbar and accessibility APIs.
  void SetTitle(const std::wstring& title);
  /// Replaces taskbar/window icons with the active assistant character.
  void SetIcons(HICON largeIcon, HICON smallIcon);
  /// Records the cursor/window origin for application-rendered pet dragging.
  void BeginDrag();
  /// Moves the pet window with the current cursor without native caption UI.
  void UpdateDrag();
  /// Finishes custom dragging, snaps to the work area and saves the position.
  void EndDrag();
  /// Animates an expanded reminder window into the monitor work area.
  void BeginReminderPresentation(const std::string& priority,
                                 HWND anchorWindow = nullptr);
  /// Returns the presentation window to its saved desktop position.
  void EndReminderPresentation();
  /// True through move-in, holding and return; an open dashboard must not hide it.
  bool IsReminderPresenting() const;
  /// Expands/closes the shortcut host without moving the character.
  void SetPetMenuOpen(bool open, const std::string& layout = "single");
  /// Sends a serialized JSON event to the hosted React application.
  void PostJson(const std::string& json);

  HWND Handle() const { return window_; }
  WindowKind Kind() const { return kind_; }
  bool IsReady() const { return webView_ != nullptr; }

 private:
  // Win32 message dispatch.
  static LRESULT CALLBACK WindowProc(HWND window, UINT message, WPARAM wParam,
                                     LPARAM lParam);
  LRESULT HandleMessage(UINT message, WPARAM wParam, LPARAM lParam);

  // WebView2 and native host setup.
  void InitializeWebView();
  void ResizeWebView();
  void SyncWebViewVisibility();
  void ConfigureWebView();
  void ConfigureTransparentHost();
  void SnapPetToWorkArea();

  // Shortcut bounds are independent of the reminder presentation lifecycle.
  void UpdatePresentationAnimation();
  void StartPresentationReturn(bool notifyWebView);
  std::wstring PageUrl() const;

  enum class PresentationState { Idle, MovingIn, Holding, MovingOut };

  Application& application_;
  WindowKind kind_;
  HWND window_{};
  Microsoft::WRL::ComPtr<ICoreWebView2Environment> environment_;
  Microsoft::WRL::ComPtr<ICoreWebView2Controller> controller_;
  Microsoft::WRL::ComPtr<ICoreWebView2> webView_;
  // Animation bounds are stored in physical screen pixels.
  PresentationState presentationState_{PresentationState::Idle};
  bool petMenuOpen_{};
  RECT petMenuRestBounds_{};
  bool petMenuSingle_{true};
  UINT petMenuDpi_{96};
  RECT restBounds_{};
  RECT animationFrom_{};
  RECT animationTo_{};
  ULONGLONG presentationPhaseStarted_{};
  std::string presentationPriority_{"normal"};
  bool manualDragActive_{};
  POINT manualDragStartCursor_{};
  RECT manualDragStartBounds_{};
};

}  // namespace milo
