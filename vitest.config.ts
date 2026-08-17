import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/index.ts",
        // 배선만 있고 로직이 없다. server.test.ts 가 실제 프로세스로 표면을 검증한다.
        "src/server.ts",
        // 네트워크 어댑터. 로직은 memory.ts 로 검증하고,
        // 토큰 유출 차단은 errors.test.ts 가 직접 확인한다.
        "src/github/octokit.ts",
      ],
      thresholds: {
        // content/ 는 안전장치가 모여 있어 더 높게 잡는다 (docs/PLAN.md)
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
