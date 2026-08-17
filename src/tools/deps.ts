import type { Config } from "../config/env.js";
import type { GitHubAdapter } from "../github/types.js";
import type { Locale } from "../content/schema.js";

/**
 * 핸들러 의존성 — 전부 주입한다.
 *
 * 모듈 스코프에서 Octokit 을 만들거나 `new Date()` 를 직접 부르면
 * 테스트에서 모킹할 수 없다 (docs/ARCHITECTURE.md §3).
 */
export interface Deps {
  gh: GitHubAdapter;
  config: Config;
  /** 날짜 각인용. 테스트에서 고정한다. */
  now: () => Date;
}

/** 서버가 각인하는 날짜. 호출자가 보낸 값은 쓰지 않는다. */
export const today = (deps: Deps): string =>
  deps.now().toISOString().slice(0, 10);

export const liveUrl = (deps: Deps, locale: Locale, slug: string): string =>
  `${deps.config.siteUrl}/${locale}/posts/${slug}`;

export const branchName = (locale: Locale, slug: string): string =>
  `post/${locale}-${slug}`;

/** 모든 쓰기 도구가 반환하는 공통 형태 (docs/TOOLS.md §0) */
export interface WriteResult {
  slug: string;
  locale: Locale;
  path: string;
  commitSha: string;
  status: "draft" | "published" | "unpublished" | "deleted" | "dry-run";
  prUrl?: string;
  /** 확보됐을 때만 넣는다 — 추측 URL 을 확정처럼 주지 않는다 */
  previewUrl?: string;
  liveUrl?: string;
  /** 배포 지연 등 호출자가 알아야 할 사실 */
  note?: string;
}
