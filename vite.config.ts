import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => ({
  plugins: [react(), {
    name: 'local-dev-csp',
    transformIndexHtml: {
      order: 'pre',
      handler(html) { return command === 'serve' ? html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'") : html; },
    },
  }],
  base: './',
  server: { host: '127.0.0.1', port: 5178, strictPort: true, watch: { ignored: ['**/.test-output/**', '**/release/**'] } },
  build: { target: 'es2022', chunkSizeWarningLimit: 750 },
}));
