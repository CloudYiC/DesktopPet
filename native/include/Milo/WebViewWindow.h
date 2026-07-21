#pragma once

#include <windows.h>
#include <wrl.h>

#include <string>

#include <WebView2.h>

namespace milo {

class Application;

enum class WindowKind { Pet, Dashboard };

class WebViewWindow final {
 public:
  WebViewWindow(Application& application, WindowKind kind);
  ~WebViewWindow();

  WebViewWindow(const WebViewWindow&) = delete;
  WebViewWindow& operator=(const WebViewWindow&) = delete;

  bool Create(HINSTANCE instance);
  void Show();
  void Hide();
  void SetTitle(const std::wstring& title);
  void BeginDrag();
  void BeginReminderPresentation(const std::string& priority);
  void EndReminderPresentation();
  void PostJson(const std::string& json);

  [[nodiscard]] HWND Handle() const { return window_; }
  [[nodiscard]] WindowKind Kind() const { return kind_; }
  [[nodiscard]] bool IsReady() const { return webView_ != nullptr; }

 private:
  static LRESULT CALLBACK WindowProc(HWND window, UINT message, WPARAM wParam,
                                     LPARAM lParam);
  LRESULT HandleMessage(UINT message, WPARAM wParam, LPARAM lParam);

  void InitializeWebView();
  void ResizeWebView();
  void ConfigureWebView();
  void ConfigureTransparentHost();
  void SnapPetToWorkArea();
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
  PresentationState presentationState_{PresentationState::Idle};
  RECT restBounds_{};
  RECT animationFrom_{};
  RECT animationTo_{};
  ULONGLONG presentationPhaseStarted_{};
  std::string presentationPriority_{"normal"};
};

}  // namespace milo
