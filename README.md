# blog-publisher

[지니로그(jiny-log)](../jiny-log/) 블로그에 글을 발행하는 **MCP 서버**.

Claude Code / Claude Desktop 안에서 "이 글 블로그에 올려줘" 라고 하면, 마크다운이 검증을 거쳐 GitHub에 커밋되고 Vercel이 배포한다.

```
Claude Code ──MCP──▶ blog-publisher ──Octokit──▶ GitHub ──자동배포──▶ Vercel
```

> **상태: Phase 0–5 구현 완료.** 도구 10종이 동작하고 테스트 143개가 통과한다.
> 남은 것은 Phase 6(실제 PAT 발급·등록·발행 왕복 검증).

---

## 핵심 설계 원칙

**초안 생성과 발행은 물리적으로 분리되어 있다.**

`create_draft` 는 **항상** `draft: true` 로 만들고, 라이브 전환은 오직 `publish_post` 로만 일어난다. 두 도구를 합치거나 `publish: true` 옵션을 두지 않는다.

이유: 이 서버는 LLM이 호출한다. 웹페이지 요약 같은 작업 중 프롬프트 인젝션에 걸려도, 발행에는 사용자가 도구 이름을 대는 **별도의 턴**이 필요하다. 이 마찰이 이 도구의 가장 중요한 안전장치다.

---

## 문서

| 문서 | 내용 |
|---|---|
| [`CLAUDE.md`](./CLAUDE.md) | **에이전트 작업 규칙 — 코드 작성 전 필독** |
| [`docs/PRD.md`](./docs/PRD.md) | 목적, 사용 시나리오, 범위 |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | 발행 아키텍처 선택 근거, 모듈 구조, 오류 규약 |
| [`docs/TOOLS.md`](./docs/TOOLS.md) | **도구 명세 (스키마·반환·어노테이션)** |
| [`docs/SECURITY.md`](./docs/SECURITY.md) | **토큰 권한, 위협 모델 — 쓰기 도구 전 필독** |
| [`docs/PLAN.md`](./docs/PLAN.md) | Phase별 구현 계획 |
| [`../jiny-log/docs/CONTENT-CONTRACT.md`](../jiny-log/docs/CONTENT-CONTRACT.md) | **frontmatter·경로 계약 (단일 진실 공급원)** |

**처음 읽는 순서:** `PRD` → `ARCHITECTURE` → `CONTENT-CONTRACT` → `TOOLS` → `SECURITY` → `PLAN`

---

## 도구

| 도구 | 하는 일 |
|---|---|
| `list_posts` | 글 목록 조회 |
| `get_post` | 글 하나 읽기 (**수정 전 필수** — commitSha 확보) |
| `validate_frontmatter` | 쓰지 않고 검증만 |
| `generate_slug` | 슬러그 생성 + 충돌 확인 |
| `create_draft` | **초안 생성** (항상 draft) → PR + 프리뷰 URL |
| `publish_post` | **발행** (라이브 전환 유일 경로) |
| `update_post` | 수정 (commitSha 대조, `updated` 자동 각인) |
| `unpublish_post` | 비공개 전환 (파일 유지) |
| `delete_post` | 삭제 (confirmSlug 필요) |
| `upload_asset` | 이미지 업로드 |

상세 스키마는 [`docs/TOOLS.md`](./docs/TOOLS.md).

---

## 설치 · 실행

```bash
pnpm install
pnpm build          # → dist/index.js

pnpm dev            # tsx watch
pnpm lint
pnpm typecheck
pnpm test           # 143개 (유닛 + 실제 프로세스 end-to-end)
pnpm inspect        # MCP Inspector 로 도구 수동 테스트
```

> `src/server.test.ts` 는 빌드 산출물을 실제 프로세스로 띄워 stdio JSON-RPC 를 주고받는다.
> **`pnpm build` 이후에 돌려야 한다** (CI 순서도 그렇게 잡혀 있다).

### 환경변수

| 이름 | 필수 | 설명 |
|---|:---:|---|
| `GITHUB_TOKEN` | ✅ | fine-grained PAT (Contents RW + PR RW, **블로그 저장소 하나만**) |
| `BLOG_REPO` | ✅ | `owner/repo` |
| `BLOG_SITE_URL` | ✅ | 발행 URL 생성용. 예: `https://example.com` |
| `BLOG_BASE_BRANCH` | ➖ | 기본 `main` |
| `MCP_DRY_RUN` | ➖ | `true` 면 실제 쓰기 없이 diff만 반환 |

**토큰은 커밋되는 파일에 넣지 않는다.** macOS Keychain 권장. 상세는 [`docs/SECURITY.md`](./docs/SECURITY.md) §2.

---

## 등록

### Claude Code

```bash
claude mcp add --transport stdio blog-publisher -- node /절대경로/blog-publisher/dist/index.js
```

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`

```jsonc
{
  "mcpServers": {
    "blog-publisher": {
      "command": "node",
      "args": ["/절대경로/blog-publisher/dist/index.js"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}",
        "BLOG_REPO": "owner/jiny-log",
        "BLOG_SITE_URL": "https://example.com"
      }
    }
  }
}
```

> `env` 에 토큰 **원문**을 적지 않는다. 프로젝트 스코프 `.mcp.json` 은 커밋을 전제로 하므로 특히 위험하다.

---

## 사용 예

```
사용자: 방금 고친 hydration 문제 블로그 초안으로 만들어줘

  → generate_slug → validate_frontmatter → create_draft
  → PR 생성, 프리뷰 URL 반환

사용자: (프리뷰 확인) 좋다, 발행해줘

  → publish_post
  → 1~3분 뒤 https://example.com/ko/posts/nextjs-hydration-mismatch
```

---

## 주의

- **stdout에 아무것도 쓰지 않는다.** stdio 트랜스포트에서 stdout은 JSON-RPC 채널이다. 진단 출력은 stderr로만
- **MCP SDK 는 v2 (`@modelcontextprotocol/server` 2.0.0)** — 실측 결과 Claude Code 2.1.233 이
  **modern era / 2026-07-28** 로 협상한다 ([`CLAUDE.md`](./CLAUDE.md) 참조)
- **`inputSchema` 는 zod v4 스키마여야 한다.** 원시 JSON Schema 를 넘기면 `initialize` 가 -32603 으로 실패한다
- **첫 실행은 반드시 `MCP_DRY_RUN=true`** 로 한다
- 이 서버는 **형식만 검증한다.** 글 내용의 진위(버전 번호, URL, 수치)는 검증할 수 없다 — 발행 전 사람이 프리뷰를 확인해야 하는 이유다
