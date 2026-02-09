/** @type {import('next').NextConfig} */
const repo = 'real-time-fund'; // 这里必须和你的 GitHub 仓库名一致
const isProd = process.env.NODE_ENV === 'production';

const nextConfig = {
  reactStrictMode: true,
  reactCompiler: true,

  // ✅ GitHub Pages 必须：静态导出
  output: 'export',

  // ✅ GitHub Pages 建议：目录形式路径更稳
  trailingSlash: true,

  // ✅ Pages 不支持 Next Image 优化
  images: { unoptimized: true },

  // ✅ 项目页子路径（生产环境启用）
  basePath: isProd ? `/${repo}` : '',
  assetPrefix: isProd ? `/${repo}/` : '',
};

module.exports = nextConfig;
