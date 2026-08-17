import type { Metadata } from 'next'
import Link from 'next/link'
import { SITE_NAME_EN, SITE_NAME_ZH } from '../../lib/site'
import { FaqToc } from './FaqToc'
import styles from './faq.module.scss'

export const metadata: Metadata = {
  title: 'FAQ',
  description: `${SITE_NAME_ZH} / ${SITE_NAME_EN} 的 Web 构建、WebAssembly、桌面边界与静态部署说明。`,
  alternates: { canonical: '/faq/' },
}

const SECTIONS = [
  { id: 'web-run', label: '运行 Web 前端' },
  { id: 'web-tools', label: '浏览器工具' },
  { id: 'desktop-boundary', label: '桌面能力边界' },
  { id: 'deployment', label: '静态部署' },
  { id: 'privacy', label: '隐私与数据' },
]

export default function FaqPage() {
  return (
    <div className={styles.page}>
      <FaqToc sections={SECTIONS} />

      <article className={styles.body}>
        <header className={styles.header}>
          <h1 className={styles.title}>Web 前端常见问题</h1>
          <p className={styles.subtitle}>
            这套站点从旧 CloudYiCSC 前端迁移而来，现已成为当前仓库中独立、可静态部署的
            React 18 应用，不依赖桌面程序才能打开。
          </p>
        </header>

        <section id="web-run" className={styles.section}>
          <h2>如何在本地运行 Web 前端？</h2>
          <pre className={styles.code}>{`cd web
npm install
npm run dev`}</pre>
          <p>
            开发地址是 <code>http://localhost:3001</code>。首次启动会先把可复用的 C
            算法编译成 WebAssembly。
          </p>
        </section>

        <section id="web-tools" className={styles.section}>
          <h2>哪些工具能直接在浏览器里运行？</h2>
          <p>
            Hash、Base64、Hex、URL 编解码、UUID、密码、时间戳和数字格式化通过
            C/WebAssembly 运行；JSON、JWT、正则和文本比较使用 TypeScript。
          </p>
          <p>这些工具不会为了计算而把输入发送到服务器。</p>
        </section>

        <section id="desktop-boundary" className={styles.section}>
          <h2>为什么网页里没有系统中心和端口管理？</h2>
          <p>
            浏览器无权读取 Windows 进程、端口占用、系统托盘、提醒数据库或小助手窗口。
            这些能力只存在于 C/C++11 Windows 客户端。Web 端保留工具目录和可在浏览器安全
            运行的工具，不伪造原生数据。
          </p>
        </section>

        <section id="deployment" className={styles.section}>
          <h2>如何生成部署文件？</h2>
          <pre className={styles.code}>{`cd web
npm ci
npm run build
# deploy the web/out directory`}</pre>
          <p>
            <code>out</code> 是纯静态目录，可部署到 Cloudflare Pages、Netlify、Vercel
            或普通静态文件服务器。详细参数见仓库中的 Web 部署说明。
          </p>
        </section>

        <section id="privacy" className={styles.section}>
          <h2>网页会读取桌面端的提醒或角色图片吗？</h2>
          <p>
            不会。桌面端数据保存在用户本机的 <code>%LOCALAPPDATA%/CuteYiyiDesktopPet</code>；
            静态网站没有访问该目录的权限。后续若增加账号同步，会单独设计 API、授权和隐私边界。
          </p>
        </section>

        <div className={styles.cta}>
          <p>需要 Windows 提醒、系统工具或依依工作台？</p>
          <Link href="/desktop" className={styles.ctaLink}>
            查看桌面版
          </Link>
        </div>
      </article>
    </div>
  )
}
