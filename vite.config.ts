import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base is required for Electron loadFile(file://...) production loads.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { outDir: 'dist/renderer', emptyOutDir: true }
});
