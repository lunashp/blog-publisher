import { SlugSchema } from "./schema.js";

/**
 * 슬러그 생성 (../jiny-log/docs/CONTENT-CONTRACT.md §2).
 *
 * ★ 한국어 제목을 자동 음차하지 않는다.
 *   음차 슬러그(`hidereisyeon-mismaechi`)는 아무도 검색하지 않고 AI 가 인용하기에도 나쁘다.
 *   영문 슬러그를 요구하는 편이 낫다.
 */

const HANGUL = /[ㄱ-ㆎ가-힣]/;

export interface SlugResult {
  slug?: string;
  /** 한국어 제목뿐이라 슬러그를 만들 수 없는 경우 */
  needsEnglishSlug: boolean;
  reason?: string;
}

export function generateSlug(title: string): SlugResult {
  const trimmed = title.trim();

  if (trimmed.length === 0) {
    return { needsEnglishSlug: true, reason: "제목이 비어 있습니다." };
  }

  // 라틴 영숫자만 남긴다. 한글·기호는 버린다.
  const candidate = trimmed
    .toLowerCase()
    // 아포스트로피와 단어 내부의 점은 지운다 —
    // "Next.js" 는 next-js 가 아니라 nextjs 여야 관례에 맞는다.
    .replace(/['']/g, "")
    .replace(/(?<=[a-z0-9])\.(?=[a-z0-9])/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (candidate.length === 0 || !SlugSchema.safeParse(candidate).success) {
    const reason = HANGUL.test(trimmed)
      ? "제목이 한국어라 자동 생성할 수 없습니다. 검색·인용 가치가 낮은 음차 대신 " +
        "영문 슬러그를 직접 지정하세요 (예: nextjs-hydration-mismatch)."
      : "제목에서 유효한 슬러그를 만들 수 없습니다. 영문 슬러그를 직접 지정하세요.";
    return { needsEnglishSlug: true, reason };
  }

  return { slug: candidate, needsEnglishSlug: false };
}

/** 80자 제한에 맞춰 단어 경계에서 자른다. */
export function truncateSlug(slug: string, max = 80): string {
  if (slug.length <= max) return slug;
  const cut = slug.slice(0, max);
  const lastDash = cut.lastIndexOf("-");
  return (lastDash > max * 0.5 ? cut.slice(0, lastDash) : cut).replace(/-+$/, "");
}
