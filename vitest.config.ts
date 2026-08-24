import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts?(x)"],
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: "forks",
  },
});
