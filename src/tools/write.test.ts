import { beforeEach, describe, expect, it } from "vitest";

import { ToolError } from "../errors.js";
import { MemoryGitHub } from "../github/memory.js";
import { parseMdx, serializeMdx } from "../content/serialize.js";
import type { PostFrontmatter } from "../content/schema.js";
import type { Deps } from "./deps.js";
import {
  createDraft,
  deletePost,
  publishPost,
  unpublishPost,
  updatePost,
  uploadAsset,
} from "./write.js";

/**
 * ★ docs/ARCHITECTURE.md §8 이 "반드시 테스트로 고정"하라고 명시한 불변식들.
 *   여기가 무너지면 미완성 글이 공개되거나 기존 글이 소실된다.
 */

const DESC = "이 설명은 50자 이상이어야 검증을 통과합니다. 충분히 길게 적어서 최소 길이 제약을 만족시킵니다.";
const FIXED_NOW = new Date("2026-08-20T09:00:00Z");

function makeDeps(options: { files?: Record<string, string>; dryRun?: boolean } = {}) {
  const gh = new MemoryGitHub({ files: options.files ?? {} });
  const deps: Deps = {
    gh,
    config: {
      token: "test-token",
      owner: "o",
      repo: "r",
      siteUrl: "https://example.com",
      baseBranch: "main",
      dryRun: options.dryRun ?? false,
    },
    now: () => FIXED_NOW,
  };
  return { gh, deps };
}

const post = (overrides: Partial<PostFrontmatter> = {}): string =>
  serializeMdx(
    {
      title: "기존 글",
      description: DESC,
      date: "2026-01-01",
      draft: false,
      tags: [],
      related: [],
      ...overrides,
    } as PostFrontmatter,
    "## 증상\n\n본문",
  );

const baseInput = {
  title: "Next.js hydration mismatch",
  body: "## 증상\n\n본문",
  locale: "ko" as const,
  description: DESC,
  tags: [],
  related: [],
};

let gh: MemoryGitHub;
let deps: Deps;

beforeEach(() => {
  ({ gh, deps } = makeDeps());
});

// ═══════════════════════════════════════════════════ 불변식 1: draft-by-default

describe("불변식 1 — draft-by-default", () => {
  it("★ create_draft 는 항상 draft: true 로 쓴다", async () => {
    const result = await createDraft(baseInput, deps);

    expect(result.status).toBe("draft");
    const written = gh.read(result.path, "post/ko-nextjs-hydration-mismatch")!;
    expect(parseMdx(written).frontmatter.draft).toBe(true);
  });

  it("★ 입력에 draft: false 를 끼워넣어도 무시된다", async () => {
    // 스키마가 draft 를 아예 받지 않으므로 통과해도 결과는 draft 여야 한다.
    const result = await createDraft(
      { ...baseInput, draft: false } as never,
      deps,
    );

    const written = gh.read(result.path, "post/ko-nextjs-hydration-mismatch")!;
    expect(parseMdx(written).frontmatter.draft).toBe(true);
  });

  it("★ create_draft 는 기본 브랜치에 쓰지 않는다", async () => {
    await createDraft(baseInput, deps);

    expect(gh.writes.every((w) => w.branch !== "main")).toBe(true);
    expect(gh.read("content/posts/ko/nextjs-hydration-mismatch.mdx", "main")).toBeUndefined();
  });

  it("★ publish_post 만이 draft → false 전이를 수행한다", async () => {
    const created = await createDraft(baseInput, deps);
    const branch = "post/ko-nextjs-hydration-mismatch";

    // update_post 는 draft 를 바꾸지 않는다
    const file = await gh.getFile(created.path, branch);
    await updatePost(
      {
        slug: "nextjs-hydration-mismatch",
        locale: "ko",
        expectedCommitSha: file!.sha,
        title: "제목 변경",
      },
      deps,
    );
    expect(parseMdx(gh.read(created.path, branch)!).frontmatter.draft).toBe(true);

    // publish_post 만이 바꾼다
    await publishPost({ slug: "nextjs-hydration-mismatch", locale: "ko" }, deps);
    expect(parseMdx(gh.read(created.path, "main")!).frontmatter.draft).toBe(false);
  });
});

// ═════════════════════════════════════════════════════ 덮어쓰기·충돌 방지

describe("충돌 방지", () => {
  it("★ 같은 슬러그가 있으면 덮어쓰지 않고 SLUG_CONFLICT 로 실패한다", async () => {
    ({ gh, deps } = makeDeps({
      files: { "content/posts/ko/nextjs-hydration-mismatch.mdx": post({ title: "원본" }) },
    }));

    await expect(createDraft(baseInput, deps)).rejects.toMatchObject({
      code: "SLUG_CONFLICT",
    });
    // 원본이 그대로여야 한다
    expect(gh.read("content/posts/ko/nextjs-hydration-mismatch.mdx")).toContain("원본");
  });

  it("★ update_post 는 commitSha 불일치 시 STALE_CONTENT 로 거부한다", async () => {
    ({ gh, deps } = makeDeps({
      files: { "content/posts/ko/foo.mdx": post({ title: "원본" }) },
    }));

    await expect(
      updatePost(
        { slug: "foo", locale: "ko", expectedCommitSha: "0000000deadbeef", title: "덮어쓰기 시도" },
        deps,
      ),
    ).rejects.toMatchObject({ code: "STALE_CONTENT" });

    expect(gh.read("content/posts/ko/foo.mdx")).toContain("원본");
  });

  it("STALE_CONTENT 메시지가 다음 행동을 알려준다", async () => {
    ({ gh, deps } = makeDeps({ files: { "content/posts/ko/foo.mdx": post() } }));

    await expect(
      updatePost({ slug: "foo", locale: "ko", expectedCommitSha: "1234567abc", title: "x" }, deps),
    ).rejects.toThrow(/get_post/);
  });
});

// ═══════════════════════════════════════════ update_post 의 불변 필드

describe("update_post — 바꾸지 않는 것", () => {
  beforeEach(() => {
    ({ gh, deps } = makeDeps({
      files: {
        "content/posts/ko/foo.mdx": post({ date: "2026-01-01", draft: false, title: "원본" }),
      },
    }));
  });

  it("★ date 를 바꾸지 않는다", async () => {
    const file = await gh.getFile("content/posts/ko/foo.mdx");
    await updatePost(
      { slug: "foo", locale: "ko", expectedCommitSha: file!.sha, title: "새 제목" },
      deps,
    );

    expect(parseMdx(gh.read("content/posts/ko/foo.mdx")!).frontmatter.date).toBe("2026-01-01");
  });

  it("★ updated 를 서버 시각으로 각인한다", async () => {
    const file = await gh.getFile("content/posts/ko/foo.mdx");
    await updatePost(
      { slug: "foo", locale: "ko", expectedCommitSha: file!.sha, title: "새 제목" },
      deps,
    );

    // FIXED_NOW = 2026-08-20
    expect(parseMdx(gh.read("content/posts/ko/foo.mdx")!).frontmatter.updated).toBe("2026-08-20");
  });

  it("★ draft 상태를 유지한다 (published → published)", async () => {
    const file = await gh.getFile("content/posts/ko/foo.mdx");
    await updatePost(
      { slug: "foo", locale: "ko", expectedCommitSha: file!.sha, title: "새 제목" },
      deps,
    );

    expect(parseMdx(gh.read("content/posts/ko/foo.mdx")!).frontmatter.draft).toBe(false);
  });

  it("지정하지 않은 필드는 보존한다", async () => {
    ({ gh, deps } = makeDeps({
      files: {
        "content/posts/ko/foo.mdx": post({ tags: ["a", "b"], category: "insight", summary: "요약" }),
      },
    }));
    const file = await gh.getFile("content/posts/ko/foo.mdx");

    await updatePost(
      { slug: "foo", locale: "ko", expectedCommitSha: file!.sha, title: "새 제목" },
      deps,
    );

    const after = parseMdx(gh.read("content/posts/ko/foo.mdx")!).frontmatter;
    expect(after.tags).toEqual(["a", "b"]);
    expect(after.category).toBe("insight");
    expect(after.summary).toBe("요약");
    expect(after.title).toBe("새 제목");
  });
});

// ═══════════════════════════════════════════════════════ publish 멱등성

describe("publish_post", () => {
  it("★ 이미 발행된 글에 호출하면 no-op 성공 (멱등)", async () => {
    ({ gh, deps } = makeDeps({
      files: { "content/posts/ko/foo.mdx": post({ draft: false }) },
    }));

    const result = await publishPost({ slug: "foo", locale: "ko" }, deps);

    expect(result.status).toBe("published");
    expect(result.note).toContain("이미 발행");
    expect(gh.writes).toHaveLength(0);
  });

  it("발행 후 liveUrl 과 배포 지연 안내를 준다", async () => {
    ({ gh, deps } = makeDeps({
      files: { "content/posts/ko/foo.mdx": post({ draft: true }) },
    }));

    const result = await publishPost({ slug: "foo", locale: "ko" }, deps);

    expect(result.liveUrl).toBe("https://example.com/ko/posts/foo");
    expect(result.note).toContain("1~3분");
  });

  it("없는 글은 NOT_FOUND", async () => {
    await expect(publishPost({ slug: "nope", locale: "ko" }, deps)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

// ══════════════════════════════════════════════════════ unpublish / delete

describe("unpublish_post", () => {
  it("파일을 지우지 않고 draft 로만 돌린다", async () => {
    ({ gh, deps } = makeDeps({
      files: { "content/posts/ko/foo.mdx": post({ draft: false }) },
    }));

    await unpublishPost({ slug: "foo", locale: "ko" }, deps);

    const content = gh.read("content/posts/ko/foo.mdx");
    expect(content).toBeDefined();
    expect(parseMdx(content!).frontmatter.draft).toBe(true);
  });

  it("이미 초안이면 멱등", async () => {
    ({ gh, deps } = makeDeps({ files: { "content/posts/ko/foo.mdx": post({ draft: true }) } }));

    const result = await unpublishPost({ slug: "foo", locale: "ko" }, deps);

    expect(result.note).toContain("이미 초안");
    expect(gh.writes).toHaveLength(0);
  });
});

describe("delete_post", () => {
  beforeEach(() => {
    ({ gh, deps } = makeDeps({ files: { "content/posts/ko/foo.mdx": post() } }));
  });

  it("★ confirmSlug 가 다르면 거부한다", async () => {
    const file = await gh.getFile("content/posts/ko/foo.mdx");

    await expect(
      deletePost(
        { slug: "foo", locale: "ko", expectedCommitSha: file!.sha, confirmSlug: "bar" },
        deps,
      ),
    ).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });

    expect(gh.read("content/posts/ko/foo.mdx")).toBeDefined();
  });

  it("확인이 맞으면 삭제하고 남은 자산을 알려준다", async () => {
    const file = await gh.getFile("content/posts/ko/foo.mdx");

    const result = await deletePost(
      { slug: "foo", locale: "ko", expectedCommitSha: file!.sha, confirmSlug: "foo" },
      deps,
    );

    expect(result.status).toBe("deleted");
    expect(result.remainingAssets).toBe("public/images/foo/");
    expect(gh.read("content/posts/ko/foo.mdx")).toBeUndefined();
  });

  it("★ 이미지를 자동으로 지우지 않는다", async () => {
    ({ gh, deps } = makeDeps({
      files: {
        "content/posts/ko/foo.mdx": post(),
        "public/images/foo/cover.webp": "binary",
      },
    }));
    const file = await gh.getFile("content/posts/ko/foo.mdx");

    await deletePost(
      { slug: "foo", locale: "ko", expectedCommitSha: file!.sha, confirmSlug: "foo" },
      deps,
    );

    expect(gh.read("public/images/foo/cover.webp")).toBe("binary");
  });
});

// ═════════════════════════════════════════════════════════ 경로 이탈 차단

describe("경로 allowlist — 모든 쓰기 도구", () => {
  it("★ 슬러그로 경로를 이탈할 수 없다", async () => {
    // 스키마가 먼저 막지만, 통과하더라도 assertAllowedPath 가 잡아야 한다.
    await expect(
      createDraft({ ...baseInput, slug: "../../.github/workflows/evil" as never }, deps),
    ).rejects.toThrow(ToolError);

    expect(gh.writes).toHaveLength(0);
  });

  it("★ upload_asset 은 파일명으로 이탈할 수 없다", async () => {
    await expect(
      uploadAsset(
        { slug: "foo", filename: "../../../evil.png", contentBase64: "AAAA" },
        deps,
      ),
    ).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
  });

  it("★ upload_asset 은 실행 가능한 확장자를 거부한다", async () => {
    for (const filename of ["evil.html", "evil.js", "evil.svg", "post.mdx"]) {
      await expect(
        uploadAsset({ slug: "foo", filename, contentBase64: "AAAA" }, deps),
      ).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    }
  });

  it("크기 상한을 넘으면 거부한다", async () => {
    const big = Buffer.alloc(200).toString("base64");

    await expect(
      uploadAsset({ slug: "foo", filename: "a.png", contentBase64: big, maxBytes: 100 }, deps),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("정상 업로드는 public 기준 URL 을 반환한다", async () => {
    const result = await uploadAsset(
      { slug: "foo", filename: "cover.webp", contentBase64: Buffer.from("x").toString("base64") },
      deps,
    );

    expect(result.url).toBe("/images/foo/cover.webp");
    expect(result.path).toBe("public/images/foo/cover.webp");
  });
});

// ══════════════════════════════════════════════════════════════ dry-run

describe("MCP_DRY_RUN", () => {
  it("★ 쓰기 API 가 한 번도 호출되지 않는다", async () => {
    ({ gh, deps } = makeDeps({
      dryRun: true,
      files: { "content/posts/ko/foo.mdx": post({ draft: true }) },
    }));
    const file = await gh.getFile("content/posts/ko/foo.mdx");

    await createDraft(baseInput, deps);
    await publishPost({ slug: "foo", locale: "ko" }, deps);
    await updatePost(
      { slug: "foo", locale: "ko", expectedCommitSha: file!.sha, title: "x" },
      deps,
    );
    await unpublishPost({ slug: "foo", locale: "ko" }, deps);
    await uploadAsset({ slug: "foo", filename: "a.png", contentBase64: "AAAA" }, deps);

    expect(gh.writes).toHaveLength(0);
  });

  it("무엇을 쓰려 했는지 미리보기를 준다", async () => {
    ({ gh, deps } = makeDeps({ dryRun: true }));

    const result = (await createDraft(baseInput, deps)) as { preview?: string; status: string };

    expect(result.status).toBe("dry-run");
    expect(result.preview).toContain("title: Next.js hydration mismatch");
    expect(result.preview).toContain("draft: true");
  });

  it("검증은 그대로 수행한다 (차단되는 건 네트워크 쓰기뿐)", async () => {
    ({ gh, deps } = makeDeps({ dryRun: true }));

    await expect(
      createDraft({ ...baseInput, description: "너무 짧음" }, deps),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

// ═════════════════════════════════════════════════════════ 토큰 유출 방지

describe("토큰 유출 방지", () => {
  it("★ 오류 메시지·반환값에 토큰이 없다", async () => {
    ({ gh, deps } = makeDeps({
      files: { "content/posts/ko/nextjs-hydration-mismatch.mdx": post() },
    }));

    const seen: string[] = [];
    try {
      seen.push(JSON.stringify(await createDraft(baseInput, deps)));
    } catch (error) {
      seen.push((error as Error).message, JSON.stringify((error as ToolError).toPayload()));
    }

    for (const text of seen) {
      expect(text).not.toContain("test-token");
    }
  });
});
