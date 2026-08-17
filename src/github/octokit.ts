import { Octokit } from "@octokit/rest";

import type { Config } from "../config/env.js";
import { ToolError, wrapGitHubError } from "../errors.js";
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
 * 실제 GitHub 어댑터.
 *
 * ★ Octokit 오류를 절대 그대로 전파하지 않는다 — 오류 객체에 요청 헤더가 들어있고
 *   거기에 토큰이 있다 (docs/SECURITY.md §3). 전부 wrapGitHubError 로 감싼다.
 */
export class OctokitGitHub implements GitHubAdapter {
  private readonly octokit: Octokit;
  private readonly owner: string;
  private readonly repo: string;
  private readonly baseBranch: string;

  /** 폭주 방지 서킷 브레이커 (docs/SECURITY.md T6) */
  private writeTimestamps: number[] = [];
  private readonly maxWritesPerMinute: number;

  constructor(config: Config, options: { maxWritesPerMinute?: number } = {}) {
    this.octokit = new Octokit({ auth: config.token });
    this.owner = config.owner;
    this.repo = config.repo;
    this.baseBranch = config.baseBranch;
    this.maxWritesPerMinute = options.maxWritesPerMinute ?? 20;
  }

  private guardWriteRate(): void {
    const now = Date.now();
    this.writeTimestamps = this.writeTimestamps.filter((t) => now - t < 60_000);

    if (this.writeTimestamps.length >= this.maxWritesPerMinute) {
      throw new ToolError(
        "RATE_LIMITED",
        `1분 내 쓰기 ${this.maxWritesPerMinute}회 상한에 도달했습니다. ` +
          `의도치 않은 반복 호출이 아닌지 확인하고 잠시 후 다시 시도하세요.`,
      );
    }
    this.writeTimestamps.push(now);
  }

  async getFile(path: string, ref?: string): Promise<RepoFile | undefined> {
    try {
      const response = await this.octokit.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path,
        ...(ref ? { ref } : {}),
      });

      const data = response.data;
      if (Array.isArray(data) || data.type !== "file" || !("content" in data)) {
        return undefined;
      }

      return {
        path,
        sha: data.sha,
        content: Buffer.from(data.content, "base64").toString("utf8"),
      };
    } catch (error) {
      if ((error as { status?: number }).status === 404) return undefined;
      throw wrapGitHubError(error, `파일 읽기 (${path})`);
    }
  }

  async listDir(path: string, ref?: string): Promise<DirEntry[]> {
    try {
      const response = await this.octokit.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path,
        ...(ref ? { ref } : {}),
      });

      if (!Array.isArray(response.data)) return [];

      return response.data.map((entry) => ({
        path: entry.path,
        name: entry.name,
        type: entry.type === "dir" ? "dir" : "file",
        sha: entry.sha,
      }));
    } catch (error) {
      if ((error as { status?: number }).status === 404) return [];
      throw wrapGitHubError(error, `디렉터리 목록 (${path})`);
    }
  }

  async putFile(input: PutFileInput): Promise<CommitResult> {
    this.guardWriteRate();

    try {
      const response = await this.octokit.repos.createOrUpdateFileContents({
        owner: this.owner,
        repo: this.repo,
        path: input.path,
        message: input.message,
        content: Buffer.from(input.content, "utf8").toString("base64"),
        branch: input.branch,
        ...(input.sha ? { sha: input.sha } : {}),
      });

      return {
        commitSha: response.data.commit.sha ?? "",
        fileSha: response.data.content?.sha ?? "",
      };
    } catch (error) {
      throw wrapGitHubError(error, `파일 쓰기 (${input.path})`);
    }
  }

  async deleteFile(input: DeleteFileInput): Promise<{ commitSha: string }> {
    this.guardWriteRate();

    try {
      const response = await this.octokit.repos.deleteFile({
        owner: this.owner,
        repo: this.repo,
        path: input.path,
        message: input.message,
        sha: input.sha,
        branch: input.branch,
      });

      return { commitSha: response.data.commit.sha ?? "" };
    } catch (error) {
      throw wrapGitHubError(error, `파일 삭제 (${input.path})`);
    }
  }

  async ensureBranch(name: string, from: string): Promise<{ created: boolean }> {
    try {
      await this.octokit.git.getRef({
        owner: this.owner,
        repo: this.repo,
        ref: `heads/${name}`,
      });
      return { created: false };
    } catch (error) {
      if ((error as { status?: number }).status !== 404) {
        throw wrapGitHubError(error, `브랜치 조회 (${name})`);
      }
    }

    try {
      const base = await this.octokit.git.getRef({
        owner: this.owner,
        repo: this.repo,
        ref: `heads/${from}`,
      });

      await this.octokit.git.createRef({
        owner: this.owner,
        repo: this.repo,
        ref: `refs/heads/${name}`,
        sha: base.data.object.sha,
      });

      return { created: true };
    } catch (error) {
      throw wrapGitHubError(error, `브랜치 생성 (${name})`);
    }
  }

  async openOrReusePr(input: {
    head: string;
    base: string;
    title: string;
    body: string;
  }): Promise<PullRequestResult> {
    try {
      const open = await this.octokit.pulls.list({
        owner: this.owner,
        repo: this.repo,
        head: `${this.owner}:${input.head}`,
        state: "open",
      });

      const existing = open.data[0];
      if (existing) {
        return { number: existing.number, url: existing.html_url, reused: true };
      }

      const created = await this.octokit.pulls.create({
        owner: this.owner,
        repo: this.repo,
        head: input.head,
        base: input.base,
        title: input.title,
        body: input.body,
      });

      return { number: created.data.number, url: created.data.html_url, reused: false };
    } catch (error) {
      throw wrapGitHubError(error, `PR 생성 (${input.head})`);
    }
  }

  async mergePr(
    number: number,
    message: string,
  ): Promise<{ merged: boolean; commitSha?: string }> {
    this.guardWriteRate();

    try {
      const response = await this.octokit.pulls.merge({
        owner: this.owner,
        repo: this.repo,
        pull_number: number,
        commit_title: message,
        merge_method: "squash",
      });

      return { merged: response.data.merged, commitSha: response.data.sha };
    } catch (error) {
      throw wrapGitHubError(error, `PR 머지 (#${number})`);
    }
  }

  /**
   * PR 에 붙은 배포 프리뷰 URL.
   *
   * ★ 아직 없으면 undefined 를 반환한다 — **추측 URL 을 확정처럼 주지 않는다.**
   *   아직 안 뜬 주소를 주면 사용자가 404 를 본다.
   */
  async findPreviewUrl(prNumber: number): Promise<string | undefined> {
    try {
      const pr = await this.octokit.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
      });

      const deployments = await this.octokit.repos.listDeployments({
        owner: this.owner,
        repo: this.repo,
        ref: pr.data.head.sha,
        per_page: 5,
      });

      for (const deployment of deployments.data) {
        const statuses = await this.octokit.repos.listDeploymentStatuses({
          owner: this.owner,
          repo: this.repo,
          deployment_id: deployment.id,
          per_page: 5,
        });

        const ready = statuses.data.find(
          (status) => status.state === "success" && status.environment_url,
        );
        if (ready?.environment_url) return ready.environment_url;
      }

      return undefined;
    } catch {
      // 프리뷰를 못 찾는 것은 실패가 아니다 — 아직 배포 중일 수 있다.
      return undefined;
    }
  }

  /** base 브랜치 이름 (진단용) */
  get base(): string {
    return this.baseBranch;
  }
}
