// Mattermost tests cover typed and terminal draft stream behavior.
import { describe, expect, it, vi } from "vitest";
import type { MattermostClient } from "./client.js";
import { createMattermostDraftStream, MATTERMOST_PROGRESS_POST_TYPE } from "./draft-stream.js";

type RequestRecord = {
  path: string;
  init?: RequestInit;
};

type DraftStreamOptions = Omit<
  Parameters<typeof createMattermostDraftStream>[0],
  "client" | "channelId"
> & {
  request?: MattermostClient["request"];
};

function createDraftStreamFixture(options: DraftStreamOptions = {}): {
  client: MattermostClient;
  calls: RequestRecord[];
  requestMock: ReturnType<typeof vi.fn<MattermostClient["request"]>>;
  stream: ReturnType<typeof createMattermostDraftStream>;
} {
  const { request, ...streamOptions } = options;
  const calls: RequestRecord[] = [];
  let nextId = 1;
  const requestImpl: MattermostClient["request"] = async <T>(
    path: string,
    init?: RequestInit,
  ): Promise<T> => {
    calls.push({ path, init });
    if (path === "/posts") {
      return { id: `post-${nextId++}` } as T;
    }
    if (path.startsWith("/posts/")) {
      return { id: "patched" } as T;
    }
    return {} as T;
  };
  const requestMock = vi.fn(request ?? requestImpl);
  const client: MattermostClient = {
    baseUrl: "https://chat.example.com",
    apiBaseUrl: "https://chat.example.com/api/v4",
    token: "token",
    request: requestMock as MattermostClient["request"],
    fetchImpl: vi.fn() as MattermostClient["fetchImpl"],
  };
  const stream = createMattermostDraftStream({
    client,
    channelId: "channel-1",
    throttleMs: 0,
    ...streamOptions,
  });
  return { client, calls, requestMock, stream };
}

function parseRequestJson(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    throw new Error("expected JSON request body");
  }
  const parsed: unknown = JSON.parse(init.body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("expected JSON object request body");
  }
  return parsed as Record<string, unknown>;
}

describe("createMattermostDraftStream", () => {
  it("creates typed progress posts in the initial request", async () => {
    const { calls, stream } = createDraftStreamFixture({
      rootId: "root-1",
      postType: "custom_openclaw_progress",
    });

    stream.update("|\n\nWorking");
    await stream.flush();
    stream.update("|\n\nStill working");
    await stream.flush();

    expect(parseRequestJson(calls[0]?.init)).toMatchObject({
      channel_id: "channel-1",
      root_id: "root-1",
      message: "|\n\nWorking",
      type: "custom_openclaw_progress",
    });
    expect(calls[1]?.path).toBe("/posts/post-1");
    expect(parseRequestJson(calls[1]?.init)).not.toHaveProperty("type");
  });

  it("retains terminal text after discarding a throttled stale update", async () => {
    const { calls, stream } = createDraftStreamFixture({ throttleMs: 1000 });

    stream.update("Working...");
    await stream.flush();
    stream.update("Stale partial");
    await expect(stream.retainTerminalText("Failed.")).resolves.toBe(true);
    await stream.stop();
    stream.update("Late partial");
    await stream.flush();

    expect(calls.map((call) => [call.path, call.init?.method])).toEqual([
      ["/posts", "POST"],
      ["/posts/post-1", "PUT"],
    ]);
    expect(parseRequestJson(calls[1]?.init)).toEqual({
      id: "post-1",
      message: "Failed.",
    });
  });

  it("creates a typed terminal progress post when no draft exists", async () => {
    const { calls, stream } = createDraftStreamFixture({
      rootId: "root-1",
      postType: MATTERMOST_PROGRESS_POST_TYPE,
    });

    await expect(stream.retainTerminalText("|\n\nFailed.")).resolves.toBe(true);

    expect(calls.map((call) => [call.path, call.init?.method])).toEqual([["/posts", "POST"]]);
    expect(parseRequestJson(calls[0]?.init)).toEqual({
      channel_id: "channel-1",
      root_id: "root-1",
      message: "|\n\nFailed.",
      type: MATTERMOST_PROGRESS_POST_TYPE,
    });
    expect(stream.postId()).toBe("post-1");
  });

  it("retries a transient strict cleanup failure", async () => {
    let deleteAttempts = 0;
    const requestImpl: MattermostClient["request"] = async <T>(
      path: string,
      init?: RequestInit,
    ): Promise<T> => {
      if (path === "/posts") {
        return { id: "post-1" } as T;
      }
      if (path === "/posts/post-1" && init?.method === "DELETE") {
        deleteAttempts += 1;
        if (deleteAttempts === 1) {
          throw new Error("transient delete failure");
        }
      }
      return { id: "post-1" } as T;
    };
    const { stream } = createDraftStreamFixture({
      request: requestImpl,
      cleanupMode: "strict",
    });

    stream.update("Working...");
    await stream.flush();
    await expect(stream.clear()).resolves.toBeUndefined();

    expect(deleteAttempts).toBe(2);
    expect(stream.postId()).toBeUndefined();
  });

  it("surfaces repeated strict cleanup failures and retains the post id for a later retry", async () => {
    let deleteAttempts = 0;
    const requestImpl: MattermostClient["request"] = async <T>(
      path: string,
      init?: RequestInit,
    ): Promise<T> => {
      if (path === "/posts") {
        return { id: "post-1" } as T;
      }
      if (path === "/posts/post-1" && init?.method === "DELETE") {
        deleteAttempts += 1;
        if (deleteAttempts <= 2) {
          throw new Error(`delete failure ${deleteAttempts}`);
        }
      }
      return { id: "post-1" } as T;
    };
    const { stream } = createDraftStreamFixture({
      request: requestImpl,
      cleanupMode: "strict",
    });

    stream.update("Working...");
    await stream.flush();
    await expect(stream.clear()).rejects.toThrow("delete failure 2");

    expect(deleteAttempts).toBe(2);
    expect(stream.postId()).toBe("post-1");

    await expect(stream.clear()).resolves.toBeUndefined();
    expect(deleteAttempts).toBe(3);
    expect(stream.postId()).toBeUndefined();
  });
});
