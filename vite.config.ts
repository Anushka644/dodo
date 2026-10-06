import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // relative asset paths, so the build works at a domain root or under /repo-name/
  base: './',
  plugins: [react()],
});
