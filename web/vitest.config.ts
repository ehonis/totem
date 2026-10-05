import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['src/todos/test-setup.ts'],
    include: ['src/{todos,goals,journal}/**/*.test.{ts,tsx}'],
  },
})
