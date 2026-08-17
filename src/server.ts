import { McpServer } from "@modelcontextprotocol/server";

import { CONTRACT_VERSION } from "./content/schema.js";
import { isToolError, ToolError } from "./errors.js";
import type { Deps } from "./tools/deps.js";
import {
  GenerateSlugInput,
  GetPostInput,
  ListPostsInput,
  ValidateFrontmatterInput,
  generateSlugTool,
  getPost,
  listPosts,
  validateFrontmatterTool,
} from "./tools/read.js";
import {
  CreateDraftInput,
  DeletePostInput,
  PublishPostInput,
  UnpublishPostInput,
  UpdatePostInput,
  UploadAssetInput,
  createDraft,
  deletePost,
  publishPost,
  unpublishPost,
  updatePost,
  uploadAsset,
} from "./tools/write.js";

/**
 * MCP 배선 — 로직은 여기 없다. tools/ 의 순수 핸들러를 호출만 한다
 * (docs/ARCHITECTURE.md §3).
 *
 * 도구 설명문은 LLM 이 읽는 유일한 사용법이다. 부작용을 문장으로 명시한다.
 */

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

/**
 * 핸들러 오류를 도구 결과로 바꾼다.
 *
 * ★ 예기치 못한 오류의 스택이나 원본 메시지를 그대로 노출하지 않는다 —
 *   토큰이 섞여 나올 수 있다 (docs/SECURITY.md §3).
 */
async function wrap(run: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await run());
  } catch (error) {
    if (isToolError(error)) {
      return { ...ok(error.toPayload()), isError: true };
    }

    console.error("[blog-publisher] 예기치 못한 오류:", error);
    return {
      ...ok(
        new ToolError(
          "GITHUB_ERROR",
          "예기치 못한 오류가 발생했습니다. 서버 stderr 로그를 확인하세요.",
        ).toPayload(),
      ),
      isError: true,
    };
  }
}

export function createServer(deps: Deps): McpServer {
  const server = new McpServer(
    { name: "blog-publisher", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // ───────────────────────────────────────────────────────────── 읽기

  server.registerTool(
    "list_posts",
    {
      title: "블로그 글 목록",
      description:
        "블로그의 글 목록을 조회합니다. 초안과 발행된 글을 모두 볼 수 있으며 " +
        "로케일·태그·상태로 필터링할 수 있습니다. 아무것도 변경하지 않습니다.",
      inputSchema: ListPostsInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input) => wrap(() => listPosts(input, deps)),
  );

  server.registerTool(
    "get_post",
    {
      title: "글 하나 읽기",
      description:
        "글 하나의 frontmatter 와 본문 전체를 가져옵니다. " +
        "반환값의 commitSha 는 update_post / delete_post 를 호출할 때 반드시 함께 " +
        "보내야 하므로, 글을 수정하기 전에는 항상 이 도구를 먼저 호출하세요.",
      inputSchema: GetPostInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input) => wrap(() => getPost(input, deps)),
  );

  server.registerTool(
    "validate_frontmatter",
    {
      title: "frontmatter 검증 (쓰기 없음)",
      description:
        "frontmatter 가 블로그의 콘텐츠 계약을 만족하는지 검사합니다. " +
        "저장소에 아무것도 쓰지 않으며 오류 목록만 반환합니다. " +
        "create_draft 전에 미리 확인할 때 사용하세요.",
      inputSchema: ValidateFrontmatterInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input) => wrap(() => validateFrontmatterTool(input, deps)),
  );

  server.registerTool(
    "generate_slug",
    {
      title: "슬러그 생성 및 충돌 확인",
      description:
        "제목에서 URL 슬러그를 생성하고 기존 글과 충돌하는지 확인합니다. " +
        "슬러그는 항상 영문 ASCII 여야 하므로, 한국어 제목만 주어지면 슬러그를 만들지 않고 " +
        "영문 슬러그를 요청합니다. 충돌 시 자동으로 번호를 붙이지 않고 충돌 사실을 반환합니다.",
      inputSchema: GenerateSlugInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input) => wrap(() => generateSlugTool(input, deps)),
  );

  // ───────────────────────────────────────────────────────────── 쓰기

  server.registerTool(
    "create_draft",
    {
      title: "초안 생성 (라이브로 나가지 않음)",
      description:
        "새 글을 초안(draft)으로 브랜치에 커밋하고 PR 을 엽니다. " +
        "**항상 draft=true 로 생성되며 라이브 사이트에 나가지 않습니다.** " +
        "발행하려면 사용자가 프리뷰를 확인한 뒤 publish_post 를 별도로 호출해야 합니다. " +
        "반환값에 PR 링크와 (확보된 경우) 프리뷰 URL 이 포함됩니다. " +
        "같은 슬러그의 글이 이미 있으면 덮어쓰지 않고 실패합니다.",
      inputSchema: CreateDraftInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (input) => wrap(() => createDraft(input, deps)),
  );

  server.registerTool(
    "publish_post",
    {
      title: "초안을 라이브로 발행",
      description:
        "초안을 라이브로 발행합니다. frontmatter 의 draft 를 false 로 바꾸고 기본 브랜치에 " +
        "반영하며, 몇 분 뒤 공개 사이트에 나타납니다. " +
        "**이 도구는 글을 공개합니다 — 사용자가 명시적으로 발행을 요청했을 때만 호출하세요.** " +
        "이미 발행된 글에 호출하면 아무것도 바꾸지 않고 성공을 반환합니다.",
      inputSchema: PublishPostInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) => wrap(() => publishPost(input, deps)),
  );

  server.registerTool(
    "update_post",
    {
      title: "글 수정",
      description:
        "기존 글의 본문이나 메타데이터를 수정합니다. " +
        "**먼저 get_post 를 호출해 현재 commitSha 를 받아 expectedCommitSha 로 전달해야 합니다** — " +
        "그 사이 글이 바뀌었으면 덮어쓰지 않고 거부합니다. " +
        "지정한 필드만 바뀌고 나머지는 유지됩니다. " +
        "발행일(date)은 변경되지 않으며 수정일(updated)이 오늘 날짜로 자동 기록됩니다. " +
        "draft 상태는 바뀌지 않습니다.",
      inputSchema: UpdatePostInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (input) => wrap(() => updatePost(input, deps)),
  );

  server.registerTool(
    "unpublish_post",
    {
      title: "발행 취소 (파일 유지)",
      description:
        "발행된 글을 다시 초안으로 되돌립니다. 파일은 삭제되지 않고 draft=true 로만 바뀌며, " +
        "다음 배포부터 공개 사이트에서 사라집니다. 되돌리려면 publish_post 를 호출하세요.",
      inputSchema: UnpublishPostInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) => wrap(() => unpublishPost(input, deps)),
  );

  server.registerTool(
    "delete_post",
    {
      title: "글 파일 삭제 (되돌리기 어려움)",
      description:
        "글 파일을 저장소에서 삭제합니다. **되돌리려면 git 히스토리를 직접 다뤄야 합니다.** " +
        "대부분의 경우 unpublish_post 로 비공개 전환하는 것이 적절하며, 삭제는 사용자가 " +
        "명시적으로 삭제를 요청했을 때만 사용하세요. " +
        "실수 방지를 위해 confirmSlug 에 슬러그를 한 번 더 입력해야 하고, " +
        "get_post 에서 받은 expectedCommitSha 도 필요합니다.",
      inputSchema: DeletePostInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) => wrap(() => deletePost(input, deps)),
  );

  server.registerTool(
    "upload_asset",
    {
      title: "이미지 업로드",
      description:
        "이미지를 public/images/<slug>/ 에 커밋하고, 글 본문이나 cover 에서 쓸 수 있는 경로를 " +
        "반환합니다. 반환된 경로를 update_post 로 본문에 넣으세요. " +
        "같은 이름의 파일이 있으면 덮어씁니다. 이미지 확장자만 허용됩니다.",
      inputSchema: UploadAssetInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) => wrap(() => uploadAsset(input, deps)),
  );

  return server;
}

export { CONTRACT_VERSION };
