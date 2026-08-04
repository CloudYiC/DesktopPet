# Web 前端迁移与部署

`web/` 是从 `C:\Users\Administrator\Desktop\CloudYiCSC\apps\web` 迁入的独立
React 18 前端。旧项目的 workspace 类型与 SCSS token 依赖已本地化，构建不再需要
CloudYiCSC 仓库，也不需要 Go 或 Wails。

## 构建产物

```powershell
cd web
npm ci
npm run build
```

构建会先使用 `clang-wasm` 把 `web/native/` 中的 C11 兼容核心编译为 WebAssembly，
然后执行 Next.js 静态导出。最终需要部署的目录是：

```text
web/out/
```

`out/` 中只有 HTML、CSS、JavaScript、字体、SVG 和 WASM 静态文件，不需要常驻
Node.js 服务。

## Cloudflare Pages

- Root directory：`web`
- Build command：`npm ci && npm run build`
- Build output directory：`out`
- Node.js：建议 20 LTS，最低 18.18
- 环境变量：`NEXT_PUBLIC_SITE_URL=https://你的域名`

## Netlify 或 Vercel

把项目根目录设置为 `web`，构建命令设置为 `npm ci && npm run build`，发布目录设置为
`out`。由于项目采用静态导出，不需要 Serverless Function。

## 普通静态服务器

把 `web/out/` 整个上传到站点根目录。服务器需要为 `.wasm` 返回
`application/wasm`，并保留各路由目录中的 `index.html`。不要只上传 `.next/`。

## Web 与桌面版边界

Web 端保留浏览器允许的工具目录和运行器。Hash、Base64、Hex、URL、UUID、密码、
时间戳和数字格式化复用 C/WebAssembly；JSON、JWT、正则和文本比较使用 TypeScript。
系统中心、端口管理、数据库工作室、插件本地登记、事项提醒、角色衣柜、系统托盘和
桌面窗口依赖 Win32/C++11，只在 Windows 安装版中提供。Web 版不模拟数据库文件
读写，以免浏览器预览与桌面版的原生路径和写入权限产生歧义。
