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
- 可随时修改宠物名字；窗口标题、气泡、托盘和提醒会同步更新
- 提醒音与 Windows 语音播报可分别开启或关闭
- 新增、完成、删除和延后提醒
- 每天、工作日和每周重复提醒；完成后自动顺延
- SQLite 本地存储与每秒提醒调度
- WebView2 JSON 双向通信
- Windows 原生提醒提示与系统托盘菜单
- 到点后从当前屏幕位置弧线跳入屏幕中央，放大并举起动态文字牌
- 日常、重要、紧急三档事项拥有不同颜色、速度、轨迹和举牌动画
- 举牌时包含聚光、星光和循环跳跃，可直接完成或延后 5 分钟
- 12 秒没有操作会自动收起，并平滑返回原来的窗口位置
- 完成事项时，宠物窗口与事项中心都会播放撒花庆祝动画
- 记住宠物位置，并在靠近屏幕边缘时自动吸附
- 单实例保护，重复启动时直接打开已有事项中心
- 事项中心按需加载，减少平时常驻资源占用
- 首次启动时展示事项中心

## 技术栈

- C++17、Win32、WebView2、SQLite、CMake
- React 18、TypeScript、Vite
- SCSS Modules；所有组件样式均为 `*.module.scss`

## 构建

需要 Visual Studio 2022 C++ 工具链、CMake、Node.js 18 或更高版本，以及 WebView2 Runtime。

```powershell
.\scripts\build.ps1 -Configuration Debug
```

脚本会从官方来源下载固定版本的 WebView2 SDK、SQLite amalgamation 与 nlohmann/json，然后构建前端和 C++ 程序。生成的程序位于：

```text
out/build/native/Debug/CuteYiyiDesktopPet.exe
```

构建 Release 版本：

```powershell
.\scripts\build.ps1 -Configuration Release
```

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

首次运行新版时会从旧的 `%LOCALAPPDATA%/MiloDesktopPet/` 复制已有提醒，旧数据不会删除。

小鼠素材是为本项目生成的原创资产，透明成品位于 `frontend/public/assets/milo-sprite.png`。
