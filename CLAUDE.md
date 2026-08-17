# CLAUDE.md — blog-publisher

[`jiny-log`](../jiny-log/) 블로그에 마크다운 글을 발행하는 **MCP 서버**.
Claude Code / Claude Desktop 안에서 "이 글 블로그에 올려줘" 라고 하면 GitHub에 커밋되고 Vercel이 배포한다.

**이 서버는 사용자의 공개 블로그에 쓰기 권한을 가진 도구다.** 잘못 동작하면 미완성 글이 공개되거나 기존 글이 덮어써진다. 편의보다 안전을 우선한다.

---

## 문서 인덱스

| 문서 | 언제 읽나 |
|---|---|
| [`docs/PRD.md`](./docs/PRD.md) | 무엇을 왜 만드는지 |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | 발행 아키텍처 선택 근거, 모듈 구조 |
| [`docs/TOOLS.md`](./docs/TOOLS.md) | **도구 표면 명세 (스키마·반환·어노테이션)** |
| [`docs/SECURITY.md`](./docs/SECURITY.md) | **토큰 권한, 위협 모델 — 쓰기 도구 만들기 전 필독** |
| [`docs/PLAN.md`](./docs/PLAN.md) | Phase별 구현 계획 |
| [`../jiny-log/docs/CONTENT-CONTRACT.md`](../jiny-log/docs/CONTENT-CONTRACT.md) | **frontmatter·경로 계약 — 단일 진실 공급원** |

---

## 고정 스택 (임의 변경 금지)

| 항목 | 값 | 근거 |
|---|---|---|
| 런타임 | Node 24 | 로컬 확인: v24.11.0 |
| 패키지 매니저 | pnpm 10 | |
| 언어 | TypeScript strict, ESM | |
| MCP SDK | **`@modelcontextprotocol/server` 2.0.0 (v2)** | 실측 확정 — 아래 참조 |
| 트랜스포트 | **stdio** | 로컬 실행 도구. 네트워크 노출 없음 |
| 스키마 | `zod` **4.4.3** — 캐럿 없이 핀 | v2 는 Standard Schema 를 요구하며 zod v4 가 이를 구현한다 |
| GitHub | `@octokit/rest` 22.x | |
| frontmatter | `gray-matter` 4.0.3 | 2023-07 이후 배포 없음. 성숙·안정적이나 **사실상 동면 상태** — 문제가 생기면 교체 대상 |
| 테스트 | `vitest` 4.x | |

### ✅ MCP SDK — v2 확정 (2026-08-17 실측)

**`@modelcontextprotocol/server` 2.0.0 (v2) 을 쓴다.** 추측이 아니라 측정 결과다.

#### 측정 방법

최소 v2 서버를 만들어 `claude mcp add` 로 등록하고 실제 연결 로그를 읽었다.
로그 위치: `~/Library/Caches/claude-cli-nodejs/<cwd>/mcp-logs-<서버명>/`

```
"protocolEra":"modern","negotiatedProtocolVersion":"2026-07-28"
```

Claude Code **2.1.233** 은 v2 서버와 **modern era / 2026-07-28** 로 협상한다.
같은 시점 기존 v1 서버 9개는 전부 `"protocolEra":"legacy"` / `2025-11-25` 였다 —
즉 legacy 는 **서버가 v1 이라서** 그렇게 내려간 것이지 클라이언트 한계가 아니었다.

> **초기 설계 문서의 전제가 틀렸다.** "클라이언트가 아직 2025-11-25 만 협상한다"는
> 2026-04 시점 정보였고, 실측에서 뒤집혔다. Phase 0 에서 실측하도록 계획을 바꿔둔 것이 맞았다.

#### v2 를 쓰는 이유

1. **legacy 도 같이 서빙한다.** `serveStdio` 가 opening 을 보고 era 를 고르며, 같은 factory 로
   2025-era 클라이언트도 그대로 처리한다. v1 대비 잃는 호환성이 없다.
2. 신규 프로젝트를 구세대에서 시작할 이유가 없다.

#### v2 API 주의점 (실측에서 걸린 것)

- **`inputSchema` 는 zod v4 스키마여야 한다.** 원시 JSON Schema 객체를 넘기면
  `initialize` 자체가 `-32603 Internal server error` 로 실패한다 —
  툴 등록 실패가 연결 실패로 나타나므로 원인을 찾기 어렵다.
  JSON Schema 를 써야 하면 `fromJsonSchema()` 로 변환한다.
- 진입점은 `serveStdio(factory, options)` 다. v1 의 `new Server()` + `transport.connect()` 형태가 아니다.
- `LATEST_PROTOCOL_VERSION` 은 `2025-11-25` 로 보인다 — 이건 **legacy era 의 최신값**이고,
  modern era 는 `initialize` 를 쓰지 않아 이 상수에 나타나지 않는다. 헷갈리지 말 것.

#### 재확인이 필요한 시점

Claude Code 를 크게 업데이트한 뒤 연결이 깨지면 위 로그 경로에서
`protocolEra` / `negotiatedProtocolVersion` 을 다시 확인한다.

**SSE 트랜스포트는 공식 deprecated 다. v2 에서는 별도 레거시 패키지로 분리됐다. 쓰지 않는다.**

### ⚠️ zod 버전 핀

`zod` 를 **직접 dependency 로 선언하고 캐럿 없이 정확한 버전(`4.4.3`)으로 고정**한다.

1. v2 SDK 는 `inputSchema` 에 **Standard Schema** 를 요구하고, zod **v4** 가 이를 구현한다.
   zod v3 는 `~standard.jsonSchema` 가 없어 쓸 수 없다.
2. pnpm strict 격리에서 peer 해석이 어긋나 `ERR_MODULE_NOT_FOUND` 가 나는 사례가 보고됐다
   (`modelcontextprotocol/servers` issue #4288) — 직접 선언이 이를 피한다.
3. 범위(`^4`)로 두면 마이너 업데이트가 조용히 스키마 동작을 바꿀 수 있다.

```jsonc
// package.json
"dependencies": {
  "zod": "4.4.3"   // ← 캐럿 없음. 올릴 때는 의도적으로.
}
```

> jiny-log 도 zod v4 를 쓴다(Astro 7 이 v4 를 번들). 두 저장소의 계약 스키마가
> 같은 zod 세대라 코드를 거의 그대로 옮길 수 있다.

---

## 절대 불변식 (깨면 안 되는 것)

이 5가지는 편의를 위해서도 예외를 두지 않는다.

### 1. draft-by-default

**`create_draft` 는 항상 `draft: true` 로 쓴다.** 입력에 `draft: false` 가 와도 무시한다.

`draft: true → false` 전이는 **오직 `publish_post`** 로만 일어난다. 다른 도구가 이 전이를 수행하면 계약 위반이다.

이유: 이 서버는 LLM이 호출한다. 웹페이지 요약 같은 작업 중 프롬프트 인젝션에 걸리면 의도치 않은 발행이 일어날 수 있다. **생성과 발행을 물리적으로 분리**해 두면, 발행에는 사용자가 도구 이름을 대고 요청하는 별도 턴이 필요해진다.

### 2. 경로 allowlist를 핸들러 내부에서 강제

쓰기 대상은 **`content/posts/` 와 `public/images/` 프리픽스만** 허용한다.

```ts
// 입력을 믿지 않는다. 정규화 후 검사한다.
const normalized = path.posix.normalize(inputPath);
if (normalized.includes("..") || !ALLOWED_PREFIXES.some(p => normalized.startsWith(p))) {
  throw new ToolError("경로가 허용 범위를 벗어났습니다");
}
```

zod 스키마의 `.startsWith()` 만으로 끝내지 않는다. `content/posts/../../.github/workflows/x.yml` 같은 입력이 스키마를 통과할 수 있다.

### 3. 검증 없이 커밋에 도달하는 경로가 없다

모든 쓰기 도구는 Octokit 호출 **직전에** `PostFrontmatterSchema` 검증을 통과시킨다. "이미 `validate_frontmatter` 에서 검사했으니 생략"은 안 된다 — 도구는 독립적으로 호출된다.

### 4. 토큰은 어디에도 새지 않는다

- 로그에 찍지 않는다
- 도구 반환값에 넣지 않는다
- 에러 메시지에 요청/응답 본문을 그대로 담지 않는다 (헤더에 토큰이 있다)
- stdio 트랜스포트에서 **`console.log` 를 쓰지 않는다** — stdout은 JSON-RPC 채널이다. 진단 출력은 `console.error`(stderr)로만.

### 5. 덮어쓰기는 낙관적 동시성으로 막는다

`update_post` / `delete_post` 는 호출자가 마지막으로 읽은 `commitSha` 를 함께 보내야 한다. 서버가 현재 값과 대조해 다르면 **거부**하고 "다시 읽어라"를 반환한다.

이유: LLM이 오래된 컨텍스트를 들고 수정을 시도할 수 있다. 그 사이 다른 경로로 글이 바뀌었다면 조용히 덮어쓰는 것이 최악이다.

---

## 코드 구조 규칙

### 핸들러는 배선과 분리된 순수 함수로

`server.registerTool()` 배선 안에 로직을 넣지 않는다. 로직은 별도 모듈의 export된 함수로 두고, 배선은 그것을 호출만 한다.

```ts
// ❌ 테스트 불가
server.registerTool("create_draft", {...}, async (input) => {
  const octokit = new Octokit(...);
  // 여기에 50줄
});

// ✅
// src/tools/create-draft.ts
export async function createDraft(input: CreateDraftInput, deps: Deps): Promise<CreateDraftResult> { ... }

// src/server.ts
server.registerTool("create_draft", CREATE_DRAFT_SPEC, (input) => wrap(createDraft(input, deps)));
```

의존성(Octokit 클라이언트, 설정, 시각)은 **인자로 주입**한다. 모듈 스코프에서 생성하지 않는다 — 테스트에서 모킹이 불가능해진다.

### 디렉터리

```
src/
├── index.ts              # 엔트리: 설정 로드 → serveStdio(factory)
├── server.ts             # registerTool 배선만
├── tools/                # 도구별 순수 핸들러 (1파일 1도구)
├── github/               # Octokit 어댑터 (커밋·PR·파일 읽기)
├── content/              # frontmatter 스키마·직렬화·슬러그
├── config/               # 환경변수 로드·검증
└── errors.ts
```

파일 200–400줄 권장, **800줄 초과 금지**.

### 도구 이름은 `verb_noun`, snake_case

`create_draft`, `publish_post`, `list_posts`. 명세는 [`docs/TOOLS.md`](./docs/TOOLS.md) 가 단일 출처다.

### API는 `registerTool` + zod 스키마

```ts
server.registerTool(
  "create_draft",
  {
    title: "...",
    description: "...",          // LLM 이 읽는 유일한 사용법
    inputSchema: z.object({ ... }),  // ★ zod v4 객체. 원시 JSON Schema 금지
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  handler,
);
```

**`inputSchema` 에 원시 JSON Schema 를 넘기면 `initialize` 가 `-32603` 로 실패한다.**
툴 등록 실패가 "연결 실패"로 나타나 원인 추적이 어려우니 주의한다.

### 어노테이션은 힌트일 뿐이다

`destructiveHint`, `readOnlyHint`, `idempotentHint` 는 **강제력이 없다.** 클라이언트 UI에 정보를 줄 뿐 아무것도 막지 않는다. **실제 가드는 전부 핸들러 안에** 있어야 한다. 어노테이션을 달았으니 안전하다고 생각하면 안 된다.

### 도구 설명문에 부작용을 명시한다

LLM이 읽는 유일한 사용법이다. 애매하면 잘못 호출된다.

```
❌ "블로그 글을 만듭니다"
✅ "새 글을 초안(draft)으로 브랜치에 커밋하고 PR을 엽니다. 항상 draft=true로
    생성되며 라이브로 나가지 않습니다. 발행하려면 publish_post를 별도로 호출하세요.
    반환값에 Vercel 프리뷰 URL이 포함됩니다."
```

---

## 콘텐츠 계약

frontmatter 스키마·파일 경로·슬러그 규칙은 [`../jiny-log/docs/CONTENT-CONTRACT.md`](../jiny-log/docs/CONTENT-CONTRACT.md) 가 **단일 진실 공급원**이다.

- 이 저장소의 Zod 스키마는 그 문서의 구현체다. **한쪽만 바꾸면 발행이 조용히 깨진다.**
- 계약을 바꿔야 하면 양쪽 저장소를 함께 수정하고 계약 버전을 올린다.
- 서버는 시작 시 자신이 구현한 계약 버전을 stderr에 로그로 남긴다.

---

## 커맨드

```bash
pnpm dev              # tsx watch
pnpm build            # tsc → dist/
pnpm typecheck
pnpm lint
pnpm test             # vitest
pnpm inspect          # npx @modelcontextprotocol/inspector node dist/index.js
```

## 환경변수

| 이름 | 필수 | 설명 |
|---|:---:|---|
| `GITHUB_TOKEN` | ✅ | fine-grained PAT. Contents RW + Metadata RO, 블로그 저장소 **단일** |
| `BLOG_REPO` | ✅ | `owner/repo` |
| `BLOG_SITE_URL` | ✅ | 발행 URL 생성용 |
| `BLOG_BASE_BRANCH` | ➖ | 기본 `main` |
| `MCP_DRY_RUN` | ➖ | `true` 면 모든 쓰기가 커밋 직전에 멈추고 diff만 반환 |

시작 시 필수 변수를 검증하고, 없으면 **명확한 메시지와 함께 즉시 종료**한다. 토큰 없이 조용히 동작하다 첫 쓰기에서 실패하지 않는다.

---

## 커밋 컨벤션

```
<type>: <description>
```
`feat` / `fix` / `refactor` / `docs` / `test` / `chore` / `ci`

블로그 저장소에 만드는 커밋은 **`content:`** 타입을 쓴다 (jiny-log 규약과 동일):

```
content: add "Next.js 16에서 hydration mismatch가 나는 진짜 이유" (ko)
content: publish nextjs-hydration-mismatch (ko)
content: update nextjs-hydration-mismatch (ko)
```

---

## 하지 말 것

| 금지 | 이유 |
|---|---|
| `console.log` 사용 | stdout이 JSON-RPC 채널. 프로토콜이 깨진다. `console.error` 만 |
| `inputSchema` 에 원시 JSON Schema 전달 | v2 는 zod v4 스키마를 요구한다. `initialize` 가 -32603 으로 실패 |
| SSE 트랜스포트 | 공식 deprecated. v2 에서는 별도 레거시 패키지로 분리됨 |
| 로컬 `git` 셸아웃 | 클론 상태 의존. Octokit API를 쓴다 |
| `create_draft` 에서 바로 발행 | 불변식 1 위반 |
| 모듈 스코프에서 Octokit 생성 | 테스트 모킹 불가 |
| 에러에 요청 헤더 포함 | 토큰 유출 |
| 슬러그 충돌 시 말없이 `-2` 붙이기 | 사용자가 모르는 URL이 생긴다. 충돌을 반환하고 결정을 넘긴다 |
| 한글 슬러그 자동 음차 생성 | 검색·인용 가치가 낮다. 영문 슬러그를 요구한다 |
