import { z } from "zod";

import { ToolError } from "../errors.js";
import {
  CoverSchema,
  LocaleSchema,
  PostFrontmatterSchema,
  SlugSchema,
  toIssues,
  type Locale,
  type PostFrontmatter,
} from "../content/schema.js";
import { assertAllowedPath, postPath } from "../content/paths.js";
import { parseMdx, serializeMdx, splitMdx } from "../content/serialize.js";
import { generateSlug, truncateSlug } from "../content/slug.js";
import { branchName, liveUrl, today, type Deps, type WriteResult } from "./deps.js";

/**
 * 쓰기 도구 — 여기서부터 실수가 공개된다 (docs/SECURITY.md §7).
 *
 * 모든 핸들러가 지키는 순서:
 *   1. 검증 → 2. 경로 allowlist → 3. dry-run 차단 지점 → 4. 커밋
 */

const TagSchema = z.string().regex(/^[a-z0-9-]+$/);
const CategorySchema = z.enum([
  "troubleshooting",
  "insight",
  "note",
  "retrospective",
]);

/** 커밋 직전에 반드시 통과시킨다. "이미 검사했으니 생략"은 없다 (불변식 3). */
function assertValid(frontmatter: unknown, context: string): PostFrontmatter {
  const result = PostFrontmatterSchema.safeParse(frontmatter);
  if (!result.success) {
    const issues = toIssues(result.error);
    throw new ToolError(
      "VALIDATION_FAILED",
      `${context}: ${issues.map((i) => `${i.field} — ${i.message}`).join("; ")}`,
      issues,
    );
  }
  return result.data;
}

/** dry-run 이면 커밋 직전에 멈추고 무엇을 쓰려 했는지 반환한다. */
function dryRunResult(
  deps: Deps,
  locale: Locale,
  slug: string,
  path: string,
  content: string,
  branch: string,
): WriteResult & { preview: string } {
  return {
    slug,
    locale,
    path,
    commitSha: "(dry-run)",
    status: "dry-run",
    note: `MCP_DRY_RUN=true 이므로 아무것도 쓰지 않았습니다. 대상 브랜치: ${branch}`,
    preview: content.length > 2000 ? `${content.slice(0, 2000)}\n…(생략)` : content,
  };
}

// --------------------------------------------------------------- create_draft

export const CreateDraftInput = z.object({
  title: z.string().min(1).max(120),
  /** 마크다운 본문. frontmatter 블록은 포함하지 않는다. */
  body: z.string().min(1),
  locale: LocaleSchema,
  description: z.string().min(50).max(300),
  summary: z.string().max(500).optional(),
  slug: SlugSchema.optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  tags: z.array(TagSchema).max(8).default([]),
  category: CategorySchema.optional(),
  series: z.string().optional(),
  related: z.array(SlugSchema).max(5).default([]),
  canonical: z.url().optional(),
  cover: CoverSchema.optional(),
  // ★ draft 필드를 입력으로 받지 않는다 — 항상 true 로 강제된다 (불변식 1).
});
export type CreateDraftInput = z.infer<typeof CreateDraftInput>;

export async function createDraft(
  input: CreateDraftInput,
  deps: Deps,
): Promise<WriteResult> {
  // 1. 슬러그 결정
  let slug = input.slug;
  if (!slug) {
    const generated = generateSlug(input.title);
    if (generated.needsEnglishSlug || !generated.slug) {
      throw new ToolError(
        "VALIDATION_FAILED",
        `슬러그를 자동 생성할 수 없습니다. ${generated.reason ?? ""} ` +
          `slug 파라미터로 영문 슬러그를 지정하세요.`,
      );
    }
    slug = truncateSlug(generated.slug);
  }

  const path = assertAllowedPath(postPath(input.locale, slug));

  // 2. 충돌 검사 — 덮어쓰지 않는다
  const existing = await deps.gh.getFile(path);
  if (existing) {
    throw new ToolError(
      "SLUG_CONFLICT",
      `"${slug}" 는 ${input.locale} 에 이미 있습니다. ` +
        `기존 글을 고치려면 update_post 를, 새 글이면 다른 슬러그를 쓰세요.`,
    );
  }

  // 3. frontmatter 조립 — draft 는 항상 true
  const frontmatter = assertValid(
    {
      title: input.title,
      description: input.description,
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      date: input.date ?? today(deps),
      draft: true, // ★ 불변식 1
      tags: input.tags,
      ...(input.category === undefined ? {} : { category: input.category }),
      ...(input.series === undefined ? {} : { series: input.series }),
      related: input.related,
      ...(input.canonical === undefined ? {} : { canonical: input.canonical }),
      ...(input.cover === undefined ? {} : { cover: input.cover }),
    },
    "초안 생성 실패",
  );

  const content = serializeMdx(frontmatter, input.body);
  const branch = branchName(input.locale, slug);

  if (deps.config.dryRun) {
    return dryRunResult(deps, input.locale, slug, path, content, branch);
  }

  // 4. 브랜치 → 커밋 → PR
  await deps.gh.ensureBranch(branch, deps.config.baseBranch);

  const commit = await deps.gh.putFile({
    path,
    content,
    message: `content: add "${input.title}" (${input.locale})`,
    branch,
  });

  const pr = await deps.gh.openOrReusePr({
    head: branch,
    base: deps.config.baseBranch,
    title: `content: ${input.title} (${input.locale})`,
    body:
      `초안입니다. \`draft: true\` 상태라 라이브에 나가지 않습니다.\n\n` +
      `발행하려면 \`publish_post\` 를 호출하세요.\n\n` +
      `- 슬러그: \`${slug}\`\n- 로케일: \`${input.locale}\`\n`,
  });

  const previewUrl = await deps.gh.findPreviewUrl(pr.number);

  return {
    slug,
    locale: input.locale,
    path,
    commitSha: commit.fileSha,
    status: "draft",
    prUrl: pr.url,
    ...(previewUrl === undefined
      ? {
          note: "프리뷰 URL 이 아직 준비되지 않았습니다. PR 페이지에서 배포 링크를 확인하세요.",
        }
      : { previewUrl }),
  };
}

// --------------------------------------------------------------- publish_post

export const PublishPostInput = z.object({
  slug: SlugSchema,
  locale: LocaleSchema,
});
export type PublishPostInput = z.infer<typeof PublishPostInput>;

/**
 * ★ `draft: true → false` 전이는 오직 이 함수에서만 일어난다 (불변식 1).
 */
export async function publishPost(
  input: PublishPostInput,
  deps: Deps,
): Promise<WriteResult> {
  const path = assertAllowedPath(postPath(input.locale, input.slug));
  const branch = branchName(input.locale, input.slug);

  // 초안은 보통 브랜치에 있다. 없으면 base 에서 찾는다.
  const branches = [branch, deps.config.baseBranch];
  let source: { content: string; sha: string; ref: string } | undefined;

  for (const ref of branches) {
    try {
      const file = await deps.gh.getFile(path, ref);
      if (file) {
        source = { content: file.content, sha: file.sha, ref };
        break;
      }
    } catch {
      // 브랜치가 없을 수 있다 — 다음 후보로
    }
  }

  if (!source) {
    throw new ToolError(
      "NOT_FOUND",
      `발행할 글을 찾을 수 없습니다: ${input.locale}/${input.slug}.`,
    );
  }

  const { frontmatter, body } = parseMdx(source.content, "발행 대상");

  // 이미 발행됐으면 no-op 성공 (멱등)
  if (!frontmatter.draft) {
    return {
      slug: input.slug,
      locale: input.locale,
      path,
      commitSha: source.sha,
      status: "published",
      liveUrl: liveUrl(deps, input.locale, input.slug),
      note: "이미 발행된 글입니다. 변경하지 않았습니다.",
    };
  }

  const published = assertValid({ ...frontmatter, draft: false }, "발행 전 검증 실패");
  const content = serializeMdx(published, body);

  if (deps.config.dryRun) {
    return dryRunResult(deps, input.locale, input.slug, path, content, source.ref);
  }

  const commit = await deps.gh.putFile({
    path,
    content,
    message: `content: publish ${input.slug} (${input.locale})`,
    branch: source.ref,
    sha: source.sha,
  });

  // 브랜치에 있었다면 base 로 머지한다.
  let merged = false;
  if (source.ref !== deps.config.baseBranch) {
    const pr = await deps.gh.openOrReusePr({
      head: source.ref,
      base: deps.config.baseBranch,
      title: `content: publish ${input.slug} (${input.locale})`,
      body: "발행합니다.",
    });
    const result = await deps.gh.mergePr(pr.number, `content: publish ${input.slug}`);
    merged = result.merged;
  }

  return {
    slug: input.slug,
    locale: input.locale,
    path,
    commitSha: commit.fileSha,
    status: "published",
    liveUrl: liveUrl(deps, input.locale, input.slug),
    note:
      `배포까지 1~3분 걸립니다.` +
      (merged ? "" : " 기본 브랜치에 직접 반영했습니다."),
  };
}

// ---------------------------------------------------------------- update_post

export const UpdatePostInput = z.object({
  slug: SlugSchema,
  locale: LocaleSchema,
  /** ★ get_post 에서 받은 값. 그 사이 글이 바뀌었으면 거부한다 (불변식 5). */
  expectedCommitSha: z.string().min(7),
  body: z.string().optional(),
  title: z.string().min(1).max(120).optional(),
  description: z.string().min(50).max(300).optional(),
  summary: z.string().max(500).optional(),
  tags: z.array(TagSchema).max(8).optional(),
  category: CategorySchema.optional(),
  series: z.string().optional(),
  related: z.array(SlugSchema).max(5).optional(),
  canonical: z.url().optional(),
  cover: CoverSchema.optional(),
  // ★ draft 도 date 도 받지 않는다 — 상태 전이와 발행일은 여기서 바뀌지 않는다.
});
export type UpdatePostInput = z.infer<typeof UpdatePostInput>;

export async function updatePost(
  input: UpdatePostInput,
  deps: Deps,
): Promise<WriteResult> {
  const path = assertAllowedPath(postPath(input.locale, input.slug));

  const branch = branchName(input.locale, input.slug);
  let source: { content: string; sha: string; ref: string } | undefined;

  for (const ref of [deps.config.baseBranch, branch]) {
    try {
      const file = await deps.gh.getFile(path, ref);
      if (file) {
        source = { content: file.content, sha: file.sha, ref };
        break;
      }
    } catch {
      // 다음 후보로
    }
  }

  if (!source) {
    throw new ToolError("NOT_FOUND", `글을 찾을 수 없습니다: ${input.locale}/${input.slug}.`);
  }

  // ★ 낙관적 동시성 — 오래된 컨텍스트로 덮어쓰는 것을 막는다
  if (source.sha !== input.expectedCommitSha) {
    throw new ToolError(
      "STALE_CONTENT",
      `이 글은 마지막으로 읽은 이후 변경되었습니다 ` +
        `(expected ${input.expectedCommitSha.slice(0, 7)}, actual ${source.sha.slice(0, 7)}). ` +
        `get_post 로 최신 내용을 읽고 다시 시도하세요.`,
    );
  }

  const { frontmatter, body } = parseMdx(source.content, "수정 대상");

  const merged = assertValid(
    {
      ...frontmatter,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      ...(input.tags === undefined ? {} : { tags: input.tags }),
      ...(input.category === undefined ? {} : { category: input.category }),
      ...(input.series === undefined ? {} : { series: input.series }),
      ...(input.related === undefined ? {} : { related: input.related }),
      ...(input.canonical === undefined ? {} : { canonical: input.canonical }),
      ...(input.cover === undefined ? {} : { cover: input.cover }),
      // date 는 불변. draft 상태도 그대로 유지.
      date: frontmatter.date,
      draft: frontmatter.draft,
      // ★ updated 는 서버 시각으로 각인한다. 호출자가 보낸 값은 애초에 받지 않는다.
      updated: today(deps),
    },
    "수정 실패",
  );

  const content = serializeMdx(merged, input.body ?? body);

  if (deps.config.dryRun) {
    return dryRunResult(deps, input.locale, input.slug, path, content, source.ref);
  }

  const commit = await deps.gh.putFile({
    path,
    content,
    message: `content: update ${input.slug} (${input.locale})`,
    branch: source.ref,
    sha: source.sha,
  });

  return {
    slug: input.slug,
    locale: input.locale,
    path,
    commitSha: commit.fileSha,
    status: merged.draft ? "draft" : "published",
    ...(merged.draft ? {} : { liveUrl: liveUrl(deps, input.locale, input.slug) }),
    note: `수정일(updated)을 ${merged.updated} 로 기록했습니다.`,
  };
}

// -------------------------------------------------------------- unpublish_post

export const UnpublishPostInput = z.object({
  slug: SlugSchema,
  locale: LocaleSchema,
});
export type UnpublishPostInput = z.infer<typeof UnpublishPostInput>;

export async function unpublishPost(
  input: UnpublishPostInput,
  deps: Deps,
): Promise<WriteResult> {
  const path = assertAllowedPath(postPath(input.locale, input.slug));
  const file = await deps.gh.getFile(path, deps.config.baseBranch);

  if (!file) {
    throw new ToolError("NOT_FOUND", `글을 찾을 수 없습니다: ${input.locale}/${input.slug}.`);
  }

  const { frontmatter, body } = parseMdx(file.content, "비공개 전환 대상");

  if (frontmatter.draft) {
    return {
      slug: input.slug,
      locale: input.locale,
      path,
      commitSha: file.sha,
      status: "unpublished",
      note: "이미 초안 상태입니다. 변경하지 않았습니다.",
    };
  }

  const content = serializeMdx(
    assertValid({ ...frontmatter, draft: true }, "비공개 전환 실패"),
    body,
  );

  if (deps.config.dryRun) {
    return dryRunResult(deps, input.locale, input.slug, path, content, deps.config.baseBranch);
  }

  const commit = await deps.gh.putFile({
    path,
    content,
    message: `content: unpublish ${input.slug} (${input.locale})`,
    branch: deps.config.baseBranch,
    sha: file.sha,
  });

  return {
    slug: input.slug,
    locale: input.locale,
    path,
    commitSha: commit.fileSha,
    status: "unpublished",
    note: "파일은 남아 있습니다. 다음 배포부터 사이트에서 사라집니다 (1~3분).",
  };
}

// ---------------------------------------------------------------- delete_post

export const DeletePostInput = z.object({
  slug: SlugSchema,
  locale: LocaleSchema,
  expectedCommitSha: z.string().min(7),
  /** ★ 실수 방지 — slug 와 정확히 같아야 한다. 어노테이션은 아무것도 막지 못한다. */
  confirmSlug: SlugSchema,
});
export type DeletePostInput = z.infer<typeof DeletePostInput>;

export async function deletePost(
  input: DeletePostInput,
  deps: Deps,
): Promise<WriteResult & { remainingAssets?: string }> {
  if (input.confirmSlug !== input.slug) {
    throw new ToolError(
      "CONFIRMATION_REQUIRED",
      `confirmSlug 가 slug 와 다릅니다 ("${input.confirmSlug}" ≠ "${input.slug}"). ` +
        `삭제는 되돌리기 어려우므로 슬러그를 정확히 한 번 더 입력해야 합니다. ` +
        `비공개 전환이 목적이라면 unpublish_post 를 쓰세요.`,
    );
  }

  const path = assertAllowedPath(postPath(input.locale, input.slug));
  const file = await deps.gh.getFile(path, deps.config.baseBranch);

  if (!file) {
    throw new ToolError("NOT_FOUND", `글을 찾을 수 없습니다: ${input.locale}/${input.slug}.`);
  }

  if (file.sha !== input.expectedCommitSha) {
    throw new ToolError(
      "STALE_CONTENT",
      `이 글은 마지막으로 읽은 이후 변경되었습니다. get_post 로 다시 읽고 시도하세요.`,
    );
  }

  if (deps.config.dryRun) {
    return dryRunResult(deps, input.locale, input.slug, path, "(삭제)", deps.config.baseBranch);
  }

  const result = await deps.gh.deleteFile({
    path,
    sha: file.sha,
    message: `content: remove ${input.slug} (${input.locale})`,
    branch: deps.config.baseBranch,
  });

  return {
    slug: input.slug,
    locale: input.locale,
    path,
    commitSha: result.commitSha,
    status: "deleted",
    // 자산은 자동 삭제하지 않는다 — 다른 로케일이 참조 중일 수 있다.
    remainingAssets: `public/images/${input.slug}/`,
    note:
      `이미지는 지우지 않았습니다 (public/images/${input.slug}/). ` +
      `다른 로케일이 참조 중일 수 있으니 직접 확인하세요. 복구는 git 히스토리에서 가능합니다.`,
  };
}

// --------------------------------------------------------------- upload_asset

export const UploadAssetInput = z.object({
  slug: SlugSchema,
  filename: z.string().min(1),
  contentBase64: z.string().min(1),
  maxBytes: z.number().int().positive().optional(),
});
export type UploadAssetInput = z.infer<typeof UploadAssetInput>;

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export async function uploadAsset(input: UploadAssetInput, deps: Deps) {
  // 핸들러 안에서 다시 검사한다 — 스키마만 믿지 않는다.
  const { assertAllowedAssetFilename, assetPath, assetUrl } = await import(
    "../content/paths.js"
  );

  const filename = assertAllowedAssetFilename(input.filename);
  const path = assertAllowedPath(assetPath(input.slug, filename));

  const bytes = Buffer.from(input.contentBase64, "base64");
  const limit = input.maxBytes ?? DEFAULT_MAX_BYTES;

  if (bytes.byteLength === 0) {
    throw new ToolError("VALIDATION_FAILED", "이미지 데이터가 비어 있습니다.");
  }
  if (bytes.byteLength > limit) {
    throw new ToolError(
      "VALIDATION_FAILED",
      `이미지가 너무 큽니다 (${(bytes.byteLength / 1024).toFixed(0)}kB > ${(limit / 1024).toFixed(0)}kB). ` +
        `리사이즈하거나 maxBytes 를 올리세요.`,
    );
  }

  if (deps.config.dryRun) {
    return {
      path,
      url: assetUrl(input.slug, filename),
      bytes: bytes.byteLength,
      status: "dry-run" as const,
      note: "MCP_DRY_RUN=true 이므로 업로드하지 않았습니다.",
    };
  }

  const existing = await deps.gh.getFile(path, deps.config.baseBranch);

  const commit = await deps.gh.putFile({
    path,
    content: input.contentBase64,
    message: `content: add asset ${filename} for ${input.slug}`,
    branch: deps.config.baseBranch,
    ...(existing ? { sha: existing.sha } : {}),
  });

  return {
    path,
    url: assetUrl(input.slug, filename),
    bytes: bytes.byteLength,
    commitSha: commit.fileSha,
    status: "uploaded" as const,
    ...(existing ? { note: "같은 이름의 파일을 덮어썼습니다." } : {}),
  };
}

/** splitMdx 재수출 — 테스트 편의 */
export { splitMdx };
