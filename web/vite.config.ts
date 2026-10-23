import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.API_PROXY_TARGET || 'http://localhost:4400';
  const port = Number(env.WEB_PORT || 5173);
  return {
    plugins: [react()],
    server: {
      port,
      proxy: {
        '/api': {
          target,
          changeOrigin: true,
          // keep SSE unbuffered
          configure: (proxy) => {
            proxy.on('proxyRes', (res) => {
              if (String(res.headers['content-type'] || '').includes('text/event-stream')) {
                res.headers['cache-control'] = 'no-cache';
                res.headers['x-accel-buffering'] = 'no';
              }
            });
          },
        },
      },
    },
  };
});
