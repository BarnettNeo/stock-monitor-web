import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'path';

export default defineConfig({
  plugins: [vue()],
  css: {
    postcss: './postcss.config.js',
  },
  resolve: {
    alias: {
      '@asstes': path.resolve(__dirname, '../asstes'),
    },
  },
  server: {
    // 允许通过本机 IP（如 192.168.x.x:5173）访问开发服务
    host: '0.0.0.0',
    port: 5173,
    fs: {
      allow: [path.resolve(__dirname, '..')],
    },
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
