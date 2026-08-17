/**
 * 도구 오류 계층 (docs/ARCHITECTURE.md §4).
 *
 * ★ 오류 메시지는 LLM 이 읽고 스스로 복구할 수 있어야 한다.
 *   "무엇이 잘못됐는지"만 말고 **다음에 무엇을 하라**를 담는다.
 */

export type ToolErrorCode =
  /** frontmatter 스키마 위반 */
  | "VALIDATION_FAILED"
  /** 같은 슬러그의 글이 이미 있음 */
  | "SLUG_CONFLICT"
  /** 글을 찾을 수 없음 */
  | "NOT_FOUND"
  /** 마지막으로 읽은 이후 변경됨 (낙관적 동시성) */
  | "STALE_CONTENT"
  /** 허용된 경로 프리픽스를 벗어남 */
  | "PATH_NOT_ALLOWED"
  /** 입력이 확인 절차를 만족하지 않음 */
  | "CONFIRMATION_REQUIRED"
  /** GitHub API 실패 */
  | "GITHUB_ERROR"
  /** 환경변수·설정 문제 */
  | "CONFIG_ERROR"
  /** 폭주 방지 서킷 브레이커 */
  | "RATE_LIMITED";

export class ToolError extends Error {
  override readonly name = "ToolError";

  constructor(
    readonly code: ToolErrorCode,
    message: string,
    /** 검증 오류 목록 등 구조화 데이터. **절대 원시 요청/응답을 담지 않는다** (토큰 유출) */
    readonly details?: unknown,
  ) {
    super(message);
  }

  /** 도구 반환값으로 직렬화. 스택은 노출하지 않는다. */
  toPayload(): { error: { code: ToolErrorCode; message: string; details?: unknown } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export const isToolError = (value: unknown): value is ToolError =>
  value instanceof ToolError;

/**
 * GitHub 오류를 안전하게 감싼다.
 *
 * ★ Octokit 오류 객체에는 요청 헤더가 들어있고 거기에 토큰이 있다.
 *   절대 그대로 전파하지 않는다 (docs/SECURITY.md §3).
 */
export function wrapGitHubError(error: unknown, context: string): ToolError {
  const status = (error as { status?: number } | null)?.status;

  const hint =
    status === 401 || status === 403
      ? " 토큰이 만료됐거나 권한이 부족할 수 있습니다 (Contents: Read and write 필요)."
      : status === 404
        ? " 저장소 이름(BLOG_REPO)과 토큰의 저장소 접근 범위를 확인하세요."
        : status === 409
          ? " 동시 수정이 감지됐습니다. 최신 상태를 다시 읽고 시도하세요."
          : "";

  return new ToolError(
    "GITHUB_ERROR",
    `${context} 실패 (status ${status ?? "unknown"}).${hint}`,
  );
}
