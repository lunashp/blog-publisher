import { beforeEach, describe, expect, it } from "vitest";

import { MemoryGitHub } from "../github/memory.js";
import { serializeMdx } from "../content/serialize.js";
import type { PostFrontmatter } from "../content/schema.js";
import type { Deps } from "./deps.js";
import {
  generateSlugTool,
  getPost,
  listPosts,
  validateFrontmatterTool,
} from "./read.js";

const DESC =
  "이 설명은 50자 이상이어야 검증을 통과합니다. 충분히 길게 적어서 최소 길이 제약을 만족시킵니다.";

const post = (overrides: Partial<PostFrontmatter> = {}): string =>
  serializeMdx(
    {
      title: "글",
      description: DESC,
      date: "2026-01-01",
      draft: false,
      tags: [],
      related: [],
      ...overrides,
    } as PostFrontmatter,
    "## 증상\n\n본문",
  );

const FILES = {
  "content/posts/ko/alpha.mdx": post({
    title: "알파",
    date: "2026-03-01",
    tags: ["nextjs", "react"],
  }),
  "content/posts/en/alpha.mdx": post({ title: "Alpha", date: "2026-03-01", tags: ["nextjs"] }),
  "content/posts/ko/beta.mdx": post({ title: "베타", date: "2026-05-01", tags: ["pnpm"] }),
  "content/posts/ko/hidden.mdx": post({ title: "숨김", date: "2026-06-01", draft: true }),
};

let gh: MemoryGitHub;
let deps: Deps;

beforeEach(() => {
  gh = new MemoryGitHub({ files: FILES });
  deps = {
    gh,
    config: {
      token: "t",
      owner: "o",
      repo: "r",
      siteUrl: "https://example.com",
      baseBranch: "main",
      dryRun: false,
    },
    now: () => new Date("2026-08-20T00:00:00Z"),
  };
});

describe("list_posts", () => {
  it("전 로케일을 최신순으로 반환한다", async () => {
    const { posts, total } = await listPosts({ status: "all", limit: 50 }, deps);

    expect(total).toBe(4);
    expect(posts[0]?.slug).toBe("hidden"); // 2026-06-01
    expect(posts.map((p) => p.date)).toEqual([...posts.map((p) => p.date)].sort().reverse());
  });

  it("로케일로 거른다", async () => {
    const { posts } = await listPosts({ locale: "en", status: "all", limit: 50 }, deps);

    expect(posts).toHaveLength(1);
    expect(posts[0]?.locale).toBe("en");
  });

  it("status=published 는 draft 를 뺀다", async () => {
    const { posts } = await listPosts({ status: "published", limit: 50 }, deps);

    expect(posts.map((p) => p.slug)).not.toContain("hidden");
    expect(posts.every((p) => !p.draft)).toBe(true);
  });

  it("status=draft 는 draft 만 낸다", async () => {
    const { posts } = await listPosts({ status: "draft", limit: 50 }, deps);

    expect(posts.map((p) => p.slug)).toEqual(["hidden"]);
  });

  it("태그로 거른다", async () => {
    const { posts } = await listPosts({ status: "all", tag: "pnpm", limit: 50 }, deps);

    expect(posts.map((p) => p.slug)).toEqual(["beta"]);
  });

  it("limit 을 적용하되 total 은 전체를 센다", async () => {
    const { posts, total } = await listPosts({ status: "all", limit: 2 }, deps);

    expect(posts).toHaveLength(2);
    expect(total).toBe(4);
  });

  it("★ update_post 에 필요한 commitSha 를 함께 준다", async () => {
    const { posts } = await listPosts({ status: "all", limit: 50 }, deps);

    expect(posts.every((p) => p.commitSha.length > 0)).toBe(true);
  });

  it("빈 저장소에서도 안전하다", async () => {
    deps.gh = new MemoryGitHub({ files: {} });

    await expect(listPosts({ status: "all", limit: 50 }, deps)).resolves.toEqual({
      posts: [],
      total: 0,
    });
  });
});

describe("get_post", () => {
  it("frontmatter·본문·commitSha 를 반환한다", async () => {
    const result = await getPost({ slug: "alpha", locale: "ko" }, deps);

    expect(result.frontmatter.title).toBe("알파");
    expect(result.body).toContain("## 증상");
    expect(result.commitSha.length).toBeGreaterThan(0);
    expect(result.path).toBe("content/posts/ko/alpha.mdx");
  });

  it("★ 번역이 있는 로케일만 알려준다", async () => {
    await expect(getPost({ slug: "alpha", locale: "ko" }, deps)).resolves.toMatchObject({
      availableLocales: ["ko", "en"],
    });
    await expect(getPost({ slug: "beta", locale: "ko" }, deps)).resolves.toMatchObject({
      availableLocales: ["ko"],
    });
  });

  it("없는 글은 NOT_FOUND 이고 다음 행동을 알려준다", async () => {
    await expect(getPost({ slug: "nope", locale: "ko" }, deps)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(getPost({ slug: "nope", locale: "ko" }, deps)).rejects.toThrow(/list_posts/);
  });
});

describe("validate_frontmatter", () => {
  it("유효하면 정규화 결과를 준다", async () => {
    const result = await validateFrontmatterTool(
      {
        frontmatter: { title: "제목", description: DESC, date: "2026-08-17", draft: true },
      },
      deps,
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("★ 아무것도 쓰지 않는다", async () => {
    await validateFrontmatterTool({ frontmatter: { title: "제목" } }, deps);

    expect(gh.writes).toHaveLength(0);
  });

  it("무효하면 필드별 오류를 준다", async () => {
    const result = await validateFrontmatterTool(
      { frontmatter: { title: "제목", description: "짧음" } },
      deps,
    );

    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.field)).toContain("description");
  });

  it("★ related 가 없는 글을 가리키면 경고한다 (오류는 아님)", async () => {
    const result = await validateFrontmatterTool(
      {
        frontmatter: {
          title: "제목",
          description: DESC,
          date: "2026-08-17",
          draft: true,
          related: ["alpha", "does-not-exist"],
        },
        locale: "ko",
      },
      deps,
    );

    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.message).toContain("does-not-exist");
  });
});

describe("generate_slug", () => {
  it("영문 제목에서 슬러그를 만든다", async () => {
    const result = await generateSlugTool({ title: "A brand new post", locale: "ko" }, deps);

    expect(result.slug).toBe("a-brand-new-post");
    expect(result.available).toBe(true);
  });

  it("★ 충돌 시 자동으로 번호를 붙이지 않고 사실을 알린다", async () => {
    const result = await generateSlugTool({ title: "alpha", locale: "ko" }, deps);

    expect(result.available).toBe(false);
    expect(result.slug).toBe("alpha");
    expect(result.conflictsWith).toEqual({
      locale: "ko",
      path: "content/posts/ko/alpha.mdx",
    });
    // -2 같은 접미사를 붙이지 않았다.
    expect(result.slug).not.toMatch(/-\d$/);
  });

  it("★ 한국어 제목이면 영문 슬러그를 요구한다", async () => {
    const result = await generateSlugTool({ title: "하이드레이션 오류", locale: "ko" }, deps);

    expect(result.needsEnglishSlug).toBe(true);
    expect(result.slug).toBeUndefined();
    expect(result.reason).toContain("영문");
  });

  it("★ 아무것도 쓰지 않는다", async () => {
    await generateSlugTool({ title: "Something new", locale: "ko" }, deps);

    expect(gh.writes).toHaveLength(0);
  });
});
