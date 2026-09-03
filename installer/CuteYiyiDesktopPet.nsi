Unicode True

; Modern UI, conditional-flow, OS-version and x64 helper macros.
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "WinVer.nsh"
!include "x64.nsh"

!ifndef APP_VERSION
  !define APP_VERSION "0.11.6"
!endif
!ifndef APP_FILE_VERSION
  !define APP_FILE_VERSION "0.11.6.0"
!endif
!ifndef APP_SOURCE
  !error "APP_SOURCE must point to the Release application directory."
!endif
!ifndef APP_ICON
  !error "APP_ICON must point to the application ICO file."
!endif
!ifndef PREREQ_SOURCE
  !error "PREREQ_SOURCE must point to the prerequisite cache directory."
!endif
!ifndef OUTPUT_DIR
  !error "OUTPUT_DIR must point to the installer output directory."
!endif

!define APP_NAME "云依助手"
!define APP_EXE "CuteYiyiDesktopPet.exe"
!define APP_ID "CuteYiyiDesktopPet"
!define APP_PUBLISHER "云依助手项目"
!define APP_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}"
!define WEBVIEW2_CLIENT_ID "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

; Product identity and package-level branding.
Name "${APP_NAME}"
OutFile "${OUTPUT_DIR}\CloudYiAssistant-Setup-${APP_VERSION}.exe"
InstallDir "$PROGRAMFILES64\CuteYiyiDesktopPet"
InstallDirRegKey HKLM "${APP_UNINSTALL_KEY}" "InstallLocation"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
SetCompressorDictSize 32
SetOverwrite on
ShowInstDetails show
ShowUninstDetails show
BrandingText "${APP_NAME}"
Icon "${APP_ICON}"
UninstallIcon "${APP_ICON}"

VIProductVersion "${APP_FILE_VERSION}"
VIAddVersionKey /LANG=2052 "ProductName" "${APP_NAME}"
VIAddVersionKey /LANG=2052 "ProductVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=2052 "CompanyName" "${APP_PUBLISHER}"
VIAddVersionKey /LANG=2052 "FileDescription" "${APP_NAME}安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "Copyright (c) 2026"

!define MUI_ABORTWARNING
!define MUI_ICON "${APP_ICON}"
!define MUI_UNICON "${APP_ICON}"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "启动${APP_NAME}"
!define MUI_UNCONFIRMPAGE_TEXT_TOP "卸载将永久删除提醒、名称、自定义角色和本机设置，删除后无法恢复。"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

; Refuse unsupported systems before any filesystem changes occur.
Function .onInit
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "云依助手需要 Windows 10 或更高版本。"
    Abort
  ${EndIf}
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "当前安装包仅支持 64 位 Windows。"
    Abort
  ${EndIf}
FunctionEnd

Function CloseRunningApp
  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /F /T /IM ${APP_EXE}'
  Pop $0
  Pop $1
FunctionEnd

Function IsVCRuntimeInstalled
  SetRegView 64
  ClearErrors
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  ${IfNot} ${Errors}
  ${AndIf} $0 = 1
    Push 1
  ${Else}
    Push 0
  ${EndIf}
FunctionEnd

Function IsWebView2Installed
  SetRegView 32
  ClearErrors
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2_CLIENT_ID}" "pv"
  ${If} ${Errors}
  ${OrIf} $0 == ""
  ${OrIf} $0 == "0.0.0.0"
    ClearErrors
    ReadRegStr $0 HKCU "Software\Microsoft\EdgeUpdate\Clients\${WEBVIEW2_CLIENT_ID}" "pv"
  ${EndIf}

  ${IfNot} ${Errors}
  ${AndIf} $0 != ""
  ${AndIf} $0 != "0.0.0.0"
    Push 1
  ${Else}
    Push 0
  ${EndIf}
  SetRegView 64
FunctionEnd

Section "-运行环境" SecPrerequisites
  SectionIn RO
  SetOutPath "$PLUGINSDIR"

  Call IsVCRuntimeInstalled
  Pop $0
  ${If} $0 = 0
    DetailPrint "正在安装 Microsoft Visual C++ x64 运行库..."
    File "/oname=vc_redist.x64.exe" "${PREREQ_SOURCE}\vc_redist.x64.exe"
    ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /install /quiet /norestart' $1
    ${If} $1 != 0
    ${AndIf} $1 != 3010
    ${AndIf} $1 != 1638
      MessageBox MB_OK|MB_ICONSTOP "Microsoft Visual C++ 运行库安装失败，错误代码：$1"
      Quit
    ${EndIf}
  ${EndIf}

  Call IsWebView2Installed
  Pop $0
  ${If} $0 = 0
    DetailPrint "正在安装 Microsoft Edge WebView2 Runtime..."
    File "/oname=MicrosoftEdgeWebView2Setup.exe" "${PREREQ_SOURCE}\MicrosoftEdgeWebView2Setup.exe"
    ExecWait '"$PLUGINSDIR\MicrosoftEdgeWebView2Setup.exe" /silent /install' $1
    ${If} $1 != 0
    ${AndIf} $1 != 3010
      MessageBox MB_OK|MB_ICONSTOP "WebView2 Runtime 安装失败，错误代码：$1。请检查网络连接后重试。"
      Quit
    ${EndIf}
  ${EndIf}
SectionEnd

Section "!${APP_NAME}" SecApplication
  SectionIn RO
  Call CloseRunningApp
  SetRegView 64

  SetOutPath "$INSTDIR"
  File "${APP_SOURCE}\${APP_EXE}"
  RMDir /r "$INSTDIR\ui"
  SetOutPath "$INSTDIR\ui"
  File /r /x "*.map" "${APP_SOURCE}\ui\*.*"

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; Remove shortcut names created by earlier product identities.
  Delete "$DESKTOP\可爱依依桌面宠物.lnk"
  Delete "$DESKTOP\可爱依依小助手.lnk"
  Delete "$DESKTOP\依依工作台.lnk"
  Delete "$SMPROGRAMS\可爱依依桌面宠物\可爱依依桌面宠物.lnk"
  Delete "$SMPROGRAMS\可爱依依桌面宠物\卸载可爱依依桌面宠物.lnk"
  RMDir "$SMPROGRAMS\可爱依依桌面宠物"
  Delete "$SMPROGRAMS\可爱依依小助手\可爱依依小助手.lnk"
  Delete "$SMPROGRAMS\可爱依依小助手\卸载可爱依依小助手.lnk"
  RMDir "$SMPROGRAMS\可爱依依小助手"
  Delete "$SMPROGRAMS\依依工作台\依依工作台.lnk"
  Delete "$SMPROGRAMS\依依工作台\卸载依依工作台.lnk"
  RMDir "$SMPROGRAMS\依依工作台"
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\卸载${APP_NAME}.lnk" "$INSTDIR\Uninstall.exe"

  WriteRegStr HKLM "${APP_UNINSTALL_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKLM "${APP_UNINSTALL_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKLM "${APP_UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKLM "${APP_UNINSTALL_KEY}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKLM "${APP_UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${APP_UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKLM "${APP_UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKLM "${APP_UNINSTALL_KEY}" "EstimatedSize" 4096
  WriteRegDWORD HKLM "${APP_UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${APP_UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Section "桌面快捷方式" SecDesktopShortcut
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"
SectionEnd

Section /o "开机自动启动" SecAutoStart
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_ID}" '"$INSTDIR\${APP_EXE}"'
SectionEnd

LangString DESC_SecPrerequisites ${LANG_SIMPCHINESE} "检测并安装应用需要的微软运行环境。"
LangString DESC_SecApplication ${LANG_SIMPCHINESE} "安装云依助手、内置工具模块和卸载程序。"
LangString DESC_SecDesktopShortcut ${LANG_SIMPCHINESE} "在桌面创建云依助手快捷方式。"
LangString DESC_SecAutoStart ${LANG_SIMPCHINESE} "登录 Windows 后自动启动云依助手。"

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecPrerequisites} $(DESC_SecPrerequisites)
  !insertmacro MUI_DESCRIPTION_TEXT ${SecApplication} $(DESC_SecApplication)
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktopShortcut} $(DESC_SecDesktopShortcut)
  !insertmacro MUI_DESCRIPTION_TEXT ${SecAutoStart} $(DESC_SecAutoStart)
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Function un.CloseRunningApp
  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /F /T /IM ${APP_EXE}'
  Pop $0
  Pop $1
FunctionEnd

Section "Uninstall"
  Call un.CloseRunningApp
  SetRegView 64

  Delete "$DESKTOP\${APP_NAME}.lnk"
  Delete "$DESKTOP\可爱依依桌面宠物.lnk"
  Delete "$DESKTOP\可爱依依小助手.lnk"
  Delete "$DESKTOP\依依工作台.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\卸载${APP_NAME}.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"
  Delete "$SMPROGRAMS\可爱依依桌面宠物\可爱依依桌面宠物.lnk"
  Delete "$SMPROGRAMS\可爱依依桌面宠物\卸载可爱依依桌面宠物.lnk"
  RMDir "$SMPROGRAMS\可爱依依桌面宠物"
  Delete "$SMPROGRAMS\可爱依依小助手\可爱依依小助手.lnk"
  Delete "$SMPROGRAMS\可爱依依小助手\卸载可爱依依小助手.lnk"
  RMDir "$SMPROGRAMS\可爱依依小助手"
  Delete "$SMPROGRAMS\依依工作台\依依工作台.lnk"
  Delete "$SMPROGRAMS\依依工作台\卸载依依工作台.lnk"
  RMDir "$SMPROGRAMS\依依工作台"

  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_ID}"
  DeleteRegKey HKLM "${APP_UNINSTALL_KEY}"

  ; Remove only this application's fixed current and legacy data directories.
  ; The legacy folder is included because older releases copied reminders from it.
  RMDir /r /REBOOTOK "$LOCALAPPDATA\CuteYiyiDesktopPet"
  RMDir /r /REBOOTOK "$LOCALAPPDATA\MiloDesktopPet"

  RMDir /r "$INSTDIR\ui"
  Delete "$INSTDIR\${APP_EXE}"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"

  IfSilent skipUninstallMessage
  MessageBox MB_OK|MB_ICONINFORMATION "云依助手已完全卸载，提醒、名称、角色和本机设置均已清除。"
  skipUninstallMessage:
SectionEnd
