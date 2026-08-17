import { createHash } from "node:crypto";

import { ToolError } from "../errors.js";
import type {
  CommitResult,
  DeleteFileInput,
  DirEntry,
  GitHubAdapter,
  PullRequestResult,
  PutFileInput,
  RepoFile,
} from "./types.js";

/**
 * 인메모리 GitHub 어댑터 — 테스트 전용.
 *
 * 실제 Octokit 을 모킹하는 대신 인터페이스를 구현한다. 그래야 도구 핸들러의
 * 전체 흐름(브랜치 → 커밋 → PR → 머지)을 네트워크 없이 검증할 수 있고,
 * SHA 불일치 같은 낙관적 동시성 동작도 실제와 같게 재현된다.
 */

const sha = (input: string): string =>
  createHash("sha1").update(input).digest("hex").slice(0, 40);

interface Branch {
  files: Map<string, string>;
}

export interface MemoryRepoOptions {
  baseBranch?: string;
  /** 초기 파일 (base 브랜치에) */
  files?: Record<string, string>;
  /** PR 프리뷰 URL 을 흉내낼지. 기본 false — 실제로도 바로 안 붙는다. */
  previewUrl?: string;
}

export class MemoryGitHub implements GitHubAdapter {
  readonly baseBranch: string;
  private readonly branches = new Map<string, Branch>();
  private readonly prs = new Map<
    number,
    { number: number; head: string; base: string; merged: boolean }
  >();
  private nextPr = 1;
  private readonly previewUrl: string | undefined;

  /** 테스트 관찰용 — 실제로 어떤 쓰기가 일어났는지 */
  readonly writes: Array<{ kind: "put" | "delete"; path: string; branch: string }> = [];

  constructor(options: MemoryRepoOptions = {}) {
    this.baseBranch = options.baseBranch ?? "main";
    this.previewUrl = options.previewUrl;
    this.branches.set(this.baseBranch, {
      files: new Map(Object.entries(options.files ?? {})),
    });
  }

  private branch(name: string): Branch {
    const found = this.branches.get(name);
    if (!found) {
      throw new ToolError("GITHUB_ERROR", `브랜치를 찾을 수 없습니다: ${name}`);
    }
    return found;
  }

  /** 테스트 편의 — 특정 브랜치의 파일 내용 확인 */
  read(path: string, branch = this.baseBranch): string | undefined {
    return this.branches.get(branch)?.files.get(path);
  }

  listBranches(): string[] {
    return [...this.branches.keys()];
  }

  async getFile(path: string, ref?: string): Promise<RepoFile | undefined> {
    const content = this.branch(ref ?? this.baseBranch).files.get(path);
    if (content === undefined) return undefined;
    return { path, sha: sha(content), content };
  }

  async listDir(path: string, ref?: string): Promise<DirEntry[]> {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const entries: DirEntry[] = [];
    const seenDirs = new Set<string>();

    for (const [filePath, content] of this.branch(ref ?? this.baseBranch).files) {
      if (!filePath.startsWith(prefix)) continue;

      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf("/");

      if (slash === -1) {
        entries.push({
          path: filePath,
          name: rest,
          type: "file",
          sha: sha(content),
        });
      } else {
        const dirName = rest.slice(0, slash);
        if (!seenDirs.has(dirName)) {
          seenDirs.add(dirName);
          entries.push({
            path: `${prefix}${dirName}`,
            name: dirName,
            type: "dir",
            sha: sha(dirName),
          });
        }
      }
    }

    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  async putFile(input: PutFileInput): Promise<CommitResult> {
    const branch = this.branch(input.branch);
    const existing = branch.files.get(input.path);

    // 실제 GitHub 동작 재현: 기존 파일 수정에는 올바른 sha 가 필요하다.
    if (existing !== undefined && input.sha !== undefined && input.sha !== sha(existing)) {
      throw new ToolError(
        "GITHUB_ERROR",
        `파일 수정 충돌 (status 409). 최신 상태를 다시 읽으세요.`,
      );
    }

    branch.files.set(input.path, input.content);
    this.writes.push({ kind: "put", path: input.path, branch: input.branch });

    return {
      commitSha: sha(`${input.branch}:${input.path}:${input.content}`),
      fileSha: sha(input.content),
    };
  }

  async deleteFile(input: DeleteFileInput): Promise<{ commitSha: string }> {
    const branch = this.branch(input.branch);
    const existing = branch.files.get(input.path);

    if (existing === undefined) {
      throw new ToolError("NOT_FOUND", `파일이 없습니다: ${input.path}`);
    }
    if (sha(existing) !== input.sha) {
      throw new ToolError("GITHUB_ERROR", "파일 삭제 충돌 (status 409).");
    }

    branch.files.delete(input.path);
    this.writes.push({ kind: "delete", path: input.path, branch: input.branch });

    return { commitSha: sha(`del:${input.path}`) };
  }

  async ensureBranch(name: string, from: string): Promise<{ created: boolean }> {
    if (this.branches.has(name)) return { created: false };

    this.branches.set(name, { files: new Map(this.branch(from).files) });
    return { created: true };
  }

  async openOrReusePr(input: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRequestResult> {
    for (const pr of this.prs.values()) {
      if (pr.head === input.head && !pr.merged) {
        return { number: pr.number, url: `https://github.test/pull/${pr.number}`, reused: true };
      }
    }

    const number = this.nextPr++;
    this.prs.set(number, { number, head: input.head, base: input.base, merged: false });
    return { number, url: `https://github.test/pull/${number}`, reused: false };
  }

  async mergePr(number: number): Promise<{ merged: boolean; commitSha?: string }> {
    const pr = this.prs.get(number);
    if (!pr) throw new ToolError("NOT_FOUND", `PR #${number} 를 찾을 수 없습니다.`);
    if (pr.merged) return { merged: false };

    // head 의 파일을 base 로 옮긴다.
    const head = this.branch(pr.head);
    const base = this.branch(pr.base);
    for (const [path, content] of head.files) base.files.set(path, content);
    // head 에서 지워진 파일은 base 에서도 지운다.
    for (const path of [...base.files.keys()]) {
      if (!head.files.has(path)) base.files.delete(path);
    }

    pr.merged = true;
    return { merged: true, commitSha: sha(`merge:${number}`) };
  }

  async findPreviewUrl(): Promise<string | undefined> {
    return this.previewUrl;
  }
}
