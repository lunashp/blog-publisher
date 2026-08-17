import { describe, expect, it } from "vitest";

import { ToolError } from "../errors.js";
import { parseMdx, serializeMdx, splitMdx, validateFrontmatter } from "./serialize.js";
import type { PostFrontmatter } from "./schema.js";

const base: PostFrontmatter = {
  title: "테스트 글",
  description:
    "이 설명은 50자 이상이어야 검증을 통과합니다. 충분히 길게 적어서 최소 길이 제약을 만족시킵니다.",
  date: "2026-08-17",
  draft: true,
  tags: [],
  related: [],
};

describe("splitMdx", () => {
  it("frontmatter 와 본문을 분리한다", () => {
    const raw = "---\ntitle: 제목\n---\n\n## 증상\n\n본문";
    const { data, body } = splitMdx(raw);

    expect(data.title).toBe("제목");
    expect(body.trim()).toBe("## 증상\n\n본문");
  });
});

describe("parseMdx", () => {
  it("올바른 글을 파싱한다", () => {
    const raw = serializeMdx(base, "## 증상\n\n본문");
    const parsed = parseMdx(raw);

    expect(parsed.frontmatter.title).toBe("테스트 글");
    expect(parsed.body.trim()).toBe("## 증상\n\n본문");
  });

  it("★ 계약 위반이면 필드별 오류와 함께 던진다", () => {
    const raw = "---\ntitle: 제목\ndescription: 너무 짧음\ndate: 2026-08-17\ndraft: false\n---\n\n본문";

    try {
      parseMdx(raw);
      expect.unreachable("던졌어야 한다");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      const e = error as ToolError;
      expect(e.code).toBe("VALIDATION_FAILED");
      expect(e.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: "description" })]),
      );
    }
  });
});

describe("serializeMdx — 왕복 안정성", () => {
  it("★ parse → serialize → parse 가 값을 보존한다", () => {
    const full: PostFrontmatter = {
      ...base,
      summary: "TL;DR 한 줄 요약",
      updated: "2026-08-20",
      tags: ["nextjs", "react"],
      category: "troubleshooting",
      series: "nextjs-debugging",
      related: ["other-post"],
      canonical: "https://example.com/original",
      cover: { src: "/images/x/cover.webp", alt: "설명" },
    };
    const body = "## 증상\n\n본문입니다.";

    const once = parseMdx(serializeMdx(full, body));
    const twice = parseMdx(serializeMdx(once.frontmatter, once.body));

    expect(once.frontmatter).toEqual(full);
    expect(twice.frontmatter).toEqual(full);
    expect(twice.body.trim()).toBe(body);
  });

  it("직렬화가 결정적이다 (같은 입력 → 같은 문자열)", () => {
    expect(serializeMdx(base, "본문")).toBe(serializeMdx(base, "본문"));
  });

  it("키 순서를 고정한다 — diff 안정성", () => {
    const out = serializeMdx({ ...base, summary: "요약", category: "note" }, "본문");
    const keys = out
      .split("---")[1]!
      .split("\n")
      .filter((l) => /^\w+:/.test(l))
      .map((l) => l.split(":")[0]);

    // tags/related 는 기본값 [] 이 있어 항상 출력된다.
    expect(keys).toEqual([
      "title",
      "description",
      "summary",
      "date",
      "draft",
      "tags",
      "category",
      "related",
    ]);
  });

  it("빈 배열을 인라인으로 쓴다", () => {
    expect(serializeMdx(base, "본문")).toContain("tags: []");
  });

  it("한국어를 불필요하게 인용하지 않는다", () => {
    const out = serializeMdx(base, "본문");
    expect(out).toContain("title: 테스트 글");
  });

  it("YAML 특수문자가 있으면 인용한다", () => {
    const out = serializeMdx({ ...base, title: "a: b #c" }, "본문");
    expect(out).toContain('title: "a: b #c"');
    // 왕복해도 값이 유지되어야 한다.
    expect(parseMdx(out).frontmatter.title).toBe("a: b #c");
  });

  it("따옴표가 든 제목도 왕복한다", () => {
    const title = 'He said "hi"';
    const out = serializeMdx({ ...base, title }, "본문");
    expect(parseMdx(out).frontmatter.title).toBe(title);
  });

  it("중첩 객체(cover)를 들여쓴다", () => {
    const out = serializeMdx(
      { ...base, cover: { src: "/images/x/c.webp", alt: "설명" } },
      "본문",
    );
    expect(out).toContain("cover:\n  src: /images/x/c.webp\n  alt: 설명");
  });

  it("본문 앞뒤 공백을 정규화하고 개행으로 끝난다", () => {
    const out = serializeMdx(base, "\n\n\n본문\n\n\n");
    expect(out).toContain("---\n\n본문\n");
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
  });
});

describe("validateFrontmatter", () => {
  it("유효하면 정규화 결과를 준다", () => {
    const result = validateFrontmatter({
      title: "제목",
      description: "a".repeat(60),
      date: "2026-08-17",
      draft: true,
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      // 기본값이 채워진다.
      expect(result.normalized.tags).toEqual([]);
      expect(result.normalized.related).toEqual([]);
    }
  });

  it("무효하면 던지지 않고 오류 목록을 준다", () => {
    const result = validateFrontmatter({ title: "" });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.every((e) => e.field && e.message)).toBe(true);
    }
  });
});
