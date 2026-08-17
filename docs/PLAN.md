# 구현 계획 — blog-publisher

- 작성일: 2026-08-17
- **진행 상태: Phase 0–5 완료. Phase 6 남음.**
- 전제: [`CLAUDE.md`](../CLAUDE.md), [`ARCHITECTURE.md`](./ARCHITECTURE.md), [`TOOLS.md`](./TOOLS.md), [`SECURITY.md`](./SECURITY.md), [`CONTENT-CONTRACT.md`](../../jiny-log/docs/CONTENT-CONTRACT.md) 를 먼저 읽는다.

**순서가 중요하다.** 검증 코어(Phase 1)가 완성되기 전에 쓰기 도구를 만들지 않는다. 읽기 도구(Phase 3)를 먼저 만들어 GitHub 연동을 안전하게 검증한 뒤 쓰기로 넘어간다.

---

## Phase 0–5 — 완료 (2026-08-17)

### Phase 0 — 스캐폴드 + ★ SDK 세대 실측 ✅

**계획서가 요구한 "추측하지 말고 실측하라"를 실제로 수행했다.**

최소 v2 서버를 만들어 `claude mcp add` 로 등록하고 연결 로그를 읽었다:

```
"protocolEra":"modern","negotiatedProtocolVersion":"2026-07-28"
```

→ **v2 (`@modelcontextprotocol/server` 2.0.0) 확정.** 초기 문서의 "클라이언트가 아직
2025-11-25 만 협상한다"는 전제는 틀렸다. 로그 경로와 재확인 방법은 [`CLAUDE.md`](../CLAUDE.md).

부수 발견: v2 의 `inputSchema` 는 **zod v4 스키마**여야 한다. 원시 JSON Schema 를 넘기면
툴 등록이 실패하고 그게 `initialize` 실패(`-32603`)로 나타나 원인 추적이 어렵다.

### Phase 1 — 콘텐츠 검증 코어 ✅

- `schema.ts` — 계약 구현체 (jiny-log 와 동일한 zod v4)
- `paths.ts` — **경로 allowlist**. 이 파일이 저장소 쓰기 범위를 결정한다
- `serialize.ts` — 키 순서 고정 직렬화. gray-matter 의 stringify 를 쓰지 않는다
  (js-yaml 기본 출력이 한국어에 불필요한 따옴표를 넣고 키 순서를 뒤섞는다)
- `slug.ts` — 한글 자동 음차 거부

### Phase 2 — GitHub 어댑터 ✅

`GitHubAdapter` 인터페이스 + 두 구현:
- `octokit.ts` — 실제. **모든 오류를 `wrapGitHubError` 로 감싼다** (오류 객체에 토큰이 있다)
- `memory.ts` — 인메모리. Octokit 을 모킹하는 대신 인터페이스를 구현해
  브랜치→커밋→PR→머지 전 흐름을 네트워크 없이 검증한다. SHA 충돌도 실제와 같게 재현

### Phase 3–5 — 도구 10종 ✅

읽기 4종 + 쓰기 5종 + 자산 1종. 명세는 [`TOOLS.md`](./TOOLS.md).

### 테스트 143개 / 커버리지 93%

| 영역 | 커버리지 |
|---|---|
| `src/content` | 97% |
| `src/tools` | 94% |
| `src/github` (memory) | 84% |
| `src/config` | 100% |

`octokit.ts` 는 커버리지에서 제외했다 — 순수 네트워크 어댑터이고, 로직은 `memory.ts` 로,
토큰 유출 차단은 `errors.test.ts` 가 직접 검증한다.

**불변식 테스트 (전부 통과)**

- [x] `create_draft` 에 `draft: false` 를 넣어도 결과가 `draft: true`
- [x] `create_draft` 는 기본 브랜치에 쓰지 않는다
- [x] `publish_post` 만이 `draft → false` 전이를 수행
- [x] `publish_post` 멱등 (이미 발행된 글에 no-op)
- [x] `update_post` 가 `draft`·`date` 를 바꾸지 않고 `updated` 를 서버 시각으로 각인
- [x] `expectedCommitSha` 불일치 시 `STALE_CONTENT` 거부
- [x] `delete_post` 의 `confirmSlug` 불일치 거부
- [x] `delete_post` 가 이미지를 자동 삭제하지 않음
- [x] 경로 이탈 12종 차단 (`content/posts/../../.github/workflows/evil.yml` 포함)
- [x] `upload_asset` 이 실행 가능 확장자(html/js/svg/mdx) 거부
- [x] `MCP_DRY_RUN=true` 에서 쓰기 API 호출 **0회**
- [x] 오류·반환값·stderr 어디에도 토큰 없음
- [x] stdout 에 JSON-RPC 외의 것이 섞이지 않음

**end-to-end** (`server.test.ts`): 빌드 산출물을 실제 프로세스로 띄워 도구 10종 노출,
어노테이션, 설명문의 부작용 명시, 토큰 미노출을 확인한다.

---

## Phase 6 — 배포 · 등록 · 실사용 검증

### 작업

1. **fine-grained PAT 발급** ([`SECURITY.md`](./SECURITY.md) §1 권한대로, 저장소 1개, 90일)
2. 토큰을 macOS Keychain에 저장, 서버가 시작 시 조회하도록 배선
3. Claude Code 등록
   ```bash
   claude mcp add --transport stdio blog-publisher -- node /절대경로/dist/index.js
   ```
4. Claude Desktop 등록 (`~/Library/Application Support/Claude/claude_desktop_config.json`)
5. **dry-run으로 전 도구 왕복 1회**
6. dry-run 해제 후 **실제 발행 1회** — 초안 → 프리뷰 → 발행 → 라이브 확인
7. README에 등록 스니펫·트러블슈팅 정리

### DoD

- [ ] Claude Code / Desktop 양쪽에서 도구가 보임
- [ ] dry-run 전 도구 성공, 저장소에 **변경 0건** (git log로 확인)
- [ ] 실제 초안 생성 → PR 생성 → **프리뷰 URL 접속 성공**
- [ ] `publish_post` → 1~3분 뒤 라이브 URL에서 글 확인
- [ ] `update_post` 로 수정 → `updated` 날짜가 정확히 각인됨
- [ ] `unpublish_post` → 사이트에서 사라짐
- [ ] 토큰 만료일이 캘린더에 등록됨

---

## 진행 순서

```
0 스캐폴드 ──▶ 1 검증 코어(TDD) ──▶ 2 GitHub 어댑터 ──▶ 3 읽기 도구
                                                            │
        6 배포·실사용 검증 ◀── 5 자산 업로드 ◀── 4 쓰기 도구
```

**Phase 1이 가장 중요하다** (모든 안전장치가 여기 산다). **Phase 4가 가장 위험하다** (여기서부터 실수가 공개된다).

---

## 테스트 전략

| 층 | 도구 | 대상 | 커버리지 |
|---|---|---|---|
| 유닛 | vitest | `src/content/` 전부 | **≥ 90%** |
| 유닛 | vitest + 인메모리 어댑터 | `src/tools/` 핸들러 | **≥ 80%** |
| 통합 | vitest + `vi.mock` | `src/github/` | ≥ 80% |
| 수동 | MCP Inspector | 전 도구 왕복 | — |
| 수동 | dry-run → 실계정 | 발행 전체 흐름 | — |

### 테스트 원칙

- **핸들러는 `Deps` 주입으로 테스트한다.** 실제 Octokit을 쓰지 않는다
- **`now` 를 주입해 날짜를 고정한다.** `updated` 각인 검증에 필수
- 불변식 테스트는 [`ARCHITECTURE.md`](./ARCHITECTURE.md) §8 목록을 모두 포함한다
- 새 쓰기 도구를 추가할 때마다 [`SECURITY.md`](./SECURITY.md) §7 체크리스트를 통과시킨다

---

## jiny-log와의 연동 순서

두 프로젝트는 독립적으로 진행하되, 아래 지점에서 만난다.

| 시점 | 필요한 것 |
|---|---|
| blog-publisher Phase 3 | jiny-log 저장소가 GitHub에 존재하고 `content/posts/` 구조가 있어야 함 (jiny-log Phase 1 완료) |
| blog-publisher Phase 6 | Vercel 프로젝트 연결 + Preview 배포 동작 (jiny-log Phase 0 완료) |
| jiny-log Phase 6 | blog-publisher로 실제 발행 1회 성공 |

**권장 순서:** jiny-log Phase 0–1 → blog-publisher Phase 0–4 → jiny-log Phase 2–5 → 양쪽 Phase 6 (연동 검증).
