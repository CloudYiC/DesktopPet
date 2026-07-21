#include <windows.h>

#include <exception>

#include "Milo/Application.h"
#include "Milo/Utils.h"

int APIENTRY wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int showCommand) {
  HANDLE instanceMutex =
      CreateMutexW(nullptr, TRUE, L"Local\\MiloDesktopPet.Singleton.v1");
  if (instanceMutex == nullptr) {
    return 1;
  }
  if (GetLastError() == ERROR_ALREADY_EXISTS) {
    constexpr UINT trayMessage = WM_APP + 42;
    if (HWND existing = FindWindowW(L"MiloDesktopPet.WebViewWindow", nullptr);
        existing != nullptr) {
      PostMessageW(existing, trayMessage, 0, WM_LBUTTONDBLCLK);
    }
    CloseHandle(instanceMutex);
    return 0;
  }

  const HRESULT comResult = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  if (FAILED(comResult)) {
    MessageBoxW(nullptr, L"无法初始化 Windows COM 环境。", L"可爱依依桌面宠物",
                MB_OK | MB_ICONERROR);
    CloseHandle(instanceMutex);
    return 1;
  }

  int exitCode = 0;
  try {
    milo::Application application(instance);
    exitCode = application.Run(showCommand);
  } catch (const std::exception& error) {
    std::wstring message = L"启动失败：\n" + milo::Utf8ToWide(error.what());
    MessageBoxW(nullptr, message.c_str(), L"可爱依依桌面宠物",
                MB_OK | MB_ICONERROR);
    exitCode = 1;
  }

  CoUninitialize();
  ReleaseMutex(instanceMutex);
  CloseHandle(instanceMutex);
  return exitCode;
}
