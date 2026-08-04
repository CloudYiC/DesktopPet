# 可爱依依 · CloudYi Web

这是从旧 CloudYiCSC 迁入当前仓库的独立 Web 前端。它使用 React 18、Next.js、
TypeScript 和 SCSS Modules，并在构建时把可移植 C 工具核心编译成 WebAssembly。

## 本地开发

```powershell
cd web
npm install
npm run dev
```

打开 `http://localhost:3001`。首次启动会生成
`public/wasm/cloudyic-native.wasm`。

## 生产构建

```powershell
cd web
npm ci
npm run build
```

部署目录是 `web/out/`。详细的 Cloudflare Pages、Netlify、Vercel 和普通静态服务器
参数见 [`../docs/web-deployment.md`](../docs/web-deployment.md)。

## 功能边界

- 浏览器可运行 8 个 C/WebAssembly 工具和 4 个 TypeScript 工具。
- 系统中心、端口管理、提醒数据库、系统托盘和小助手窗口属于 Windows 原生能力，
  不会在 Web 端伪造。
- Web 工具输入只在浏览器内计算，不需要上传到服务端。
