import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['src/todos/test-setup.ts'],
    include: ['src/{todos,goals,journal,calendar,chat,messages,totems,sources,recs,lists,connections,cliproxy,dev,work,tasksnav,habits,productivity}/**/*.test.{ts,tsx}', 'src/*.test.{ts,tsx}'],
  },
})
