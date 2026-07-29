# 可爱依依桌面宠物

可爱依依是一只会动的原创卡通小鼠桌面宠物。它使用 C++17 提供 Windows 原生能力，使用 React 18 构建宠物与事项管理界面。

## 当前功能

- 透明、置顶、无边框的宠物窗口，不再显示黑色宿主背景
- 八个动作状态：待机、呼吸、眨眼、左右走动、挥手、跳跃和睡觉
- 挥手爱心、走路烟尘、跳跃星光与睡觉 `Z` 字等环境特效
- 点击头部会触发摸头、脸红和爱心反馈
- 白天佩戴元气小花，夜晚自动换上星星睡帽
- 拖动宠物、双击打开事项中心
- “今天”“全部事项”“宠物状态”三个可切换的真实视图
- 状态页可让宠物挥手、跳一下、散步、休息或接受摸头，并显示事项统计
- 角色衣柜：上传、预览、切换、改名和删除自定义角色
- 单张透明 PNG/WebP 可自动模拟待机、挥手、跳跃、散步、睡觉和摸头动作
- 支持与内置角色相同规范的 `4×2` 动作精灵图，切换专门动作帧
- 独立“设置”页面集中管理角色衣柜、宠物名字、声音和桌面行为
- 支持无人操作 `1/2/5/10/20/30/60 分钟`后平滑缩到最近屏幕边缘
- 恢复鼠标键盘操作或提醒到点时，宠物会自动从边缘回来
- 到点提醒采用左右分栏：角色完整显示在左侧，提醒牌位于右侧，二者不再互相遮挡
- 单图角色的普通提醒气泡会贴近头顶，并把气泡尾巴对准角色，减少悬空感
- 状态页互动会同时驱动状态卡和桌面角色，并高亮当前动作；连续点击同一动作也会重新播放
- 可随时修改宠物名字；窗口标题、气泡、托盘和提醒会同步更新
- 提醒音与 Windows 语音播报可分别开启或关闭
- 新增、完成、删除和延后提醒
- 每天、工作日和每周重复提醒；完成后自动顺延
- SQLite 本地存储与每秒提醒调度
- WebView2 JSON 双向通信
- Windows 原生提醒提示与系统托盘菜单，窗口、托盘、程序和安装包统一使用可爱依依图标
- 到点后从当前屏幕位置弧线跳入屏幕中央，放大并举起动态文字牌
- 日常、重要、紧急三档事项拥有不同颜色、速度、轨迹和举牌动画
- 举牌时包含聚光、星光和循环跳跃，可直接完成或延后 5 分钟
- 举牌展示 12 秒后会自动收起，并平滑返回原来的窗口位置
- 完成事项时，宠物窗口与事项中心都会播放撒花庆祝动画
- 记住宠物位置，并在靠近屏幕边缘时自动吸附
- 单实例保护，重复启动时直接打开已有事项中心
- 事项中心按需加载，减少平时常驻资源占用
- 首次启动时展示事项中心

## 技术栈

- C++17、Win32、WebView2、SQLite、CMake
- React 18、TypeScript、Vite
- SCSS Modules；所有组件样式均为 `*.module.scss`

代码注释遵循以下约定：

- C++ 公共接口使用 Doxygen 风格文档注释
- TypeScript 数据契约和桥接 API 使用 JSDoc
- 实现代码只说明状态机、安全边界、兼容迁移和其他不直观的设计原因
- 不为明显的赋值、条件判断和样式规则添加重复代码含义的注释

## 构建

需要 Visual Studio 2022 C++ 工具链、CMake、Node.js 18 或更高版本，以及 WebView2 Runtime。

```powershell
.\scripts\build.ps1 -Configuration Debug
```

脚本会从官方来源下载固定版本的 WebView2 SDK、SQLite amalgamation 与 nlohmann/json，然后构建前端和 C++ 程序。生成的程序位于：

```text
out/build/native/Debug/CuteYiyiDesktopPet.exe
```

构建时会先调用 `scripts/generate-app-icons.ps1`，从内置小鼠精灵图的第一帧生成：

```text
frontend/public/assets/app-icon.png
native/resources/CuteYiyiDesktopPet.ico
```

ICO 内含 `16/20/24/32/40/48/64/128/256` 像素帧，分别供资源管理器、窗口、
任务栏、系统托盘、安装程序和卸载程序选用。需要调整品牌图标时，应修改生成脚本
或源精灵图并重新运行脚本，不需要手工编辑二进制 ICO。

构建 Release 版本：

```powershell
.\scripts\build.ps1 -Configuration Release
```

## 构建 Windows 安装版

一键构建 Release 程序和安装包：

```powershell
.\scripts\build-installer.ps1
```

首次运行脚本会从 Chocolatey 社区审核包获取 NSIS 3.12，并校验官方安装程序的
固定 SHA-256；同时下载微软官方 Visual C++ x64 运行库和 WebView2 Evergreen
Bootstrapper，两个微软前置程序在打包前都会验证数字签名。
生成结果位于：

```text
out/dist/CuteYiyiDesktopPet-Setup-0.8.0.exe
```

安装包支持 Windows 10/11 x64，并提供：

- 中文安装向导、安装目录选择和卸载程序
- 开始菜单与可选桌面快捷方式
- 可选开机自动启动
- 自动检测并安装 Visual C++ x64 运行库
- 自动检测并按需安装 WebView2 Evergreen Runtime
- 覆盖安装升级时自动关闭旧进程
- 卸载时保留 `%LOCALAPPDATA%/CuteYiyiDesktopPet/` 中的名称、设置和提醒

WebView2 Bootstrapper 只在目标电脑缺少运行时的情况下执行，并需要联网。
应用本身安装完成后可以离线使用。

## 在另一台电脑安装

把 `CuteYiyiDesktopPet-Setup-0.8.0.exe` 复制到 Windows 10/11 x64 电脑并双击，
按向导安装即可，不需要复制源码或 `ui` 文件夹。当前个人构建没有购买代码签名
证书，因此 Windows SmartScreen 可能显示“未知发布者”；确认安装包来自可信来源后，
可以选择“更多信息”继续运行。正式公开分发前建议为安装包添加 Authenticode 签名。

安装后可从桌面或开始菜单启动，也可以在“设置 → 应用 → 已安装的应用”中卸载。
覆盖安装新版会保留原有名称、设置和提醒。

## 开发前端

```powershell
cd frontend
npm install
npm run dev
```

浏览器预览支持本地模拟数据：

- `http://127.0.0.1:5173/?mode=pet`
- `http://127.0.0.1:5173/?mode=pet&demo=reminder`（开发环境举牌预览）
- `http://127.0.0.1:5173/?mode=dashboard`

实际运行时，React 通过 `window.chrome.webview` 与 C++ 通信，不会启动本地 HTTP 服务。

## 数据位置

提醒与 WebView2 用户数据保存在：

```text
%LOCALAPPDATA%/CuteYiyiDesktopPet/
```

自定义角色保存在：

```text
%LOCALAPPDATA%/CuteYiyiDesktopPet/Characters/
```

单图角色建议使用透明背景、角色居中且四周留少量空白的 PNG/WebP。动作精灵图采用
`4 列 × 2 行`：第一行依次为待机、眨眼、备用待机、向右走；第二行依次为向左走、
挥手、跳跃、睡觉。每一格必须等宽等高。

根据个人照片生成的角色只保存在用户本机，不会写入源码仓库或公开安装包。
`artifacts/` 已加入 Git 忽略规则。在其他电脑上可以打开“设置 → 角色衣柜”，
选择“单张透明图”后重新导入。

首次运行新版时会从旧的 `%LOCALAPPDATA%/MiloDesktopPet/` 复制已有提醒，旧数据不会删除。
迁移只会在新数据库尚未创建时执行，避免旧版 SQLite WAL 在后续启动时覆盖新保存的
名字、角色衣柜和自动收起设置。

小鼠素材是为本项目生成的原创资产，透明成品位于 `frontend/public/assets/milo-sprite.png`。
