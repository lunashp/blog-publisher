import path from "node:path";

import { ToolError } from "../errors.js";
import type { Locale } from "./schema.js";

/**
 * 경로 규약과 allowlist (docs/SECURITY.md T3, CLAUDE.md 불변식 2).
 *
 * ★ 이 파일이 저장소 쓰기 범위를 결정한다. 여기가 뚫리면 토큰 권한 전체가 노출된다.
 */

/** 이 두 프리픽스 밖으로는 절대 쓰지 않는다. */
export const ALLOWED_PREFIXES = ["content/posts/", "public/images/"] as const;

const ASSET_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".avif",
  ".gif",
]);

export const postPath = (locale: Locale, slug: string): string =>
  `content/posts/${locale}/${slug}.mdx`;

export const assetPath = (slug: string, filename: string): string =>
  `public/images/${slug}/${filename}`;

/** 본문·frontmatter 에서 쓰는 자산 참조 경로 (public 기준 절대경로) */
export const assetUrl = (slug: string, filename: string): string =>
  `/images/${slug}/${filename}`;

export const postDir = (locale: Locale): string => `content/posts/${locale}`;

/**
 * 쓰기 경로 검증 — **입력을 믿지 않고 정규화 후 검사**한다.
 *
 * zod 의 `.startsWith()` 만으로 끝내면 안 된다:
 * `content/posts/../../.github/workflows/x.yml` 은 startsWith 를 통과하지만
 * 정규화하면 저장소 루트 밖의 CI 설정을 가리킨다.
 */
export function assertAllowedPath(candidate: string): string {
  if (candidate.length === 0) {
    throw new ToolError("PATH_NOT_ALLOWED", "경로가 비어 있습니다.");
  }

  // 널바이트·백슬래시는 정규화 전에 거른다.
  if (candidate.includes("\0")) {
    throw new ToolError("PATH_NOT_ALLOWED", "경로에 허용되지 않는 문자가 있습니다.");
  }

  const normalized = path.posix.normalize(candidate.replaceAll("\\", "/"));

  const rejected =
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    normalized === ".." ||
    normalized.split("/").includes("..") ||
    !ALLOWED_PREFIXES.some((prefix) => normalized.startsWith(prefix));

  if (rejected) {
    throw new ToolError(
      "PATH_NOT_ALLOWED",
      `경로가 허용 범위를 벗어났습니다: "${candidate}". ` +
        `쓰기는 ${ALLOWED_PREFIXES.join(" 와 ")} 안에서만 가능합니다.`,
    );
  }

  return normalized;
}

/** 자산 파일명 검증 — 경로 구분자와 확장자를 함께 본다. */
export function assertAllowedAssetFilename(filename: string): string {
  const normalized = filename.trim();

  if (normalized.includes("/") || normalized.includes("\\") || normalized.includes("\0")) {
    throw new ToolError(
      "PATH_NOT_ALLOWED",
      `파일명에 경로 구분자를 쓸 수 없습니다: "${filename}"`,
    );
  }

  if (normalized === "." || normalized === ".." || normalized.startsWith(".")) {
    throw new ToolError("PATH_NOT_ALLOWED", `잘못된 파일명입니다: "${filename}"`);
  }

  const ext = path.posix.extname(normalized).toLowerCase();
  if (!ASSET_EXTENSIONS.has(ext)) {
    throw new ToolError(
      "PATH_NOT_ALLOWED",
      `허용되지 않는 확장자입니다: "${ext || "(없음)"}". ` +
        `가능: ${[...ASSET_EXTENSIONS].join(", ")}`,
    );
  }

  return normalized;
}

/** `content/posts/<locale>/<slug>.mdx` 를 되돌려 파싱한다. 형식이 다르면 null. */
export function parsePostPath(
  filePath: string,
): { locale: string; slug: string } | null {
  const match = /^content\/posts\/([^/]+)\/([^/]+)\.mdx$/.exec(filePath);
  if (!match) return null;
  return { locale: match[1]!, slug: match[2]! };
}
