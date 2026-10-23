import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.GAME_PROXY_TARGET || 'http://localhost:4400';
  const port = Number(env.GAME_PORT || 5174);
  return {
    server: {
      port,
      strictPort: true,
      proxy: {
        '/api': { target, changeOrigin: true },
        '/ws': { target: target.replace(/^http/, 'ws'), ws: true, changeOrigin: true },
      },
    },
    build: {
      chunkSizeWarningLimit: 2000,
      rollupOptions: { output: { manualChunks: { phaser: ['phaser'] } } },
    },
  };
});
