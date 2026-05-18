import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    // Default excludes plus .claude/ so test files inside agent worktrees
    // (.claude/worktrees/*) don't get double-collected.
    exclude: ['node_modules/**', 'dist/**', 'dist-electron/**', '.claude/**'],
    coverage: {
      provider: 'v8',
      include: ['src/services/**/*.ts'],
      exclude: ['src/services/**/*.test.ts', 'src/services/__tests__/**'],
      reporter: ['text', 'html'],
    },
  },
});
