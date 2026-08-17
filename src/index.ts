#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { describeConfig, loadConfig } from "./config/env.js";
import { CONTRACT_VERSION } from "./content/schema.js";
import { OctokitGitHub } from "./github/octokit.js";
import { isToolError } from "./errors.js";
import type { Deps } from "./tools/deps.js";
import { createServer } from "./server.js";

/**
 * 엔트리.
 *
 * ★ stdout 은 JSON-RPC 채널이다. 진단 출력은 전부 stderr(`console.error`)로만 나간다.
 *   `console.log` 를 쓰면 프로토콜이 깨진다 (CLAUDE.md 불변식 4).
 */
const log = (...args: unknown[]) => console.error("[blog-publisher]", ...args);

function main(): void {
  // 토큰 없이 조용히 동작하다 첫 쓰기에서 실패하지 않는다 — 여기서 끝낸다.
  const config = (() => {
    try {
      return loadConfig();
    } catch (error) {
      log(isToolError(error) ? error.message : String(error));
      process.exit(1);
    }
  })();

  const deps: Deps = {
    gh: new OctokitGitHub(config),
    config,
    now: () => new Date(),
  };

  // 계약 버전을 남긴다 — 향후 jiny-log 와의 불일치 진단에 쓴다.
  log(`계약 v${CONTRACT_VERSION} ·`, JSON.stringify(describeConfig(config)));

  if (config.dryRun) {
    log("⚠️  MCP_DRY_RUN=true — 쓰기는 커밋 직전에 멈추고 diff 만 반환합니다.");
  }

  serveStdio(() => createServer(deps), {
    onerror: (error) => log("transport 오류:", error.message),
  });

  log("stdio 로 서빙 중");
}

main();
