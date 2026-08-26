import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  root: path.resolve(__dirname, 'renderer'),
  base: './',
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, 'dist-renderer'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
  },
});
