import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': rootDir,
      'next/link': path.resolve(rootDir, './tests/mocks/next-link.jsx'),
      'next/image': path.resolve(rootDir, './tests/mocks/next-image.jsx'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './tests/setup.ts',
    include: ['**/*.test.{js,jsx,ts,tsx}'],
  },
});
