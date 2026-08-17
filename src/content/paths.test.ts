import { describe, expect, it } from "vitest";

import { ToolError } from "../errors.js";
import {
  assertAllowedAssetFilename,
  assertAllowedPath,
  assetPath,
  assetUrl,
  parsePostPath,
  postPath,
} from "./paths.js";

/**
 * ★ 이 파일의 테스트가 저장소 쓰기 범위를 지킨다 (docs/SECURITY.md T3).
 *   여기가 뚫리면 토큰 권한 전체가 노출된다.
 */

describe("assertAllowedPath — 허용", () => {
  it.each([
    "content/posts/ko/foo.mdx",
    "content/posts/en/some-long-slug.mdx",
    "public/images/foo/cover.webp",
    "public/images/foo/bar/baz.png",
  ])("%s", (p) => {
    expect(assertAllowedPath(p)).toBe(p);
  });
});

describe("assertAllowedPath — 거부", () => {
  it.each([
    ["경로 이탈 (CI 설정 탈취)", "content/posts/../../.github/workflows/evil.yml"],
    ["경로 이탈 (한 단계)", "content/posts/../package.json"],
    ["중간 이탈", "content/posts/ko/../../../etc/passwd"],
    ["절대 경로", "/etc/passwd"],
    ["프리픽스 밖", "src/index.ts"],
    ["루트 파일", "package.json"],
    ["워크플로 직접", ".github/workflows/ci.yml"],
    ["빈 문자열", ""],
    ["상위 디렉터리", ".."],
    ["백슬래시 우회", "content\\posts\\..\\..\\evil.txt"],
    ["프리픽스 유사품", "content/posts-evil/x.mdx"],
    ["프리픽스 접두 흉내", "public/imagesevil/x.png"],
  ])("%s: %s", (_label, p) => {
    expect(() => assertAllowedPath(p)).toThrow(ToolError);
  });

  it("널바이트를 거부한다", () => {
    expect(() => assertAllowedPath("content/posts/ko/a\0.mdx")).toThrow(ToolError);
  });

  it("거부 시 PATH_NOT_ALLOWED 코드를 낸다", () => {
    try {
      assertAllowedPath("../../etc/passwd");
      expect.unreachable("던졌어야 한다");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).code).toBe("PATH_NOT_ALLOWED");
    }
  });
});

describe("assertAllowedAssetFilename", () => {
  it.each(["cover.webp", "diagram-1.png", "shot.jpeg", "anim.gif", "photo.AVIF"])(
    "허용: %s",
    (name) => {
      expect(assertAllowedAssetFilename(name)).toBe(name);
    },
  );

  it.each([
    ["경로 구분자", "../evil.png"],
    ["하위 경로", "a/b.png"],
    ["백슬래시", "a\\b.png"],
    ["숨김 파일", ".env"],
    ["확장자 없음", "README"],
    ["실행 가능 확장자", "evil.html"],
    ["스크립트", "evil.js"],
    ["MDX 위장", "post.mdx"],
    ["상위 디렉터리", ".."],
  ])("거부: %s (%s)", (_label, name) => {
    expect(() => assertAllowedAssetFilename(name)).toThrow(ToolError);
  });

  it("SVG 는 거부한다 (스크립트 삽입 가능 — SECURITY T8)", () => {
    expect(() => assertAllowedAssetFilename("icon.svg")).toThrow(ToolError);
  });
});

describe("경로 조립", () => {
  it("postPath 는 계약 형식을 따른다", () => {
    expect(postPath("ko", "foo")).toBe("content/posts/ko/foo.mdx");
    expect(postPath("en", "foo")).toBe("content/posts/en/foo.mdx");
  });

  it("assetPath 와 assetUrl 은 짝이 맞는다", () => {
    expect(assetPath("foo", "cover.webp")).toBe("public/images/foo/cover.webp");
    // frontmatter 에 들어가는 것은 public 기준 절대경로다.
    expect(assetUrl("foo", "cover.webp")).toBe("/images/foo/cover.webp");
  });

  it("조립한 경로는 항상 allowlist 를 통과한다", () => {
    expect(() => assertAllowedPath(postPath("ko", "foo"))).not.toThrow();
    expect(() => assertAllowedPath(assetPath("foo", "a.png"))).not.toThrow();
  });
});

describe("parsePostPath", () => {
  it("계약 경로를 되돌린다", () => {
    expect(parsePostPath("content/posts/ko/foo.mdx")).toEqual({
      locale: "ko",
      slug: "foo",
    });
  });

  it.each([
    "content/posts/ko/nested/foo.mdx",
    "content/posts/foo.mdx",
    "content/posts/ko/foo.md",
    "public/images/foo/a.png",
  ])("형식이 다르면 null: %s", (p) => {
    expect(parsePostPath(p)).toBeNull();
  });
});
