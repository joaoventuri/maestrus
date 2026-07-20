import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Build do WEB APP desktop-like (servido em https://maestrus.cloud/web/).
// Entry = web.html → web-main.tsx → App.tsx (o mesmo do Electron) + shim web.
export default defineConfig({
  root: path.resolve(__dirname, 'renderer'),
  base: '/web/',
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, 'dist-web'),
    emptyOutDir: true,
    rollupOptions: { input: path.resolve(__dirname, 'renderer/web.html') },
  },
});
