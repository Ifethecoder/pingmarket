import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Each suite boots its own in-memory PGlite and runs the migrations in beforeAll; with many
    // suites in parallel on a busy machine that can exceed the 10s default.
    hookTimeout: 30_000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
