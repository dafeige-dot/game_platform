import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Tauri shell loads this app from dist/; the adapter layer keeps the UI
// identical whether it runs under Vite, `tauri dev`, or the packaged client.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5273,
    strictPort: true,
    // cargo writes .exe/.obj here at 4 Hz during builds; watching it makes
    // chokidar die with EBUSY on Windows.
    watch: { ignored: ['**/src-tauri/**'] },
  },
});
