import { defineConfig } from 'vite';

// JSX компилируется встроенным esbuild Vite — отдельный React-плагин не нужен.
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1' },
});
