import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Build da PWA mobile (servida em https://maestrus.cloud/app/). Entry = mobile.html.
export default defineConfig({
  root: path.resolve(__dirname, 'renderer'),
  base: '/app/',
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, 'dist-mobile'),
    emptyOutDir: true,
    rollupOptions: { input: path.resolve(__dirname, 'renderer/mobile.html') },
  },
});
