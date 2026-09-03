# 云依助手

云依助手是一套带有会动角色“粉色依依”的本地优先 Windows 助手与工具工作台。项目使用 C 与 C++11 提供 Windows 原生能力，使用 React 18 构建角色、事项与工具界面。

## 当前功能

- 透明、置顶、无边框的宠物窗口，不再显示黑色宿主背景
- 八个动作状态：待机、呼吸、眨眼、左右走动、挥手、跳跃和睡觉
- 挥手爱心、走路烟尘、跳跃星光与睡觉 `Z` 字等环境特效
- 单击角色后按需弹出云朵菜单，可选择打开工作台或挥手、跳跃、散步、摸头和休息
- 白天佩戴元气小花，夜晚自动换上星星睡帽
- 拖动角色可移动位置；点击与拖动使用位移阈值区分，避免误触
- 移动时由应用绘制圆角炫彩流光轮廓，不再显示 Windows 原生黑色拖动框
- “今天”“全部事项”“宠物状态”三个可切换的真实视图
- 状态页可让宠物挥手、跳一下、散步、休息或接受摸头，并显示事项统计
- 角色衣柜：上传、预览、切换和删除自定义款式；改名集中在唯一的“小助手名字”入口
- 私有安装包包含不可删除的“粉色依依”并将其设为首次启动默认角色；经典小鼠仍可切换
- 从旧版覆盖升级时，旧默认小鼠会一次性切换为小女孩；自定义角色和后续手动选择会保留
- 与内置图片完全相同的旧自定义角色会自动合并，衣柜不再出现两个粉色角色
- 单张透明 PNG/WebP 可自动模拟待机、挥手、跳跃、散步、睡觉和摸头动作
- 支持与内置角色相同规范的 `4×2` 动作精灵图，切换专门动作帧
- 独立“设置”页面集中管理角色衣柜、小助手名字、声音和桌面行为
- 支持无人操作 `1/2/5/10/20/30/60 分钟`后平滑缩到最近屏幕边缘
- 恢复鼠标键盘操作或提醒到点时，宠物会自动从边缘回来
- 到点提醒采用左右分栏：角色完整显示在左侧，提醒牌位于右侧，二者不再互相遮挡
- 单图角色的普通提醒气泡会贴近头顶，并把气泡尾巴对准角色，减少悬空感
- 状态页互动会同时驱动状态卡和桌面角色，并高亮当前动作；连续点击同一动作也会重新播放
- 可随时修改小助手名字；窗口标题、气泡、托盘和提醒会同步更新
- 提醒音与 Windows 语音播报可分别开启或关闭
- 新增、完成、删除和延后提醒
- 每天、工作日和每周重复提醒；完成后自动顺延
- SQLite 本地存储与每秒提醒调度
- WebView2 JSON 双向通信
- Windows 原生提醒提示与系统托盘菜单，窗口、托盘、程序和安装包统一使用云依助手图标
- 切换衣柜角色后，窗口、任务栏、托盘和已安装的桌面快捷方式会使用当前角色生成的图标
- 到点后从当前屏幕位置弧线跳入屏幕中央，放大并举起动态文字牌
- 日常、重要、紧急三档事项拥有不同颜色、速度、轨迹和举牌动画
- 举牌时包含聚光、星光和循环跳跃，可直接完成或延后 5 分钟
- 举牌展示 12 秒后会自动收起，并平滑返回原来的窗口位置
- 完成事项时，宠物窗口与事项中心都会播放撒花庆祝动画
- 记住宠物位置，并在靠近屏幕边缘时自动吸附
- 单实例保护，重复启动时直接打开已有云依助手
- 打开云依助手时暂时隐藏桌面角色；最小化不会恢复，关闭主界面后才重新出现
- 工作台打开期间的到时事项仍会提示音、托盘通知并更新列表，关闭工作台后再由角色演出提醒
- 云依助手主界面按需加载，减少平时常驻资源占用
- 首次启动时展示云依助手主界面
- 云依工具分类位于侧边栏顶部，宠物功能随后排列，模块管理与助手设置固定在底部；代码与数据库工具统一归入“数据处理”，图片转换统一归入“文件处理”，不再显示独立代码、AI、图片或数据库分类
- 已内置 JSON 格式化、正则表达式、文本比较、Base64、Hex、URL 编解码、MD5 与 SHA-256
- 网络与协议中提供十六进制报文分析器：可粘贴普通 Hex 或 Wireshark hexdump，按偏移查看 Ethernet、VLAN、ARP、IPv4/IPv6、TCP、UDP、ICMP 与未知载荷，并为私有协议保存自定义字段
- 已内置数字格式化、Unix 时间戳转换、UUID v4/v7 和安全密码生成器
- Base64、Hex、URL、MD5 和 SHA-256 使用可迁移的纯 C 核心；Win32、WebView2 与 JSON 桥接保留在 C++11 边界
- UUID 和密码由 Windows 系统安全随机源提供随机字节，再交给纯 C 核心完成格式和字符规则
- 模块管理只展示已经可用的内置工具；助手设置包含三套浅色主题、界面字号、上次页面恢复、模块状态、本机数据概览和版本信息
- 系统中心只读显示 Windows 版本、设备与 BIOS、CPU 核心、内存/提交量、系统盘、显卡与屏幕、网络、时区、电源和持续运行时间
- 端口管理显示 IPv4 TCP/UDP、本地/远端地址、连接状态、PID 和进程名称
- 结束端口占用进程需要明确二次确认；原生层会重新核对端口归属并拒绝关键 Windows 进程
- 软件卸载读取 Windows 已注册软件并显示完整注册表来源；缺少 `InstallLocation` 时可从有效的 `DisplayIcon`/`UninstallString` 推断程序目录，随后启动软件自带卸载程序并逐项审核残留
- 关联扫描不维护按软件名称编写的目录表；它通用组合卸载注册名称、注册项键名、有效 EXE 的产品/公司信息、安装目录、受限的 AppData/ProgramData/Profile 目录及开始菜单名称，并为结果标注依据和可信度
- 残留清理不接受任意路径或通配符，拒绝用户根目录和 Windows/Program Files/AppData 根目录；个人配置默认不勾选，完整输入软件名称并二次确认后才移入回收站
- 数据库工作室可通过 Windows 原生文件选择器打开或新建 SQLite 数据库，浏览表、视图、索引、触发器和列结构
- SQL 编辑器默认由原生层强制只读，支持多语句、查询结果表格、500 行显示上限、执行耗时和变更统计；写入必须显式开启并在执行前再次确认
- 图片转换器支持本地拖放和双栏预览，可缩放、保持比例、旋转、翻转、调整 JPEG/WebP 质量，并导出 PNG、JPEG、WebP 或 ICO
- “全部事项”承担统一事项管理：搜索、状态/优先级筛选，并按超时、今天、明天、未来 7 天和以后自动分组；不再重复设置效率文档或项目看板
- 模块管理支持搜索、权限说明以及内置工具的启用和停用，状态保存在本地 WebView2 配置中
- 工具分类页沿用 CloudYiCSC 的紧凑目录：搜索、状态筛选、Local/Available 标记以及 Open/Enable 操作

## 技术栈

- C11 兼容的可移植算法核心、C++11、Win32、WebView2、SQLite、CMake
- React 18、TypeScript、Vite
- SCSS Modules；所有组件样式均为 `*.module.scss`

项目优先把与平台无关的字节、编码和摘要算法保留为 C 接口。目前 Base64、Hex、
URL 编解码、MD5、SHA-256、报文解析、数字、时间戳、UUID 和密码规则位于 `native/c_core/`，
可供后续 CloudYiCSC 模块直接迁移。
SQLite 的官方 `sqlite3.c` 仍作为单独的 C 语言第三方库编译。窗口生命周期、路径、
UTF-8 转换、WebView2 通信和 JSON 请求分发等需要 RAII 或 Windows 对象管理的部分使用
C++11；React 不直接调用 C，而是经过一层受允许列表保护的 C++11 适配器。

原生代码不依赖 C++14/17 的
`std::filesystem`、`std::optional`、`std::clamp` 或 `std::make_unique`。
每次执行构建脚本时，`scripts/check-cxx11.ps1` 会先检查项目自有原生源码，防止
这些高版本语法或 API 被意外重新引入。

代码注释遵循以下约定：

- C++ 公共接口使用 Doxygen 风格文档注释
- TypeScript 数据契约和桥接 API 使用 JSDoc
- 实现代码只说明状态机、安全边界、兼容迁移和其他不直观的设计原因
- 不为明显的赋值、条件判断和样式规则添加重复代码含义的注释

CloudYiCSC 的界面顺序、C/C++11 边界、已完成工具和后续迁移规则见
[`docs/cloudyi-integration.md`](docs/cloudyi-integration.md)。
报文识别模式、自定义协议边界与两端实现说明见
[`docs/packet-inspector.md`](docs/packet-inspector.md)。
系统信息范围、端口结束进程保护和模块启停边界见
[`docs/system-permissions.md`](docs/system-permissions.md)，数据库文件与 SQL 安全边界见
[`docs/database-studio.md`](docs/database-studio.md)，图片输入输出边界见
[`docs/image-converter.md`](docs/image-converter.md)，软件卸载与残留清理边界见
[`docs/software-uninstaller.md`](docs/software-uninstaller.md)。

## 构建

需要 Visual Studio 2022 C++ 工具链、CMake、Node.js 18 或更高版本，以及 WebView2 Runtime。

```powershell
.\scripts\build.ps1 -Configuration Debug
```

脚本会从官方来源下载固定版本的 WebView2 SDK、SQLite amalgamation 与 nlohmann/json，然后构建 React 前端、C 核心和 C++11 宿主程序。生成的程序位于：

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
out/dist/CloudYiAssistant-Setup-0.11.6.exe
```

安装包支持 Windows 10/11 x64，并提供：

- 中文安装向导、安装目录选择和卸载程序
- 开始菜单与可选桌面快捷方式
- 可选开机自动启动
- 自动检测并安装 Visual C++ x64 运行库
- 自动检测并按需安装 WebView2 Evergreen Runtime
- 覆盖安装升级时自动关闭旧进程
- 卸载时一并清除名称、设置、提醒、自定义角色以及旧版迁移数据

WebView2 Bootstrapper 只在目标电脑缺少运行时的情况下执行，并需要联网。
应用本身安装完成后可以离线使用。

## 在另一台电脑安装

把 `CloudYiAssistant-Setup-0.11.6.exe` 复制到 Windows 10/11 x64 电脑并双击，
按向导安装即可，不需要复制源码或 `ui` 文件夹。当前个人构建没有购买代码签名
证书，因此 Windows SmartScreen 可能显示“未知发布者”；确认安装包来自可信来源后，
可以选择“更多信息”继续运行。正式公开分发前建议为安装包添加 Authenticode 签名。

安装后可从桌面或开始菜单启动，也可以在“设置 → 应用 → 已安装的应用”中卸载。
覆盖安装新版会保留原有名称、设置和提醒；执行卸载则会删除
`%LOCALAPPDATA%/CuteYiyiDesktopPet/` 与旧版 `%LOCALAPPDATA%/MiloDesktopPet/`
中的全部应用数据，卸载后无法恢复。

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

## Web 部署版

旧 CloudYiCSC 的 Web 前端已经迁入 `web/`，并改造成不依赖旧 monorepo、Go 或
Wails 的独立 React 18 静态站点。它保留 13 个可直接在浏览器运行的工具，其中
Base64、Hex、URL、MD5、SHA-256、UUID、密码、时间戳和数字格式化复用 C/WebAssembly；
十六进制报文分析器使用同等的浏览器本地解析与字节可视化，不上传报文内容。

```powershell
.\scripts\build-web.ps1
```

静态部署产物位于 `web/out/`。可将该目录部署到 Cloudflare Pages、Netlify、
Vercel 或普通静态服务器；平台参数和 Web/桌面功能边界见
[`docs/web-deployment.md`](docs/web-deployment.md)。

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

本机私有默认角色放在 `artifacts/private-characters/default-girl.png`，`artifacts/`
已加入 Git 忽略规则，因此图片不会进入源码仓库。构建脚本只把存在于本机的该图片
复制进生成目录和个人安装包；缺少私有图片的公开源码构建会自动使用经典小鼠。
其他用户上传的角色仍只保存在本机，也可以在“设置 → 角色衣柜”重新导入。

首次运行新版时会从旧的 `%LOCALAPPDATA%/MiloDesktopPet/` 复制已有提醒，旧数据不会删除。
迁移只会在新数据库尚未创建时执行，避免旧版 SQLite WAL 在后续启动时覆盖新保存的
名字、角色衣柜和自动收起设置。

小鼠素材是为本项目生成的原创资产，透明成品位于 `frontend/public/assets/milo-sprite.png`。
