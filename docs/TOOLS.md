# 도구 표면 명세 — blog-publisher

- 작성일: 2026-08-17
- **이 문서가 도구 명세의 단일 출처다.** 구현이 여기서 벗어나면 문서를 먼저 고친다.
- frontmatter 필드 규격은 [`CONTENT-CONTRACT.md`](../../jiny-log/docs/CONTENT-CONTRACT.md)

---

## 0. 공통 규약

### 어노테이션은 힌트일 뿐이다

`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint` 는 **클라이언트 UI에 정보를 줄 뿐 아무것도 강제하지 않는다.** 실제 가드는 전부 핸들러 안에 있어야 한다. 어노테이션을 달았다고 안전해지지 않는다.

### 설명문 작성 원칙

도구 설명은 **LLM이 읽는 유일한 사용법**이다. 애매하면 잘못 호출된다.

- 부작용을 문장으로 명시한다 ("항상 draft로 생성되며 라이브로 나가지 않습니다")
- 다음에 무엇을 해야 하는지 안내한다 ("발행하려면 publish_post를 별도로 호출하세요")
- 반환값에 무엇이 들어있는지 밝힌다

### 공통 반환 형태

모든 도구는 `content: [{ type: "text", text: JSON.stringify(result) }]` 로 구조화 데이터를 반환한다. 쓰기 도구의 결과에는 최소한 다음이 들어간다.

```ts
interface WriteResult {
  slug: string;
  locale: "ko" | "en";
  path: string;            // content/posts/ko/foo.mdx
  commitSha: string;       // 이후 update/delete에 필요
  status: "draft" | "published" | "deleted" | "dry-run";
  prUrl?: string;
  previewUrl?: string;     // 미확정이면 생략 — 추측 URL을 확정처럼 주지 않는다
  liveUrl?: string;        // published 일 때만
}
```

### 공통 입력 타입

```ts
const Locale = z.enum(["ko", "en"]);

// CONTENT-CONTRACT.md §2·§3과 동일. 길이 제한을 빠뜨리면 규칙이 산문에만 남는다.
const Slug = z.string().min(3).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

// 자산은 public 기준 절대경로만 허용 (CONTENT-CONTRACT.md §1)
const Cover = z.object({
  src: z.string().startsWith("/images/"),
  alt: z.string().min(1),
});
```

---

## 1. 읽기 도구

### `list_posts`

글 목록을 조회한다.

```ts
inputSchema: z.object({
  locale: Locale.optional(),                                  // 생략 시 전체
  status: z.enum(["draft", "published", "all"]).default("all"),
  tag: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50),
})
```

**설명문**
> 블로그의 글 목록을 조회합니다. 초안과 발행된 글을 모두 볼 수 있으며 로케일·태그·상태로 필터링할 수 있습니다. 아무것도 변경하지 않습니다.

**어노테이션**: `readOnlyHint: true`, `openWorldHint: false`

**반환**
```ts
{ posts: Array<{ slug, locale, title, date, updated?, draft, tags, path, commitSha }>, total: number }
```

---

### `get_post`

글 하나의 frontmatter와 본문을 가져온다.

```ts
inputSchema: z.object({ slug: Slug, locale: Locale })
```

**설명문**
> 글 하나의 frontmatter와 본문 전체를 가져옵니다. 반환값의 commitSha는 update_post나 delete_post를 호출할 때 반드시 함께 보내야 하므로, 글을 수정하기 전에는 항상 이 도구를 먼저 호출하세요.

**어노테이션**: `readOnlyHint: true`

**반환**
```ts
{ slug, locale, path, commitSha, frontmatter: {...}, body: string,
  availableLocales: Locale[] }   // 번역 존재 여부
```

---

### `validate_frontmatter`

**아무것도 쓰지 않고** 검증만 한다.

```ts
inputSchema: z.object({
  frontmatter: z.record(z.unknown()),
  locale: Locale.optional(),
})
```

**설명문**
> frontmatter가 블로그의 콘텐츠 계약을 만족하는지 검사합니다. 저장소에 아무것도 쓰지 않으며 오류 목록만 반환합니다. create_draft 전에 미리 확인할 때 사용하세요.

**어노테이션**: `readOnlyHint: true`, `openWorldHint: false`

**반환**
```ts
{ valid: boolean,
  errors: Array<{ field: string, message: string }>,
  warnings: Array<{ field: string, message: string }>,  // 예: related의 슬러그가 없음
  normalized?: {...} }   // valid일 때 정규화된 결과
```

---

### `generate_slug`

제목에서 슬러그를 만들고 충돌을 확인한다.

```ts
inputSchema: z.object({
  title: z.string().min(1),
  locale: Locale,
})
```

**설명문**
> 제목에서 URL 슬러그를 생성하고 기존 글과 충돌하는지 확인합니다. 슬러그는 항상 영문 ASCII여야 하므로, 한국어 제목만 주어지면 슬러그를 만들지 않고 영문 슬러그를 요청합니다. 충돌 시 자동으로 번호를 붙이지 않고 충돌 사실을 반환합니다.

**어노테이션**: `readOnlyHint: true`

**반환**
```ts
{ slug?: string,
  available: boolean,
  conflictsWith?: { locale: Locale, path: string },
  needsEnglishTitle?: boolean }   // 한국어 제목만 온 경우 true
```

> **한글 자동 음차를 하지 않는 이유:** 음차 슬러그(`hidereisyeon-mismaechi`)는 아무도 검색하지 않고 AI가 인용하기에도 나쁘다. 영문 슬러그를 요구하는 편이 낫다.

---

## 2. 쓰기 도구

### `create_draft`

**가장 자주 쓰이는 도구.** 새 글을 초안으로 만든다.

```ts
inputSchema: z.object({
  title:       z.string().min(1).max(120),
  body:        z.string().min(1),          // 마크다운 본문. frontmatter 블록 제외
  locale:      Locale,
  description: z.string().min(50).max(300),
  summary:     z.string().max(500).optional(),
  slug:        Slug.optional(),            // 생략 시 title에서 유도
  date:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),  // 생략 시 오늘
  tags:        z.array(z.string().regex(/^[a-z0-9-]+$/)).max(8).default([]),
  category:    z.enum(["troubleshooting", "insight", "note", "retrospective"]).optional(),
  series:      z.string().optional(),
  related:     z.array(Slug).max(5).default([]),
  canonical:   z.string().url().optional(),
  cover:       Cover.optional(),
})
```

**설명문**
> 새 글을 초안(draft)으로 브랜치에 커밋하고 PR을 엽니다. **항상 draft=true로 생성되며 라이브 사이트에 나가지 않습니다.** 발행하려면 사용자가 프리뷰를 확인한 뒤 publish_post를 별도로 호출해야 합니다. 반환값에 PR 링크와 (확보된 경우) Vercel 프리뷰 URL이 포함됩니다. 같은 슬러그의 글이 이미 있으면 덮어쓰지 않고 실패합니다.

**어노테이션**: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`

**핸들러 불변식**
- 입력에 `draft` 필드를 받지 않는다. **항상 `true` 로 강제**한다
- 기존 파일이 있으면 `SLUG_CONFLICT` 로 실패. 덮어쓰지 않는다
- `cover` 가 있으면 `alt` 필수 (스키마가 강제하지만 핸들러에서도 확인)
- 브랜치명: `post/<locale>-<slug>`
- 커밋 메시지: `content: add "<title>" (<locale>)`

---

### `publish_post`

**라이브 전환은 오직 이 도구로만.**

```ts
inputSchema: z.object({
  slug: Slug,
  locale: Locale,
})
```

**설명문**
> 초안을 라이브로 발행합니다. frontmatter의 draft를 false로 바꾸고 기본 브랜치에 반영하며, 몇 분 뒤 공개 사이트에 나타납니다. **이 도구는 글을 공개합니다 — 사용자가 명시적으로 발행을 요청했을 때만 호출하세요.** 이미 발행된 글에 호출하면 아무것도 바꾸지 않고 성공을 반환합니다.

**어노테이션**: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`

**핸들러 불변식**
- 이미 `draft: false` 면 no-op 성공 (멱등)
- 발행 전 frontmatter 재검증. 실패하면 발행하지 않는다
- 커밋 메시지: `content: publish <slug> (<locale>)`
- 반환에 `liveUrl` 포함. 다만 **배포 완료까지 1~3분 걸린다는 사실을 status에 명시**

---

### `update_post`

```ts
inputSchema: z.object({
  slug:   Slug,
  locale: Locale,
  expectedCommitSha: z.string().min(7),   // ★ 필수. get_post에서 받은 값
  body:        z.string().optional(),
  title:       z.string().min(1).max(120).optional(),
  description: z.string().min(50).max(300).optional(),
  summary:     z.string().max(500).optional(),
  tags:        z.array(z.string().regex(/^[a-z0-9-]+$/)).max(8).optional(),
  category:    z.enum(["troubleshooting","insight","note","retrospective"]).optional(),
  series:      z.string().optional(),
  related:     z.array(Slug).max(5).optional(),
  canonical:   z.string().url().optional(),
  cover:       Cover.optional(),
})
```

**설명문**
> 기존 글의 본문이나 메타데이터를 수정합니다. **먼저 get_post를 호출해 현재 commitSha를 받아 expectedCommitSha로 전달해야 합니다** — 그 사이 글이 바뀌었으면 덮어쓰지 않고 거부합니다. 지정한 필드만 바뀌고 나머지는 유지됩니다. 발행일(date)은 변경되지 않으며 수정일(updated)이 오늘 날짜로 자동 기록됩니다. draft 상태는 바뀌지 않습니다.

**어노테이션**: `readOnlyHint: false`, **`destructiveHint: true`**, `idempotentHint: false`

**핸들러 불변식**
- `expectedCommitSha` 불일치 → `STALE_CONTENT` 로 거부, 재읽기 지시
- `date` 불변
- `updated` = **서버 시각**. 호출자가 보낸 값은 받지도 않는다
- `draft` 상태 불변 (입력 필드 자체가 없다)
- 커밋 메시지: `content: update <slug> (<locale>)`

---

### `unpublish_post`

```ts
inputSchema: z.object({ slug: Slug, locale: Locale })
```

**설명문**
> 발행된 글을 다시 초안으로 되돌립니다. 파일은 삭제되지 않고 draft=true로만 바뀌며, 다음 배포부터 공개 사이트에서 사라집니다. 되돌리려면 publish_post를 호출하세요.

**어노테이션**: `readOnlyHint: false`, **`destructiveHint: true`**, `idempotentHint: true`

---

### `delete_post`

```ts
inputSchema: z.object({
  slug: Slug,
  locale: Locale,
  expectedCommitSha: z.string().min(7),
  confirmSlug: Slug,      // slug와 정확히 일치해야 함
})
```

**설명문**
> 글 파일을 저장소에서 삭제합니다. **되돌리려면 git 히스토리를 직접 다뤄야 합니다.** 대부분의 경우 unpublish_post로 비공개 전환하는 것이 적절하며, 삭제는 사용자가 명시적으로 삭제를 요청했을 때만 사용하세요. 실수 방지를 위해 confirmSlug에 슬러그를 한 번 더 입력해야 합니다.

**어노테이션**: `readOnlyHint: false`, **`destructiveHint: true`**, `idempotentHint: true`

**핸들러 불변식**
- `confirmSlug !== slug` → 거부
- `expectedCommitSha` 대조
- 연결된 `public/images/<slug>/` 는 **자동 삭제하지 않는다.** 반환값에 남은 자산 경로를 알려주고 판단을 넘긴다

> `confirmSlug` 를 두는 이유: 어노테이션은 아무것도 막지 못한다. 실제 마찰은 스키마로 만든다.

---

### `upload_asset`

```ts
inputSchema: z.object({
  slug:     Slug,
  filename: z.string().regex(/^[a-z0-9][a-z0-9._-]*\.(png|jpe?g|webp|avif|gif|svg)$/i),
  contentBase64: z.string(),
  maxBytes: z.number().int().optional(),   // 기본 5MB
})
```

**설명문**
> 이미지를 public/images/<slug>/ 에 커밋하고, 글 본문이나 cover에서 쓸 수 있는 경로를 반환합니다. 반환된 경로를 update_post로 본문에 넣으세요. 같은 이름의 파일이 있으면 덮어씁니다.

**어노테이션**: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`

**핸들러 불변식**
- 확장자 allowlist (스키마 + 핸들러 이중 확인)
- 파일명 정규화 후 경로 이탈 검사
- 크기 상한 초과 시 거부
- 반환 경로는 `/images/<slug>/<filename>` (public 기준)

---

## 3. 도구 요약표

| 도구 | readOnly | destructive | idempotent | 비고 |
|---|:---:|:---:|:---:|---|
| `list_posts` | ✅ | — | — | |
| `get_post` | ✅ | — | — | **수정 전 필수 선행** |
| `validate_frontmatter` | ✅ | — | — | 아무것도 안 씀 |
| `generate_slug` | ✅ | — | — | 충돌 시 자동 번호 안 붙임 |
| `create_draft` | ❌ | false | false | **항상 draft=true** |
| `publish_post` | ❌ | false | ✅ | **라이브 전환 유일 경로** |
| `update_post` | ❌ | ✅ | ❌ | `expectedCommitSha` 필수 |
| `unpublish_post` | ❌ | ✅ | ✅ | 파일 유지 |
| `delete_post` | ❌ | ✅ | ✅ | `confirmSlug` 필수 |
| `upload_asset` | ❌ | false | ✅ | 동명 파일 덮어씀 |

---

## 4. 의도적으로 만들지 않는 도구

| 만들지 않음 | 이유 |
|---|---|
| `create_and_publish` | 초안·발행 분리가 이 도구의 핵심 안전장치다. 합치면 무의미해진다 |
| `create_draft(publish: true)` | 위와 동일. 옵션으로도 우회로를 만들지 않는다 |
| `delete_all_drafts` 등 일괄 삭제 | 한 번의 잘못된 호출로 회복 불가능한 손실. 필요하면 개별 호출한다 |
| `run_command` / 임의 파일 쓰기 | 경로 allowlist의 존재 이유를 무너뜨린다 |
| `generate_post` (내용 생성) | 이 서버는 운반 도구다. 글은 사용자와 Claude가 대화로 쓴다 |

---

## 5. 전형적인 호출 흐름

```
초안 작성
  generate_slug ──▶ validate_frontmatter ──▶ create_draft
                                                  │
                                          프리뷰 URL 반환
                                                  │
                                    (사람이 확인 — 별도 턴)
                                                  │
                                            publish_post

수정
  get_post (commitSha 확보) ──▶ update_post

이미지 추가
  upload_asset ──▶ get_post ──▶ update_post (본문에 경로 삽입)
```
