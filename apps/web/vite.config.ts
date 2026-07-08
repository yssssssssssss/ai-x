import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// dev 时把 /api 转发到 agent-api(:3001),避免 CORS。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
});
