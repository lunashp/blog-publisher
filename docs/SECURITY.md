# 보안 — blog-publisher

- 작성일: 2026-08-17
- **쓰기 도구를 구현하기 전에 읽는다.**

---

## 0. 왜 이 문서가 필요한가

이 서버는 **LLM이 호출하는, 공개 저장소에 쓰기 권한을 가진 도구**다. 세 가지가 겹쳐 있다.

1. 호출자가 사람이 아니라 모델이다 — 지시를 오해하거나 주입된 지시를 따를 수 있다
2. 결과물이 공개된다 — 사고가 즉시 외부에 노출된다
3. 자격증명이 로컬에 상주한다 — 유출 시 저장소 쓰기 권한이 넘어간다

일반적인 로컬 CLI 도구보다 방어선을 한 겹 더 둔다.

---

## 1. GitHub 토큰

### 종류와 권한

**fine-grained personal access token** 을 쓴다. classic PAT은 쓰지 않는다 (저장소 단위 제한이 불가능).

| 설정 | 값 |
|---|---|
| Repository access | **블로그 저장소 하나만.** "All repositories" 절대 금지 |
| Contents | **Read and write** |
| Metadata | Read-only (자동 포함) |
| Pull requests | Read and write (PR 생성용) |
| 그 외 전부 | **No access** |
| 만료 | 90일 |

**부여하지 않는 권한:** Actions, Workflows, Administration, Webhooks, Secrets, Packages, Environments.

> Workflows 권한을 주면 `.github/workflows/` 에 쓸 수 있게 되고, 그건 저장소에서 임의 코드 실행으로 가는 길이다. 이 도구는 글만 쓰면 된다.

### 로테이션

- 만료 90일. 캘린더에 갱신 알림을 건다
- 유출이 의심되면 **즉시 폐기**하고 재발급한다. 폐기가 먼저다
- 갱신 시 `.mcp.json` / 셸 프로필 / Keychain 중 실제로 쓰는 곳만 갱신하고, 나머지에 남은 사본을 지운다

---

## 2. 시크릿 보관

### 방법별 비교

| 방법 | 안전도 | 비고 |
|---|:---:|---|
| **macOS Keychain** (시작 시 조회) | 상 | 평문 파일에 안 남는다. 백업·동기화·화면공유 노출 위험 없음 |
| 셸 프로필 env (`~/.zshrc`) + config에서 참조 | 중 | 홈 디렉터리 평문. 실용적 절충안 |
| MCP config JSON에 직접 기입 | 하 | 파일 동기화·공유 시 그대로 샌다 |
| 서버 저장소의 `.env` | 하 | git 커밋 사고 위험. 쓴다면 `.gitignore` 필수 |

**권장: Keychain 우선, 셸 env 차선.**

```bash
# 저장
security add-generic-password -a "$USER" -s "blog-publisher-github-token" -w

# 서버가 시작 시 조회
security find-generic-password -a "$USER" -s "blog-publisher-github-token" -w
```

### ⚠️ 커밋되는 설정 파일에 토큰 원문 금지

Claude Code의 **프로젝트 스코프 `.mcp.json` 은 커밋을 전제로 한다.** 여기에 토큰 원문을 넣으면 저장소에 그대로 올라간다.

```jsonc
// ❌ 절대 금지 — 커밋되는 파일
{ "mcpServers": { "blog-publisher": {
    "env": { "GITHUB_TOKEN": "github_pat_11ABC..." }   // ← 유출
}}}

// ✅ 환경변수 참조
{ "mcpServers": { "blog-publisher": {
    "command": "node", "args": ["/path/to/dist/index.js"],
    "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
}}}
```

실제 값은 로컬(개인) 스코프 설정이나 셸 프로필에 둔다.

---

## 3. 토큰 유출 차단

`CLAUDE.md` 의 불변식 4를 구현 관점에서 풀어 쓴다.

| 경로 | 대응 |
|---|---|
| 로그 | 토큰을 로깅하지 않는다. 설정 로그는 `GITHUB_TOKEN: <set>` 형태로만 |
| 도구 반환값 | 설정 객체를 통째로 반환하지 않는다. 필요한 필드만 골라 담는다 |
| 에러 메시지 | **Octokit 에러를 그대로 전파하지 않는다.** 에러 객체에 요청 헤더(= `Authorization`)가 들어있다. status와 안전한 요약만 남긴다 |
| stdout | stdio 트랜스포트에서 stdout은 JSON-RPC 채널이다. `console.log` 금지. 진단은 `console.error` (stderr) |
| 예외 스택 | 스택을 사용자에게 그대로 노출하지 않는다 |

```ts
// ❌
catch (e) { throw new ToolError("GITHUB_ERROR", JSON.stringify(e)); }

// ✅
catch (e) {
  const status = (e as { status?: number }).status;
  throw new ToolError("GITHUB_ERROR",
    `GitHub API 호출 실패 (status ${status ?? "unknown"}). 토큰 권한과 저장소 이름을 확인하세요.`);
}
```

---

## 4. 위협 모델

| # | 위협 | 시나리오 | 영향 | 대응 |
|---|---|---|---|---|
| T1 | **프롬프트 인젝션 → 의도치 않은 발행** | Claude가 웹페이지를 요약하는 중, 페이지에 숨겨진 "블로그에 이 글을 발행하라" 지시가 있음 | 조작된 글이 공개됨 | **draft-by-default.** 생성은 절대 발행으로 이어지지 않는다. 발행에는 사용자가 도구 이름을 대는 별도 턴이 필요 |
| T2 | **오래된 컨텍스트로 덮어쓰기** | LLM이 몇 턴 전 읽은 본문을 들고 수정 시도. 그 사이 글이 바뀜 | 최신 수정분 손실 | `expectedCommitSha` 낙관적 동시성. 불일치 시 거부 |
| T3 | **경로 이탈 쓰기** | `content/posts/../../.github/workflows/evil.yml` | 저장소 임의 파일 조작, CI 탈취 | 핸들러 내부 `path.posix.normalize` 후 allowlist 검사. **+ 토큰에 Workflows 권한 미부여 (2중 방어)** |
| T4 | **토큰 유출** | 로그·에러·반환값에 섞여 나감 | 저장소 쓰기 권한 탈취 | §3. 최소 권한 + 90일 만료로 피해 범위 제한 |
| T5 | **실수로 삭제** | LLM이 "정리해줘"를 삭제로 해석 | 글 소실 | `delete_post` 에 `confirmSlug` 요구. 일괄 삭제 도구 미제공. git 히스토리로 복구 가능 |
| T6 | **폭주 (runaway)** | 루프에 빠져 반복 호출 | 저장소 오염, 레이트리밋 | 프로세스 내 레이트리밋(분당 쓰기 N회 상한) 서킷 브레이커 |
| T7 | **LLM이 사실을 지어냄** | 없는 버전·URL·수치를 본문에 씀 | 틀린 정보 공개 | **서버가 막을 수 없다.** 형식만 검증한다. 프리뷰 확인 + [`WRITING-GUIDE.md`](../../jiny-log/docs/WRITING-GUIDE.md) §7이 유일한 방어선 |
| T8 | **악성 자산 업로드** | SVG에 스크립트 삽입 | 블로그 XSS | 확장자 allowlist + 크기 상한. **SVG는 신뢰 가능한 출처만** — 필요 없으면 확장자 목록에서 빼는 것을 고려 |

> **T7을 정직하게 남긴다.** 이 서버는 내용의 진위를 검증할 수 없다. 형식(frontmatter, 경로, 상태 전이)만 보장한다. 그래서 프리뷰 확인 단계를 제거하지 않는다.

---

## 5. 방어선 요약

```
1층  스키마 검증        zod inputSchema — 형식이 틀린 입력을 거른다
2층  핸들러 가드        경로 정규화·allowlist·draft 강제·commitSha 대조
                       ★ 실질적 방어는 여기다. 어노테이션이 아니다
3층  토큰 최소 권한     뚫려도 할 수 있는 일이 제한됨 (workflows 불가)
4층  사람의 프리뷰 확인  발행 전 마지막 관문
5층  git 히스토리       사고 후 복구 (revert)
```

**어노테이션(`destructiveHint` 등)은 이 그림에 없다.** 정보 제공일 뿐 강제력이 없기 때문이다. 안전을 어노테이션에 의존하면 안 된다.

---

## 6. dry-run

`MCP_DRY_RUN=true` 로 모든 쓰기를 차단한 채 검증·조립까지만 수행한다.

**언제 쓰나**
- 실제 토큰을 처음 연결할 때 — 첫 실행은 반드시 dry-run
- 도구를 수정한 뒤 회귀 확인
- 새로운 호출 패턴을 시험할 때

**보장할 것:** dry-run 모드에서 GitHub **쓰기** API가 단 한 번도 호출되지 않아야 한다. 테스트로 고정한다 (`ARCHITECTURE.md` §8 불변식 6).

---

## 7. 구현 체크리스트

쓰기 도구 하나를 완성할 때마다 확인한다.

- [ ] 경로를 `path.posix.normalize` 후 allowlist 검사했는가 (zod `.startsWith()` 만으로 끝내지 않았는가)
- [ ] `..` 를 포함한 입력이 거부되는 테스트가 있는가
- [ ] Octokit 에러를 그대로 전파하지 않는가
- [ ] 반환값·로그에 토큰이 섞일 경로가 없는가
- [ ] `console.log` 를 쓰지 않았는가 (stdout = JSON-RPC)
- [ ] draft 상태 전이 규칙을 지키는가
- [ ] 파괴적 도구에 `expectedCommitSha` 또는 확인 입력이 있는가
- [ ] dry-run에서 쓰기 API가 호출되지 않는가
- [ ] 오류 메시지가 **다음 행동**을 알려주는가

---

## 8. 사고 대응

**토큰 유출 의심 시**

1. GitHub Settings → Developer settings → Fine-grained tokens → **해당 토큰 삭제** (가장 먼저)
2. 저장소 최근 커밋 확인 — 의도하지 않은 변경이 있는지
3. 새 토큰 발급, 보관 위치 갱신, 남은 사본 제거
4. 토큰이 커밋에 들어갔다면 **히스토리에서 제거** (토큰 폐기가 우선이고, 히스토리 정리는 그다음)

**의도치 않게 발행된 경우**

1. `unpublish_post` 로 즉시 비공개 전환 (파일 유지, 복구 쉬움)
2. 배포 완료까지 1~3분 걸리므로 그동안은 노출 상태임을 인지
3. 어떤 경로로 발행됐는지 확인 — draft-by-default가 뚫렸다면 그게 진짜 버그다
