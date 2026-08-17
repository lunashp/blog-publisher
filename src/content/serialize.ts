import matter from "gray-matter";

import { ToolError } from "../errors.js";
import {
  PostFrontmatterSchema,
  toIssues,
  type PostFrontmatter,
  type ValidationIssue,
} from "./schema.js";

/**
 * MDX 파일 ⇄ { frontmatter, body } 변환.
 *
 * 직렬화는 gray-matter 의 stringify 를 쓰지 않고 직접 만든다 —
 * js-yaml 기본 출력은 한국어에 불필요한 따옴표·줄바꿈을 넣고 키 순서가 뒤바뀐다.
 * 사람이 git diff 로 읽는 파일이므로 안정적인 순서와 형식이 중요하다.
 */

/** frontmatter 키 출력 순서. diff 안정성을 위해 고정한다. */
const KEY_ORDER = [
  "title",
  "description",
  "summary",
  "date",
  "updated",
  "draft",
  "tags",
  "category",
  "series",
  "related",
  "canonical",
  "cover",
] as const;

export interface ParsedPost {
  frontmatter: PostFrontmatter;
  body: string;
}

/** 검증 없이 원시 frontmatter 와 본문만 분리한다. */
export function splitMdx(raw: string): { data: Record<string, unknown>; body: string } {
  const parsed = matter(raw);
  return { data: parsed.data as Record<string, unknown>, body: parsed.content };
}

/** 분리 + 계약 검증. 실패하면 필드별 오류 목록과 함께 던진다. */
export function parseMdx(raw: string, context = "글"): ParsedPost {
  const { data, body } = splitMdx(raw);
  const result = PostFrontmatterSchema.safeParse(data);

  if (!result.success) {
    const issues = toIssues(result.error);
    throw new ToolError(
      "VALIDATION_FAILED",
      `${context}의 frontmatter 가 계약을 만족하지 않습니다: ` +
        issues.map((i) => `${i.field} — ${i.message}`).join("; "),
      issues,
    );
  }

  return { frontmatter: result.data, body };
}

/** 검증만 수행하고 오류 목록을 반환한다 (아무것도 던지지 않음). */
export function validateFrontmatter(
  data: unknown,
): { valid: true; normalized: PostFrontmatter } | { valid: false; errors: ValidationIssue[] } {
  const result = PostFrontmatterSchema.safeParse(data);
  return result.success
    ? { valid: true, normalized: result.data }
    : { valid: false, errors: toIssues(result.error) };
}

/** YAML 스칼라 인용 규칙 — 필요할 때만 따옴표를 씌운다. */
function yamlScalar(value: string): string {
  const needsQuote =
    value === "" ||
    /^[\s]|[\s]$/.test(value) ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(value) ||
    /: |#/.test(value) ||
    /^(true|false|null|~|yes|no|on|off)$/i.test(value) ||
    /^-?\d/.test(value);

  if (!needsQuote) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function yamlValue(key: string, value: unknown, indent = ""): string[] {
  if (value === undefined) return [];

  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}${key}: []`];
    return [
      `${indent}${key}:`,
      ...value.map((item) => `${indent}  - ${yamlScalar(String(item))}`),
    ];
  }

  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return [];
    return [
      `${indent}${key}:`,
      ...entries.flatMap(([k, v]) => yamlValue(k, v, `${indent}  `)),
    ];
  }

  if (typeof value === "boolean" || typeof value === "number") {
    return [`${indent}${key}: ${String(value)}`];
  }

  return [`${indent}${key}: ${yamlScalar(String(value))}`];
}

/**
 * frontmatter + 본문 → MDX 문자열.
 *
 * 키 순서를 고정하고, 본문은 정확히 한 줄 띄운 뒤 붙인다.
 * 왕복(parse → serialize → parse) 시 의미가 보존되어야 한다.
 */
export function serializeMdx(frontmatter: PostFrontmatter, body: string): string {
  const record = frontmatter as unknown as Record<string, unknown>;

  const ordered = KEY_ORDER.flatMap((key) => yamlValue(key, record[key]));

  // KEY_ORDER 에 없는 키가 생기면 순서 뒤에 붙인다 (계약 확장 대비).
  const extra = Object.keys(record)
    .filter((key) => !(KEY_ORDER as readonly string[]).includes(key))
    .sort()
    .flatMap((key) => yamlValue(key, record[key]));

  const normalizedBody = body.replace(/^\n+/, "").replace(/\s+$/, "");

  return `---\n${[...ordered, ...extra].join("\n")}\n---\n\n${normalizedBody}\n`;
}
