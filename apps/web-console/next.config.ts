import type { NextConfig } from 'next';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** API 代理见 middleware.ts（运行时读取 DAEMON_PROXY_TARGET），避免 build 固化错误端口 */
const nextConfig: NextConfig = {
  output: 'standalone',
  devIndicators: false,
  outputFileTracingRoot: repoRoot,
  eslint: { ignoreDuringBuilds: true }
};

export default nextConfig;
