import { z } from "zod";

import { ToolError } from "../errors.js";
import { LOCALES, LocaleSchema, SlugSchema, type Locale } from "../content/schema.js";
import { parsePostPath, postDir, postPath } from "../content/paths.js";
import { splitMdx, validateFrontmatter } from "../content/serialize.js";
import { generateSlug, truncateSlug } from "../content/slug.js";
import type { Deps } from "./deps.js";

/**
 * 읽기 도구 — 아무것도 쓰지 않는다 (docs/TOOLS.md §1).
 */

// ---------------------------------------------------------------- list_posts

export const ListPostsInput = z.object({
  locale: LocaleSchema.optional(),
  status: z.enum(["draft", "published", "all"]).default("all"),
  tag: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export type ListPostsInput = z.infer<typeof ListPostsInput>;

export interface PostListItem {
  slug: string;
  locale: Locale;
  title: string;
  date: string;
  updated?: string;
  draft: boolean;
  tags: string[];
  path: string;
  /** update_post / delete_post 에 필요한 낙관적 동시성 키 */
  commitSha: string;
}

export async function listPosts(
  input: ListPostsInput,
  deps: Deps,
): Promise<{ posts: PostListItem[]; total: number }> {
  const locales: readonly Locale[] = input.locale ? [input.locale] : LOCALES;
  const collected: PostListItem[] = [];

  for (const locale of locales) {
    const entries = await deps.gh.listDir(postDir(locale));

    for (const entry of entries) {
      if (entry.type !== "file" || !entry.name.endsWith(".mdx")) continue;

      const file = await deps.gh.getFile(entry.path);
      if (!file) continue;

      const { data } = splitMdx(file.content);
      const parsed = parsePostPath(entry.path);
      if (!parsed) continue;

      const draft = data.draft === true;
      const tags = Array.isArray(data.tags) ? (data.tags as string[]) : [];

      if (input.status === "draft" && !draft) continue;
      if (input.status === "published" && draft) continue;
      if (input.tag && !tags.includes(input.tag)) continue;

      collected.push({
        slug: parsed.slug,
        locale,
        title: typeof data.title === "string" ? data.title : "(제목 없음)",
        date: typeof data.date === "string" ? data.date : "",
        ...(typeof data.updated === "string" ? { updated: data.updated } : {}),
        draft,
        tags,
        path: entry.path,
        commitSha: file.sha,
      });
    }
  }

  collected.sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));

  return { posts: collected.slice(0, input.limit), total: collected.length };
}

// ------------------------------------------------------------------ get_post

export const GetPostInput = z.object({
  slug: SlugSchema,
  locale: LocaleSchema,
});
export type GetPostInput = z.infer<typeof GetPostInput>;

export async function getPost(input: GetPostInput, deps: Deps) {
  const path = postPath(input.locale, input.slug);
  const file = await deps.gh.getFile(path);

  if (!file) {
    throw new ToolError(
      "NOT_FOUND",
      `글을 찾을 수 없습니다: ${input.locale}/${input.slug}. ` +
        `list_posts 로 실제 슬러그를 확인하세요.`,
    );
  }

  const { data, body } = splitMdx(file.content);

  // 다른 로케일에 번역이 있는지 — 언어 전환·hreflang 판단에 쓴다.
  const availableLocales: Locale[] = [];
  for (const locale of LOCALES) {
    const found = await deps.gh.getFile(postPath(locale, input.slug));
    if (found) availableLocales.push(locale);
  }

  return {
    slug: input.slug,
    locale: input.locale,
    path,
    /** ★ update_post / delete_post 에 그대로 넘겨야 하는 값 */
    commitSha: file.sha,
    frontmatter: data,
    body,
    availableLocales,
  };
}

// ------------------------------------------------------- validate_frontmatter

export const ValidateFrontmatterInput = z.object({
  frontmatter: z.record(z.string(), z.unknown()),
  locale: LocaleSchema.optional(),
});
export type ValidateFrontmatterInput = z.infer<typeof ValidateFrontmatterInput>;

export async function validateFrontmatterTool(
  input: ValidateFrontmatterInput,
  deps: Deps,
) {
  const result = validateFrontmatter(input.frontmatter);

  if (!result.valid) {
    return { valid: false as const, errors: result.errors, warnings: [] };
  }

  // related 가 실제 존재하는 글을 가리키는지 — 경고로만 알린다.
  const warnings: Array<{ field: string; message: string }> = [];
  const locale = input.locale;

  if (locale && result.normalized.related.length > 0) {
    for (const [index, slug] of result.normalized.related.entries()) {
      const found = await deps.gh.getFile(postPath(locale, slug));
      if (!found) {
        warnings.push({
          field: `related[${index}]`,
          message: `"${slug}" 글이 ${locale} 에 없습니다. 렌더링 시 조용히 제외됩니다.`,
        });
      }
    }
  }

  return { valid: true as const, errors: [], warnings, normalized: result.normalized };
}

// -------------------------------------------------------------- generate_slug

export const GenerateSlugInput = z.object({
  title: z.string().min(1),
  locale: LocaleSchema,
});
export type GenerateSlugInput = z.infer<typeof GenerateSlugInput>;

export async function generateSlugTool(input: GenerateSlugInput, deps: Deps) {
  const result = generateSlug(input.title);

  if (result.needsEnglishSlug || !result.slug) {
    return {
      available: false,
      needsEnglishSlug: true,
      reason: result.reason,
    };
  }

  const slug = truncateSlug(result.slug);

  // ★ 충돌 시 말없이 -2 를 붙이지 않는다. 사용자가 모르는 URL 이 생긴다.
  for (const locale of LOCALES) {
    const existing = await deps.gh.getFile(postPath(locale, slug));
    if (existing) {
      return {
        slug,
        available: false,
        needsEnglishSlug: false,
        conflictsWith: { locale, path: postPath(locale, slug) },
        reason:
          `"${slug}" 는 이미 ${locale} 에 있습니다. ` +
          `다른 슬러그를 정하거나, 같은 글의 번역이라면 그대로 써도 됩니다.`,
      };
    }
  }

  return { slug, available: true, needsEnglishSlug: false };
}
