import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    coverage: {
      provider: 'v8',
      include: ['src/services/**/*.ts'],
      exclude: ['src/services/**/*.test.ts', 'src/services/__tests__/**'],
      reporter: ['text', 'html'],
    },
  },
});
