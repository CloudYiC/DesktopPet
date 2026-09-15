# 完整离线 Windows 安装包（0.13.16）

## 内网电脑如何使用

在能下载文件的电脑取得 `CloudYiAssistant-Setup-0.13.16.exe`，通过 U 盘复制到目标电脑，
双击并按向导安装。只需这一个文件，无需源码、界面目录或另行下载运行库。
系统范围仍为 Windows 10/11 x64，需要管理员权限、临时目录/安装目录可写及足够空间。
这不是免安装版，也不增加 Windows 7、XP 或 macOS 支持，不绕过公司的应用控制策略。

## 包内包含什么

- 云依助手原生程序和完整生产界面资源。
- Microsoft Visual C++ x64 Redistributable 完整安装程序。
- Microsoft Edge WebView2 Runtime x64 **Evergreen Standalone Installer**。

离线安装使用微软完整包，而非下载时约 2 MB 的 Evergreen Bootstrapper。
官方依据：[微软离线部署说明](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution#offline-deployment)。
首次构建仍需在开发电脑下载依赖，缓存可复用；接收方安装时没有外网下载前置组件的步骤。
安装完成后的网络调试仍需要与用户指定的内网设备连通，和安装依赖下载无关。

## 失败与重启

安装器先只读检测已安装运行库；缺失时将包内副本解压到临时目录并静默安装。
不会为此卸载或降级已有微软共享运行库。每项安装后再次检测是否已注册。
解压失败、程序不能启动、非成功退出码或未检测到运行库时终止，返回 `1603`，不替换应用文件。
若前置组件安装完成但要求重启，安装器返回 `3010`，完成页默认选择稍后重启，并不提供立即启动应用。
若要求重启而运行库仍未就绪，则明确提示此次安装未完成，重启后重新运行同一离线包。

## 完整性与发布

构建脚本校验两个前置安装程序的 Microsoft Authenticode 签名；WebView2 另检查完整包文件名
和体积下限，防止缓存旧 Bootstrapper 被误用。下载中断时只留下 `.partial`，不冒充有效缓存。
并生成 `CloudYiAssistant-Setup-0.13.15.exe.manifest.json`，记录最终 EXE 和两项前置组件的
实际大小、SHA-256、安装器包装版本及签名主体；包装版本不等于内部浏览器版本。

完整离线 EXE 超过 GitHub 普通 Git 文件限制，使用 Git LFS 保存本版二进制；旧版本不迁移。
网页下载地址应使用实际大文件下载地址，不得将 Git LFS 指针文本当成安装包。
源码克隆需要 Git LFS 才会取回完整 EXE；普通用户使用发布说明中的直接下载链接即可。

## 验证边界

安装分支测试不执行真实安装器或修改注册表；真实产物另行解包核对嵌入的完整载荷及 SHA-256。
构建/解包验证与在全新断网 Windows 虚拟机中的安装验收不同，不能混称为已实机验证。

0.13.15 已通过 21 个合成安装分支场景（已有/缺失依赖、解压或启动失败、非零错误、安装后
未注册、重启返回码）、前端生产构建、网页类型检查、原生 Release 和 12 项 CTest。
11 个 Release 界面文件与前端产物哈希一致。独立解包确认微软完整载荷内含 WebView2
153.0.4234.32 的 x64 安装程序、浏览器 EXE/DLL、ICU 数据与 V8 snapshot，并核对内层清单哈希。
正式 NSIS 安装包完整性检查通过，解出的两个前置 EXE 与构建缓存及发布清单的大小、SHA-256
逐项一致。完整包为 237,276,551 字节（约 237 MB）。
本次没有在用户电脑安装/卸载运行库，也没有在全新断网 Windows 虚拟机执行安装验收。

可重复执行的验证命令（`-SevenZipPath` 指向可信的完整 7-Zip CLI，脚本不自行下载工具）：

```powershell
node scripts/test-offline-installer.cjs
./scripts/test-offline-payload.ps1 -Installer ./out/dist/CloudYiAssistant-Setup-0.13.16.exe -SevenZipPath 'C:/Program Files/7-Zip/7z.exe'
```

第二条命令只测试和解包到新建的 `out/verification` 子目录，不执行包内程序；同时核对
同目录 `.exe.manifest.json` 和 `out/installer/prerequisites` 内两个构建源文件。
