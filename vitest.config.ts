import { defineConfig } from "vitest/config";

const coverageDirectory = process.env.CHOIR_VITEST_COVERAGE_DIR ?? "coverage/unit";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: true,
    include: ["src/tests/unit/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/out/**",
      "**/.{idea,git,cache,output,temp}/**",
    ],
    testTimeout: 300000,
    hookTimeout: 120000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json"],
      reportsDirectory: coverageDirectory,
      include: ["src/**/*.ts"],
      exclude: [
        "src/tests/**",
        "src/webview/**",
      ],
    },
  },
});
