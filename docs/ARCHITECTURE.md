# 아키텍처 — blog-publisher

- 작성일: 2026-08-17

---

## 1. 발행 아키텍처 선택

### 검토한 세 가지

| | (a) Git 커밋 → Vercel | (b) API + DB | (c) 헤드리스 CMS |
|---|---|---|---|
| 반영 지연 | 1~3분 (빌드) | **수 초** (`revalidatePath`) | 수 초~분 |
| 초안/프리뷰 | **브랜치 PR → Vercel Preview URL 자동** | 직접 구현 (draft 플래그 + 서명 토큰) | 내장 |
| 수정·롤백 | **git 히스토리·revert·diff 전부 공짜** | 직접 구현 (리비전 테이블) | CMS 기능 |
| 필요 인프라 | 없음 | DB + 인증 Route Handler + 마이그레이션 | CMS 계정 + 웹훅 |
| 블로그 앱 영향 | 없음 (파일 그대로) | **DB에서 글을 읽도록 대규모 개편** | 중간 |
| 비용 | $0 | 무료 티어 있으나 부품 추가 | 계정 추가 |
| 콘텐츠 소유 | 내 저장소의 평문 파일 | DB | 외부 서비스 |

### 채택: (a) Git 커밋 → Vercel 자동배포. GitHub REST API 사용.

**근거**

1. **새 인프라가 0이다.** DB도 CMS 계정도 없다. 개인 블로그에서 부품 하나가 늘면 그만큼 고장날 곳이 는다.
2. **초안 미리보기가 공짜로 나온다.** 브랜치에 커밋하고 PR을 열면 Vercel이 고유 Preview URL을 자동 생성한다. (b)에서 직접 만들어야 할 기능이 여기서는 플랫폼 기본값이다.
3. **git 히스토리가 곧 버전 관리다.** 잘못 발행했으면 `git revert`. 언제 뭘 고쳤는지는 diff로 본다. (b)에서는 리비전 테이블을 직접 설계해야 한다.
4. **1~3분 지연은 문제가 아니다.** 블로그 글을 5초 안에 내보내야 할 이유가 없다. 반면 (b)의 즉시성을 얻으려면 블로그 앱이 파일 대신 DB에서 글을 읽도록 바꿔야 한다 — 비용 대비 이득이 역전된다.
5. **콘텐츠가 내 저장소의 평문 파일로 남는다.** 서비스 종료, 요금제 변경, 마이그레이션 걱정이 없다. 프레임워크를 Astro로 바꿔도 콘텐츠는 그대로다.

**로컬 `git` 셸아웃이 아니라 GitHub REST API(Octokit)를 쓰는 이유**

- 로컬 클론 상태에 의존하지 않는다. 서버가 어느 디렉터리에서 실행되든 동일하게 동작한다
- `git pull` 누락, 더티 워킹 트리, 머지 충돌 같은 로컬 상태 문제가 원천적으로 없다
- 글 1건 = 커밋 1건이 원자적으로 보장된다
- 인증이 PAT 하나로 끝난다 (SSH 키 배포 불필요)

> **향후 (b)를 부분 도입할 여지:** 발행된 글의 오타 수정처럼 메타데이터만 바꾸는 경우에 한해 빠른 경로를 추가할 수 있다. 다만 **처음부터 만들지 않는다.** 지금 필요 없는 복잡도다.

---

## 2. 발행 시퀀스

### 초안 생성 (`create_draft`)

```
입력 (title, body, locale, ...)
  │
  ├─▶ 1. 슬러그 결정 (입력 or 제목에서 유도)
  ├─▶ 2. 기존 파일 충돌 검사 ────────────▶ 충돌 시 중단, 사실을 반환
  ├─▶ 3. frontmatter 조립 (draft: true 강제, date 기본값 = 오늘)
  ├─▶ 4. PostFrontmatterSchema 검증 ─────▶ 실패 시 중단, 오류 목록 반환
  ├─▶ 5. 경로 정규화 + allowlist 검사 ────▶ 이탈 시 중단
  ├─▶ 6. MCP_DRY_RUN? ──────────────────▶ 여기서 멈추고 diff 반환
  ├─▶ 7. 브랜치 생성 (post/<locale>-<slug>)
  ├─▶ 8. 파일 커밋 (content: add "...")
  ├─▶ 9. PR 생성 또는 갱신
  └─▶ 10. 반환 { slug, locale, path, commitSha, prUrl, previewUrl, status: "draft" }
```

### 발행 (`publish_post`)

```
  ├─▶ 1. 대상 파일 읽기 (현재 commitSha 확보)
  ├─▶ 2. draft 상태 확인 ────────────▶ 이미 published면 no-op으로 성공 반환 (멱등)
  ├─▶ 3. frontmatter draft: true → false
  ├─▶ 4. 검증 재실행
  ├─▶ 5. 커밋 (content: publish <slug> (<locale>))
  ├─▶ 6. PR 있으면 머지 / 없으면 base 브랜치에 직접 커밋
  └─▶ 7. 반환 { slug, commitSha, liveUrl, status: "published" }
```

### 수정 (`update_post`)

```
  ├─▶ 1. 입력의 expectedCommitSha 와 원격 현재 sha 대조
  │      └─ 불일치 ─────▶ 거부. "글이 변경되었습니다. get_post로 다시 읽으세요"
  ├─▶ 2. 기존 frontmatter 병합 (date 불변, updated = 오늘로 서버가 각인)
  ├─▶ 3. draft 상태는 그대로 유지 (전이 금지)
  ├─▶ 4. 검증 → 커밋
  └─▶ 5. 반환
```

**핵심: `updated` 는 호출자가 보낸 값을 쓰지 않는다.** 서버가 자기 시각으로 각인한다. LLM이 날짜를 지어낼 여지를 없앤다.

---

## 3. 모듈 구조

```
src/
├── index.ts              # 엔트리. 설정 로드 → 서버 생성 → stdio 연결
├── server.ts             # registerTool 배선만. 로직 없음
├── tools/
│   ├── list-posts.ts
│   ├── get-post.ts
│   ├── validate-frontmatter.ts
│   ├── generate-slug.ts
│   ├── create-draft.ts
│   ├── publish-post.ts
│   ├── update-post.ts
│   ├── unpublish-post.ts
│   ├── delete-post.ts
│   └── upload-asset.ts
├── github/
│   ├── client.ts         # Octokit 팩토리
│   ├── files.ts          # 읽기/쓰기/삭제 (createOrUpdateFileContents)
│   ├── branches.ts
│   ├── pulls.ts
│   └── preview.ts        # PR → Vercel Preview URL 해석
├── content/
│   ├── schema.ts         # PostFrontmatterSchema (CONTENT-CONTRACT 구현체)
│   ├── serialize.ts      # frontmatter + body ⇄ mdx 문자열
│   ├── slug.ts
│   └── paths.ts          # 경로 조립 + allowlist 검사
├── config/
│   └── env.ts            # 환경변수 로드·검증. 시작 시 실패
└── errors.ts             # ToolError 계층
```

### 의존성 주입

핸들러는 순수 함수. 의존성을 인자로 받는다.

```ts
export interface Deps {
  gh: GitHubAdapter;      // 테스트에서 인메모리 구현으로 교체
  config: Config;
  now: () => Date;        // 날짜 고정 테스트를 위해 주입
  dryRun: boolean;
}

export async function createDraft(input: CreateDraftInput, deps: Deps): Promise<CreateDraftResult>
```

모듈 스코프에서 Octokit을 생성하지 않는다 — 테스트에서 모킹이 불가능해진다.

---

## 4. 오류 처리 규약

### 계층

```ts
class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,          // 사용자/LLM이 읽을 메시지. 조치 방법 포함
    readonly details?: unknown // 검증 오류 목록 등 구조화 데이터
  ) { super(message); }
}

type ToolErrorCode =
  | "VALIDATION_FAILED"      // frontmatter 스키마 위반
  | "SLUG_CONFLICT"          // 같은 슬러그 파일이 이미 있음
  | "NOT_FOUND"              // 글 없음
  | "STALE_CONTENT"          // commitSha 불일치
  | "PATH_NOT_ALLOWED"       // allowlist 이탈
  | "GITHUB_ERROR"           // API 실패
  | "CONFIG_ERROR";          // 환경변수 문제
```

### 규칙

1. **메시지에 다음 행동을 담는다.** LLM이 읽고 스스로 복구할 수 있어야 한다.
   ```
   ❌ "Validation failed"
   ✅ "frontmatter 검증 실패: description이 32자입니다 (최소 50자).
       요약을 늘린 뒤 다시 시도하세요."
   ```

2. **`STALE_CONTENT` 는 반드시 재읽기를 지시한다.**
   ```
   "이 글은 마지막으로 읽은 이후 변경되었습니다 (expected a1b2c3, actual d4e5f6).
    get_post로 최신 내용을 읽고 다시 시도하세요."
   ```

3. **GitHub 오류를 그대로 전파하지 않는다.** 요청 헤더에 토큰이 있다. status와 안전한 요약만 남긴다.

4. **부분 성공을 성공으로 보고하지 않는다.** 커밋은 됐는데 PR 생성이 실패했다면, 그 사실을 반환값에 명시한다.

5. 진단 로그는 **stderr로만**. stdout은 JSON-RPC 채널이다.

---

## 5. 프리뷰 URL 확보

Vercel Preview URL은 PR 생성 직후에는 아직 존재하지 않을 수 있다. 세 단계로 처리한다.

1. Vercel의 브랜치 기반 URL 규칙으로 **예측 생성** 시도
2. 실패 시 **PR URL로 폴백** — PR 페이지에 Vercel 봇이 배포 링크를 단다
3. 반환값에 `previewUrl` 과 `prUrl` 을 **둘 다** 담고, 프리뷰가 미확정이면 그 사실을 `status` 에 명시

**예측 URL을 확정 사실처럼 반환하지 않는다.** 아직 안 뜬 URL을 사용자에게 주면 404를 보게 된다.

---

## 6. 상태 전이

[`CONTENT-CONTRACT.md`](../../jiny-log/docs/CONTENT-CONTRACT.md) §6의 구현이다.

```
        create_draft
 (없음) ─────────────▶ draft: true ── publish_post ──▶ draft: false
                           ▲                               │
                           └───── unpublish_post ──────────┘

 update_post: draft 상태 불변. 본문/메타만 수정 + updated 각인
 delete_post: 파일 삭제 (최종 수단)
```

**`create_draft` 가 `publish_post` 를 내부 호출하는 경로를 만들지 않는다.** 편의를 위한 `publish: true` 옵션도 추가하지 않는다. 두 도구가 물리적으로 분리되어 있다는 사실 자체가 안전장치다.

---

## 7. dry-run 모드

`MCP_DRY_RUN=true` 이면 모든 쓰기 도구가 **Octokit 호출 직전에** 멈추고, 실제로 무엇을 쓰려 했는지 반환한다.

```jsonc
{
  "dryRun": true,
  "wouldWrite": [
    { "path": "content/posts/ko/foo.mdx", "action": "create", "bytes": 2431 }
  ],
  "wouldBranch": "post/ko-foo",
  "frontmatter": { /* 조립된 결과 */ },
  "preview": "---\ntitle: ...\n---\n\n## 증상\n..."
}
```

검증·슬러그·경로 검사는 **전부 정상 수행**한다. 차단되는 것은 네트워크 쓰기뿐이다. 실제 자격증명을 처음 연결할 때 이 모드로 먼저 돌린다.

---

## 8. 테스트 전략

| 층 | 대상 | 방법 |
|---|---|---|
| 유닛 (핵심) | `content/` 전부 — 스키마, 직렬화, 슬러그, 경로 | 순수 함수. 모킹 불필요 |
| 유닛 | `tools/` 핸들러 | `Deps` 에 인메모리 `GitHubAdapter` 주입, `now` 고정 |
| 통합 | Octokit 어댑터 | `vi.mock("@octokit/rest")` |
| 수동 | 전 도구 왕복 | MCP Inspector |
| 수동 | 실제 발행 | dry-run → 실계정 1회 |

**반드시 테스트로 고정할 불변식:**

1. `create_draft` 에 `draft: false` 를 넣어도 결과가 `draft: true`
2. `update_post` 가 `draft` 상태를 바꾸지 않음
3. `update_post` 가 `date` 를 바꾸지 않고 `updated` 를 서버 시각으로 덮어씀
4. `content/posts/../../.github/workflows/x.yml` 같은 경로가 거부됨
5. `commitSha` 불일치 시 `STALE_CONTENT` 로 거부
6. `MCP_DRY_RUN=true` 에서 GitHub 쓰기 API가 **한 번도 호출되지 않음**
7. 오류 메시지·반환값에 토큰 문자열이 포함되지 않음

커버리지 목표: **`src/content/` ≥ 90%**, `src/tools/` ≥ 80%, `src/github/` ≥ 80%.

`src/content/` 기준이 더 높은 이유: 순수 함수라 테스트 비용이 낮고, 경로 allowlist와 스키마 검증 등 **안전장치 대부분이 여기 산다.** ([`PLAN.md`](./PLAN.md) 테스트 전략과 동일)
