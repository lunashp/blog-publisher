import { describe, expect, it } from "vitest";

import { describeConfig, loadConfig } from "./env.js";

const VALID = {
  GITHUB_TOKEN: "github_pat_secret_value",
  BLOG_REPO: "owner/jiny-log",
  BLOG_SITE_URL: "https://example.com",
};

describe("loadConfig", () => {
  it("owner/repo 를 분해한다", () => {
    const config = loadConfig(VALID);

    expect(config.owner).toBe("owner");
    expect(config.repo).toBe("jiny-log");
  });

  it("baseBranch 기본값은 main", () => {
    expect(loadConfig(VALID).baseBranch).toBe("main");
    expect(loadConfig({ ...VALID, BLOG_BASE_BRANCH: "trunk" }).baseBranch).toBe("trunk");
  });

  it("siteUrl 끝 슬래시를 정규화한다", () => {
    expect(loadConfig({ ...VALID, BLOG_SITE_URL: "https://example.com/" }).siteUrl).toBe(
      "https://example.com",
    );
  });

  it("MCP_DRY_RUN 을 불리언으로 해석한다", () => {
    expect(loadConfig(VALID).dryRun).toBe(false);
    expect(loadConfig({ ...VALID, MCP_DRY_RUN: "true" }).dryRun).toBe(true);
    expect(loadConfig({ ...VALID, MCP_DRY_RUN: "1" }).dryRun).toBe(true);
    // 오타는 false 로 — 안전한 쪽이 아니라 "실제로 쓴다"는 뜻이므로 주의가 필요하지만,
    // dry-run 을 의도했는데 조용히 켜지는 것보다 명시적 값만 인정하는 편이 예측 가능하다.
    expect(loadConfig({ ...VALID, MCP_DRY_RUN: "yes" }).dryRun).toBe(false);
  });

  it.each([
    ["토큰 없음", { ...VALID, GITHUB_TOKEN: undefined }],
    ["저장소 없음", { ...VALID, BLOG_REPO: undefined }],
    ["저장소 형식 오류", { ...VALID, BLOG_REPO: "just-a-name" }],
    ["URL 아님", { ...VALID, BLOG_SITE_URL: "not-a-url" }],
  ])("★ %s 이면 즉시 실패한다", (_label, env) => {
    expect(() => loadConfig(env as NodeJS.ProcessEnv)).toThrow(/환경변수/);
  });

  it("실패 메시지가 무엇을 고쳐야 하는지 알려준다", () => {
    try {
      loadConfig({});
      expect.unreachable("던졌어야 한다");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("GITHUB_TOKEN");
      expect(message).toContain(".env.example");
    }
  });
});

describe("describeConfig — ★ 로그 안전성", () => {
  it("토큰을 값이 아니라 존재 여부로만 남긴다", () => {
    const described = describeConfig(loadConfig(VALID));

    expect(described.githubToken).toBe("<set>");
    expect(JSON.stringify(described)).not.toContain("github_pat_secret_value");
  });

  it("진단에 필요한 나머지는 남긴다", () => {
    const described = describeConfig(loadConfig(VALID));

    expect(described.repo).toBe("owner/jiny-log");
    expect(described.baseBranch).toBe("main");
    expect(described.dryRun).toBe("false");
  });
});
