import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 서버 표면 end-to-end 검증.
 *
 * 빌드 산출물을 실제 프로세스로 띄우고 stdio 로 JSON-RPC 를 주고받는다.
 * 도구 등록이 잘못되면 `initialize` 자체가 실패하므로(v2 는 zod 스키마를 요구),
 * 이 테스트가 그 회귀를 잡는다.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(ROOT, "dist/index.js");

const ENV = {
  ...process.env,
  GITHUB_TOKEN: "dummy-token-not-real",
  BLOG_REPO: "owner/jiny-log",
  BLOG_SITE_URL: "https://example.com",
  MCP_DRY_RUN: "true",
};

interface RpcResult {
  responses: Record<string, unknown>[];
  stderr: string;
}

/** legacy era(initialize) 핸드셰이크로 요청을 보낸다 — v2 는 두 era 를 모두 서빙한다. */
function rpc(requests: unknown[], timeoutMs = 15_000): Promise<RpcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], {
      env: ENV,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`타임아웃. stderr:\n${stderr}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", () => {
      clearTimeout(timer);
      const responses = stdout
        .split("\n")
        .filter((line) => line.trim().startsWith("{"))
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      resolve({ responses, stderr });
    });

    for (const request of requests) {
      child.stdin.write(`${JSON.stringify(request)}\n`);
    }
    // 응답이 흘러나올 시간을 준 뒤 stdin 을 닫는다.
    setTimeout(() => child.stdin.end(), 1500);
  });
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0.0" },
  },
};

const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };

describe("서버 표면 (실제 프로세스)", () => {
  it("★ initialize 가 성공한다 — 도구 등록이 깨지면 여기서 실패한다", async () => {
    const { responses, stderr } = await rpc([INITIALIZE]);
    const init = responses.find((r) => r.id === 1);

    expect(init, `stderr:\n${stderr}`).toBeDefined();
    expect(init).toHaveProperty("result");
    expect(init).not.toHaveProperty("error");
  });

  it("★ 도구 10종을 전부 노출한다", async () => {
    const { responses } = await rpc([
      INITIALIZE,
      INITIALIZED,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]);

    const list = responses.find((r) => r.id === 2);
    const tools = (list?.result as { tools?: Array<{ name: string }> })?.tools ?? [];
    const names = tools.map((t) => t.name).sort();

    expect(names).toEqual([
      "create_draft",
      "delete_post",
      "generate_slug",
      "get_post",
      "list_posts",
      "publish_post",
      "unpublish_post",
      "update_post",
      "upload_asset",
      "validate_frontmatter",
    ]);
  });

  it("★ 읽기 도구에 readOnlyHint, 파괴적 도구에 destructiveHint 가 붙는다", async () => {
    const { responses } = await rpc([
      INITIALIZE,
      INITIALIZED,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]);

    const tools =
      (
        responses.find((r) => r.id === 2)?.result as {
          tools?: Array<{ name: string; annotations?: Record<string, boolean> }>;
        }
      )?.tools ?? [];

    const byName = new Map(tools.map((t) => [t.name, t.annotations ?? {}]));

    for (const name of ["list_posts", "get_post", "validate_frontmatter", "generate_slug"]) {
      expect(byName.get(name)?.readOnlyHint, name).toBe(true);
    }
    for (const name of ["update_post", "unpublish_post", "delete_post"]) {
      expect(byName.get(name)?.destructiveHint, name).toBe(true);
    }
    // 초안 생성과 발행은 파괴적이지 않다 — 기존 글을 지우지 않는다.
    expect(byName.get("create_draft")?.destructiveHint).toBe(false);
    expect(byName.get("publish_post")?.idempotentHint).toBe(true);
  });

  it("★ 도구 설명문이 부작용을 명시한다", async () => {
    const { responses } = await rpc([
      INITIALIZE,
      INITIALIZED,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]);

    const tools =
      (
        responses.find((r) => r.id === 2)?.result as {
          tools?: Array<{ name: string; description?: string }>;
        }
      )?.tools ?? [];
    const desc = new Map(tools.map((t) => [t.name, t.description ?? ""]));

    // LLM 이 읽는 유일한 사용법이다. 핵심 제약이 문장에 있어야 한다.
    expect(desc.get("create_draft")).toContain("draft=true");
    expect(desc.get("create_draft")).toContain("publish_post");
    expect(desc.get("publish_post")).toContain("공개");
    expect(desc.get("update_post")).toContain("get_post");
    expect(desc.get("delete_post")).toContain("되돌리려면");
  });

  it("★ stderr 설정 로그에 토큰이 노출되지 않는다", async () => {
    const { stderr } = await rpc([INITIALIZE]);

    expect(stderr).toContain("<set>");
    expect(stderr).not.toContain("dummy-token-not-real");
  });

  it("dry-run 모드를 stderr 로 경고한다", async () => {
    const { stderr } = await rpc([INITIALIZE]);

    expect(stderr).toContain("MCP_DRY_RUN=true");
  });

  it("★ stdout 에 JSON-RPC 외의 것이 섞이지 않는다", async () => {
    const { responses } = await rpc([INITIALIZE]);

    // 모든 stdout 줄이 파싱 가능한 JSON-RPC 여야 한다 (console.log 오염 검출).
    expect(responses.length).toBeGreaterThan(0);
    for (const response of responses) {
      expect(response.jsonrpc).toBe("2.0");
    }
  });
});
