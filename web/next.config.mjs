import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const webRoot = dirname(fileURLToPath(import.meta.url))

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The generated `out` directory can be deployed to any static host.
  output: 'export',
  images: { unoptimized: true },
  trailingSlash: true,
  reactStrictMode: true,
  outputFileTracingRoot: resolve(webRoot, '..'),
  experimental: { externalDir: true },
  webpack(config) {
    // The shared workbench lives outside web/, but uses this app's dependencies.
    config.resolve.modules = [...(config.resolve.modules ?? ['node_modules']), resolve(webRoot, 'node_modules')]
    return config
  },
}

export default nextConfig
