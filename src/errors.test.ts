import { describe, expect, it } from "vitest";

import { ToolError, isToolError, wrapGitHubError } from "./errors.js";

describe("ToolError", () => {
  it("코드와 메시지를 담는다", () => {
    const error = new ToolError("NOT_FOUND", "없습니다");

    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toBe("없습니다");
    expect(isToolError(error)).toBe(true);
    expect(isToolError(new Error("x"))).toBe(false);
  });

  it("★ 직렬화에 스택을 포함하지 않는다", () => {
    const payload = new ToolError("GITHUB_ERROR", "실패").toPayload();

    expect(JSON.stringify(payload)).not.toContain("at ");
    expect(payload.error).toEqual({ code: "GITHUB_ERROR", message: "실패" });
  });

  it("details 가 있으면 담고 없으면 키 자체를 뺀다", () => {
    expect(new ToolError("VALIDATION_FAILED", "x", [{ field: "a" }]).toPayload().error).toHaveProperty(
      "details",
    );
    expect(new ToolError("VALIDATION_FAILED", "x").toPayload().error).not.toHaveProperty(
      "details",
    );
  });
});

describe("wrapGitHubError — ★ 토큰 유출 차단", () => {
  /** Octokit 오류를 흉내낸다 — 실제로 요청 헤더에 토큰이 들어있다. */
  const octokitError = (status: number) =>
    Object.assign(new Error("HttpError"), {
      status,
      request: {
        method: "PUT",
        url: "https://api.github.com/repos/o/r/contents/x",
        headers: {
          authorization: "token ghp_SUPERSECRETTOKEN123",
          "user-agent": "octokit",
        },
      },
      response: {
        headers: { "x-ratelimit-remaining": "0" },
        data: { message: "Bad credentials" },
      },
    });

  it("★ 원본 오류의 토큰이 메시지에 새지 않는다", () => {
    const wrapped = wrapGitHubError(octokitError(401), "파일 쓰기");

    expect(wrapped.message).not.toContain("ghp_SUPERSECRETTOKEN123");
    expect(JSON.stringify(wrapped.toPayload())).not.toContain("ghp_SUPERSECRETTOKEN123");
  });

  it("★ 요청/응답 본문을 통째로 담지 않는다", () => {
    const payload = JSON.stringify(wrapGitHubError(octokitError(403), "파일 쓰기").toPayload());

    expect(payload).not.toContain("authorization");
    expect(payload).not.toContain("api.github.com");
  });

  it("status 별로 다음 행동을 안내한다", () => {
    expect(wrapGitHubError(octokitError(401), "쓰기").message).toContain("권한");
    expect(wrapGitHubError(octokitError(404), "쓰기").message).toContain("BLOG_REPO");
    expect(wrapGitHubError(octokitError(409), "쓰기").message).toContain("다시 읽고");
  });

  it("status 가 없어도 안전하게 처리한다", () => {
    const wrapped = wrapGitHubError(new Error("network down"), "읽기");

    expect(wrapped.code).toBe("GITHUB_ERROR");
    expect(wrapped.message).toContain("unknown");
  });

  it("null/undefined 도 처리한다", () => {
    expect(() => wrapGitHubError(null, "읽기")).not.toThrow();
    expect(() => wrapGitHubError(undefined, "읽기")).not.toThrow();
  });
});
