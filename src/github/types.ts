/**
 * GitHub 어댑터 인터페이스.
 *
 * 도구 핸들러는 이 인터페이스에만 의존한다. 테스트에서는 인메모리 구현을 주입하므로
 * 네트워크 없이 전체 발행 흐름을 검증할 수 있다 (docs/ARCHITECTURE.md §3).
 */

export interface RepoFile {
  path: string;
  /** 이 파일의 blob SHA. 수정·삭제 시 낙관적 동시성 키로 쓴다. */
  sha: string;
  content: string;
}

export interface DirEntry {
  path: string;
  name: string;
  type: "file" | "dir";
  sha: string;
}

export interface PutFileInput {
  path: string;
  content: string;
  message: string;
  branch: string;
  /** 기존 파일을 수정할 때 필수. 없으면 신규 생성으로 간주한다. */
  sha?: string;
}

export interface DeleteFileInput {
  path: string;
  sha: string;
  message: string;
  branch: string;
}

export interface CommitResult {
  /** 새로 만들어진 커밋의 SHA */
  commitSha: string;
  /** 파일의 새 blob SHA — 다음 수정에 필요 */
  fileSha: string;
}

export interface PullRequestResult {
  number: number;
  url: string;
  /** 이미 열려 있던 PR 을 재사용했는지 */
  reused: boolean;
}

export interface GitHubAdapter {
  /** 파일 하나를 읽는다. 없으면 undefined. */
  getFile(path: string, ref?: string): Promise<RepoFile | undefined>;

  /** 디렉터리 목록. 없으면 빈 배열. */
  listDir(path: string, ref?: string): Promise<DirEntry[]>;

  putFile(input: PutFileInput): Promise<CommitResult>;

  deleteFile(input: DeleteFileInput): Promise<{ commitSha: string }>;

  /** 브랜치가 없으면 base 에서 만든다. 있으면 그대로 둔다. */
  ensureBranch(name: string, from: string): Promise<{ created: boolean }>;

  /** 열린 PR 이 있으면 재사용하고, 없으면 만든다. */
  openOrReusePr(input: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRequestResult>;

  mergePr(number: number, message: string): Promise<{ merged: boolean; commitSha?: string }>;

  /** PR 에 붙은 배포 프리뷰 URL. 아직 없으면 undefined — 추측하지 않는다. */
  findPreviewUrl(prNumber: number): Promise<string | undefined>;
}
