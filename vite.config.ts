import preact from '@preact/preset-vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [preact()],
  build: { target: 'es2022', sourcemap: false },
  server: { proxy: { '/api': { target: 'http://127.0.0.1:8787', ws: true } } },
  test: { include: ['tests/unit/**/*.test.ts'] },
});
