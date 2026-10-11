import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['src/todos/test-setup.ts'],
    include: ['src/{todos,goals,journal,chat,messages,totems}/**/*.test.{ts,tsx}'],
  },
})
