import { z } from "zod";

import { ToolError } from "../errors.js";

/**
 * 환경변수 로드·검증.
 *
 * 시작 시 전부 검증하고, 없으면 **명확한 메시지와 함께 즉시 종료**한다.
 * 토큰 없이 조용히 동작하다 첫 쓰기에서 실패하면 원인을 찾기 어렵다.
 */

const EnvSchema = z.object({
  GITHUB_TOKEN: z
    .string()
    .min(1, "GitHub fine-grained PAT 이 필요합니다 (Contents: RW, Pull requests: RW)"),
  BLOG_REPO: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/, 'BLOG_REPO 는 "owner/repo" 형식이어야 합니다'),
  BLOG_SITE_URL: z.url("BLOG_SITE_URL 은 올바른 URL 이어야 합니다"),
  BLOG_BASE_BRANCH: z.string().min(1).default("main"),
  MCP_DRY_RUN: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
});

export interface Config {
  token: string;
  owner: string;
  repo: string;
  siteUrl: string;
  baseBranch: string;
  dryRun: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);

  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (issue) => `  - ${issue.path.join(".") || "(env)"}: ${issue.message}`,
    );
    throw new ToolError(
      "CONFIG_ERROR",
      `환경변수 설정이 올바르지 않습니다:\n${lines.join("\n")}\n\n` +
        `.env.example 을 참고하세요. 토큰은 커밋되는 파일에 넣지 마세요 (docs/SECURITY.md §2).`,
    );
  }

  const [owner, repo] = parsed.data.BLOG_REPO.split("/") as [string, string];

  return {
    token: parsed.data.GITHUB_TOKEN,
    owner,
    repo,
    siteUrl: parsed.data.BLOG_SITE_URL.replace(/\/+$/, ""),
    baseBranch: parsed.data.BLOG_BASE_BRANCH,
    dryRun: parsed.data.MCP_DRY_RUN,
  };
}

/**
 * 로그에 찍어도 안전한 형태. **토큰은 존재 여부만 남긴다.**
 */
export const describeConfig = (config: Config): Record<string, string> => ({
  repo: `${config.owner}/${config.repo}`,
  siteUrl: config.siteUrl,
  baseBranch: config.baseBranch,
  dryRun: String(config.dryRun),
  githubToken: config.token ? "<set>" : "<missing>",
});
