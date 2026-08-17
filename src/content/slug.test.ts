import { describe, expect, it } from "vitest";

import { SlugSchema } from "./schema.js";
import { generateSlug, truncateSlug } from "./slug.js";

describe("generateSlug", () => {
  it.each([
    ["Next.js hydration mismatch", "nextjs-hydration-mismatch"],
    ["What's the fix?", "whats-the-fix"],
    ["  Trailing and leading  ", "trailing-and-leading"],
    ["Multiple   spaces", "multiple-spaces"],
    ["UPPER Case", "upper-case"],
    ["v2 API changes", "v2-api-changes"],
  ])("%s → %s", (title, expected) => {
    const result = generateSlug(title);

    expect(result.slug).toBe(expected);
    expect(result.needsEnglishSlug).toBe(false);
    expect(SlugSchema.safeParse(result.slug).success).toBe(true);
  });

  it("★ 한국어 제목은 자동 음차하지 않고 영문 슬러그를 요구한다", () => {
    const result = generateSlug("하이드레이션 미스매치가 나는 이유");

    expect(result.slug).toBeUndefined();
    expect(result.needsEnglishSlug).toBe(true);
    expect(result.reason).toContain("영문 슬러그");
  });

  it("한글+영문 혼합이면 영문 부분으로 만든다", () => {
    const result = generateSlug("Next.js 16에서 hydration mismatch");

    expect(result.slug).toBe("nextjs-16-hydration-mismatch");
    expect(result.needsEnglishSlug).toBe(false);
  });

  it("빈 제목을 거부한다", () => {
    expect(generateSlug("   ").needsEnglishSlug).toBe(true);
  });

  it("기호만 있는 제목을 거부한다", () => {
    expect(generateSlug("!!! ???").needsEnglishSlug).toBe(true);
  });

  it("3자 미만이 되면 거부한다 (슬러그 최소 길이)", () => {
    expect(generateSlug("Go").needsEnglishSlug).toBe(true);
  });

  it("생성된 슬러그는 항상 계약 스키마를 통과한다", () => {
    for (const title of [
      "A very long title with many words that goes on",
      "hyphen---collapse",
      "trailing hyphen -",
    ]) {
      const result = generateSlug(title);
      if (result.slug) {
        expect(SlugSchema.safeParse(result.slug).success).toBe(true);
      }
    }
  });
});

describe("truncateSlug", () => {
  it("제한 이하는 그대로 둔다", () => {
    expect(truncateSlug("short-slug")).toBe("short-slug");
  });

  it("단어 경계에서 자른다", () => {
    const long = `${"word-".repeat(30)}end`;
    const cut = truncateSlug(long);

    expect(cut.length).toBeLessThanOrEqual(80);
    expect(cut.endsWith("-")).toBe(false);
    expect(SlugSchema.safeParse(cut).success).toBe(true);
  });

  it("자른 결과도 계약을 만족한다", () => {
    const cut = truncateSlug("a".repeat(200));
    expect(SlugSchema.safeParse(cut).success).toBe(true);
  });
});
