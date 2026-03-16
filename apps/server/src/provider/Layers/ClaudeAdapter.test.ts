import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

import { ApprovalRequestId, type ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { vi } from "vitest";

import { ServerConfig } from "../../config.ts";

const mockState = vi.hoisted(() => {
  class MockEmitter {
    private readonly listeners = new Map<string, Set<(...args: Array<any>) => void>>();

    on(event: string, listener: (...args: Array<any>) => void) {
      const listeners = this.listeners.get(event) ?? new Set<(...args: Array<any>) => void>();
      listeners.add(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    once(event: string, listener: (...args: Array<any>) => void) {
      const wrapped = (...args: Array<any>) => {
        this.off(event, wrapped);
        listener(...args);
      };
      return this.on(event, wrapped);
    }

    off(event: string, listener: (...args: Array<any>) => void) {
      this.listeners.get(event)?.delete(listener);
      return this;
    }

    emit(event: string, ...args: Array<any>) {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(...args);
      }
    }
  }

  class MockReadable extends MockEmitter {
    write(data: string) {
      this.emit("data", {
        toString: () => data,
      });
    }
  }

  class MockWritable {
    writes: Array<string> = [];

    end(data?: string) {
      if (typeof data === "string") {
        this.writes.push(data);
      }
    }
  }

  class MockChild extends MockEmitter {
    readonly stdin = new MockWritable();
    readonly stdout = new MockReadable();
    readonly stderr = new MockReadable();
    readonly killCalls: Array<string | undefined> = [];

    kill(signal?: string) {
      this.killCalls.push(signal);
      return true;
    }

    emitExit(code: number | null, signal: string | null) {
      this.emit("exit", code, signal);
    }
  }

  const spawnCalls: Array<{
    binaryPath: string;
    args: string[];
    env: NodeJS.ProcessEnv | undefined;
    shell: boolean | undefined;
    child: MockChild;
  }> = [];

  const spawnMock = vi.fn(
    (
      binaryPath: string,
      args: string[],
      options?: {
        env?: NodeJS.ProcessEnv;
        shell?: boolean;
      },
    ) => {
    const child = new MockChild();
    spawnCalls.push({
      binaryPath,
      args: [...args],
      env: options?.env,
      shell: options?.shell,
      child,
    });
    return child;
    },
  );

  return {
    spawnCalls,
    spawnMock,
  };
});

vi.mock("node:child_process", () => ({
  spawn: mockState.spawnMock,
}));

import { ClaudeAdapter } from "../Services/ClaudeAdapter.ts";
import { makeClaudeAdapterLive } from "./ClaudeAdapter.ts";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const waitForAsyncEffects = () => Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)));
const claudeAdapterStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-claude-adapter-"));

const claudeAdapterLayer = it.layer(
  makeClaudeAdapterLive().pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(
      Layer.succeed(ServerConfig, {
        cwd: process.cwd(),
        stateDir: claudeAdapterStateDir,
        mode: "web" as const,
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: false,
        port: 0,
        host: undefined,
        authToken: undefined,
        keybindingsConfigPath: path.join(claudeAdapterStateDir, "keybindings.json"),
        staticDir: undefined,
        devUrl: undefined,
        noBrowser: false,
      }),
    ),
  ),
);

claudeAdapterLayer("ClaudeAdapterLive lifecycle", (it) => {
  it.effect("fails readThread instead of returning an empty stub snapshot", () =>
    Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const threadId = asThreadId("thread-read-unsupported");

      yield* adapter.startSession({
        provider: "claude",
        threadId,
        runtimeMode: "full-access",
      });

      const result = yield* adapter.readThread(threadId).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") {
        return;
      }

      assert.equal(result.failure._tag, "ProviderAdapterRequestError");
      if (result.failure._tag !== "ProviderAdapterRequestError") {
        return;
      }

      assert.equal(result.failure.method, "claude.readThread");
      assert.equal(
        result.failure.detail,
        "Claude Code CLI does not expose conversation history for thread 'thread-read-unsupported'.",
      );
    }),
  );

  it.effect("includes numTurns in rollbackThread unsupported errors", () =>
    Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const threadId = asThreadId("thread-rollback-unsupported");

      const result = yield* adapter.rollbackThread(threadId, 3).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") {
        return;
      }

      assert.equal(result.failure._tag, "ProviderAdapterRequestError");
      if (result.failure._tag !== "ProviderAdapterRequestError") {
        return;
      }

      assert.equal(result.failure.method, "claude.rollbackThread");
      assert.equal(
        result.failure.detail,
        "Claude Code CLI does not support rolling back 3 turn(s) for thread 'thread-rollback-unsupported'.",
      );
    }),
  );

  it.effect("treats repeated stopSession calls as a no-op", () =>
    Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const threadId = asThreadId("thread-stop-idempotent");

      yield* adapter.startSession({
        provider: "claude",
        threadId,
        runtimeMode: "full-access",
      });

      yield* adapter.stopSession(threadId);
      yield* adapter.stopSession(threadId);

      const hasSession = yield* adapter.hasSession(threadId);
      assert.equal(hasSession, false);
    }),
  );

  it.effect("keeps the new turn interruptible after a stale exit from the previous session", () =>
    Effect.gen(function* () {
      mockState.spawnCalls.length = 0;
      mockState.spawnMock.mockClear();

      const adapter = yield* ClaudeAdapter;
      const threadId = asThreadId("thread-stale-exit");

      yield* adapter.startSession({
        provider: "claude",
        threadId,
        runtimeMode: "full-access",
      });
      const firstTurn = yield* adapter.sendTurn({
        threadId,
        input: "first turn",
        attachments: [],
      });
      const firstChild = mockState.spawnCalls[0]?.child;
      assert.ok(firstChild);

      yield* adapter.startSession({
        provider: "claude",
        threadId,
        runtimeMode: "full-access",
      });
      assert.deepEqual(firstChild.killCalls, ["SIGTERM"]);

      const secondTurn = yield* adapter.sendTurn({
        threadId,
        input: "second turn",
        attachments: [],
      });
      const secondChild = mockState.spawnCalls[1]?.child;
      assert.ok(secondChild);

      firstChild.emitExit(null, "SIGTERM");
      yield* waitForAsyncEffects();

      const sessions = yield* adapter.listSessions();
      assert.equal(sessions[0]?.threadId, threadId);
      assert.equal(sessions[0]?.status, "running");
      assert.equal(sessions[0]?.activeTurnId, secondTurn.turnId);

      yield* adapter.interruptTurn(threadId);
      assert.deepEqual(secondChild.killCalls, ["SIGTERM"]);
      assert.equal(firstTurn.turnId === secondTurn.turnId, false);
    }),
  );

  it.effect("resumes an interrupted Claude session instead of reusing its session id as new", () =>
    Effect.gen(function* () {
      mockState.spawnCalls.length = 0;
      mockState.spawnMock.mockClear();

      const adapter = yield* ClaudeAdapter;
      const threadId = asThreadId("thread-interrupt-reuse-guard");

      yield* adapter.startSession({
        provider: "claude",
        threadId,
        runtimeMode: "full-access",
      });
      const firstTurn = yield* adapter.sendTurn({
        threadId,
        input: "first turn",
        attachments: [],
      });
      const firstSpawn = mockState.spawnCalls[0];
      const firstChild = firstSpawn?.child;
      assert.ok(firstSpawn);
      assert.ok(firstChild);

      yield* adapter.interruptTurn(threadId);
      assert.deepEqual(firstChild.killCalls, ["SIGTERM"]);
      firstChild.emitExit(null, "SIGTERM");
      yield* waitForAsyncEffects();

      const secondTurn = yield* adapter.sendTurn({
        threadId,
        input: "second turn",
        attachments: [],
      });
      const secondSpawn = mockState.spawnCalls[1];
      assert.ok(secondSpawn);
      assert.equal(secondTurn.resumeCursor, firstTurn.resumeCursor);
      assert.equal(secondSpawn.args.includes("--resume"), true);
      assert.equal(secondSpawn.args.includes("--session-id"), false);
    }),
  );

  it.effect("does not mark a replaced session resumable from a stale completed-process exit", () =>
    Effect.gen(function* () {
      mockState.spawnCalls.length = 0;
      mockState.spawnMock.mockClear();

      const adapter = yield* ClaudeAdapter;
      const threadId = asThreadId("thread-stale-complete");

      yield* adapter.startSession({
        provider: "claude",
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "first turn",
        attachments: [],
      });
      const firstChild = mockState.spawnCalls[0]?.child;
      assert.ok(firstChild);

      firstChild.stdout.write(`${JSON.stringify({ type: "result", subtype: "success" })}\n`);
      yield* waitForAsyncEffects();

      yield* adapter.startSession({
        provider: "claude",
        threadId,
        runtimeMode: "full-access",
      });

      firstChild.emitExit(0, null);

      yield* adapter.sendTurn({
        threadId,
        input: "second turn",
        attachments: [],
      });

      const secondSpawn = mockState.spawnCalls[1];
      assert.ok(secondSpawn);
      assert.equal(secondSpawn.binaryPath, "claude");
      assert.equal(secondSpawn.args.includes("--session-id"), true);
      assert.equal(secondSpawn.args.includes("--resume"), false);
    }),
  );

  it.effect("captures Claude turn history for readThread", () =>
    Effect.gen(function* () {
      mockState.spawnCalls.length = 0;
      mockState.spawnMock.mockClear();

      const adapter = yield* ClaudeAdapter;
      const threadId = asThreadId("thread-read-history");

      yield* adapter.startSession({
        provider: "claude",
        threadId,
        runtimeMode: "full-access",
      });
      const startedTurn = yield* adapter.sendTurn({
        threadId,
        input: "history turn",
        attachments: [],
      });
      const child = mockState.spawnCalls[0]?.child;
      assert.ok(child);

      child.stdout.write(
        `${JSON.stringify({
          type: "stream_event",
          event: {
            type: "message_start",
            message: {
              id: "msg-history",
            },
          },
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: {
              type: "text_delta",
              text: "Hello",
            },
          },
        })}\n`,
      );
      child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success" })}\n`);
      yield* waitForAsyncEffects();

      const snapshot = yield* adapter.readThread(threadId);
      assert.equal(snapshot.threadId, threadId);
      assert.equal(snapshot.turns.length, 1);
      assert.equal(snapshot.turns[0]?.id, startedTurn.turnId);
      assert.equal(snapshot.turns[0]?.items.length, 3);
      assert.deepEqual(snapshot.turns[0]?.items[0], {
        kind: "turn.started",
        input: "history turn",
        interactionMode: null,
      });
      assert.deepEqual(snapshot.turns[0]?.items[1], {
        kind: "content.delta",
        itemId: "msg-history",
        streamKind: "assistant_text",
        delta: "Hello",
      });
      assert.deepEqual(snapshot.turns[0]?.items[2], {
        kind: "turn.completed",
        state: "completed",
        stopReason: "end_turn",
      });
    }),
  );

  it.effect("spawns Claude through the Windows shell so claude.cmd resolves", () =>
    Effect.gen(function* () {
      mockState.spawnCalls.length = 0;
      mockState.spawnMock.mockClear();

      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: "win32",
      });

      try {
        const adapter = yield* ClaudeAdapter;
        const threadId = asThreadId("thread-win32-shell");

        yield* adapter.startSession({
          provider: "claude",
          threadId,
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId,
          input: "windows spawn",
          attachments: [],
        });

        const spawnCall = mockState.spawnCalls[0];
        assert.ok(spawnCall);
        assert.equal(spawnCall.binaryPath, "claude");
        assert.equal(spawnCall.shell, true);
      } finally {
        Object.defineProperty(process, "platform", {
          configurable: true,
          value: originalPlatform,
        });
      }
    }),
  );

  it.effect("allows stopSession to be called repeatedly", () =>
    Effect.gen(function* () {
      mockState.spawnCalls.length = 0;
      mockState.spawnMock.mockClear();

      const adapter = yield* ClaudeAdapter;
      const threadId = asThreadId("thread-stop-idempotent");

      yield* adapter.startSession({
        provider: "claude",
        threadId,
        runtimeMode: "full-access",
      });

      yield* adapter.stopSession(threadId);
      yield* adapter.stopSession(threadId);

      const sessions = yield* adapter.listSessions();
      assert.equal(sessions.some((session) => session.threadId === threadId), false);
    }),
  );

  it.effect("finalizes an interrupted active turn before stopping the session", () =>
    Effect.gen(function* () {
      mockState.spawnCalls.length = 0;
      mockState.spawnMock.mockClear();

      const adapter = yield* ClaudeAdapter;
      const threadId = asThreadId("thread-stop-finalizes-active-turn");

      yield* adapter.startSession({
        provider: "claude",
        threadId,
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "stop me",
        attachments: [],
      });
      const child = mockState.spawnCalls[0]?.child;
      assert.ok(child);

      yield* adapter.stopSession(threadId);
      child.emitExit(null, "SIGTERM");
      yield* waitForAsyncEffects();

      const snapshot = yield* adapter.readThread(threadId);
      assert.equal(snapshot.turns.length, 1);
      assert.deepEqual(snapshot.turns[0]?.items, [
        {
          kind: "turn.started",
          input: "stop me",
          interactionMode: null,
        },
        {
          kind: "turn.completed",
          state: "interrupted",
        },
      ]);

      const events: Array<ProviderRuntimeEvent> = Array.from(
        yield* Stream.runCollect(
          adapter.streamEvents.pipe(
            Stream.filter((event) => event.threadId === threadId),
            Stream.take(6),
          ),
        ),
      );
      const completedEvents = events.filter((event) => event.type === "turn.completed");
      assert.equal(completedEvents.length, 1);
      const turnCompleted = completedEvents[0];
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(turnCompleted.payload.state, "interrupted");
      }
    }),
  );

  it.effect("resets Claude resume state after rollback", () =>
    Effect.gen(function* () {
      mockState.spawnCalls.length = 0;
      mockState.spawnMock.mockClear();

      const adapter = yield* ClaudeAdapter;
      const threadId = asThreadId("thread-rollback-reset");

      yield* adapter.startSession({
        provider: "claude",
        threadId,
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "first turn",
        attachments: [],
      });
      const firstChild = mockState.spawnCalls[0]?.child;
      assert.ok(firstChild);
      firstChild.stdout.write(`${JSON.stringify({ type: "result", subtype: "success" })}\n`);
      yield* waitForAsyncEffects();
      firstChild.emitExit(0, null);

      yield* adapter.sendTurn({
        threadId,
        input: "second turn",
        attachments: [],
      });
      const secondSpawn = mockState.spawnCalls[1];
      const secondChild = secondSpawn?.child;
      assert.ok(secondSpawn);
      assert.ok(secondChild);
      assert.equal(secondSpawn.args.includes("--resume"), true);
      secondChild.stdout.write(`${JSON.stringify({ type: "result", subtype: "success" })}\n`);
      yield* waitForAsyncEffects();
      secondChild.emitExit(0, null);

      const rolledBack = yield* adapter.rollbackThread(threadId, 1);
      assert.equal(rolledBack.turns.length, 1);

      yield* adapter.sendTurn({
        threadId,
        input: "third turn",
        attachments: [],
      });
      const thirdSpawn = mockState.spawnCalls[2];
      assert.ok(thirdSpawn);
      assert.equal(thirdSpawn.args.includes("--session-id"), true);
      assert.equal(thirdSpawn.args.includes("--resume"), false);
    }),
  );

  it.effect("finalizes an interrupted active turn before rollback truncates it", () =>
    Effect.gen(function* () {
      mockState.spawnCalls.length = 0;
      mockState.spawnMock.mockClear();

      const adapter = yield* ClaudeAdapter;
      const threadId = asThreadId("thread-rollback-finalizes-active-turn");

      yield* adapter.startSession({
        provider: "claude",
        threadId,
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "rollback me",
        attachments: [],
      });
      const child = mockState.spawnCalls[0]?.child;
      assert.ok(child);

      const rolledBack = yield* adapter.rollbackThread(threadId, 1);
      child.emitExit(null, "SIGTERM");
      yield* waitForAsyncEffects();

      assert.equal(rolledBack.turns.length, 0);
      const snapshot = yield* adapter.readThread(threadId);
      assert.equal(snapshot.turns.length, 0);

      const sessions = yield* adapter.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      assert.ok(session);
      assert.equal(session?.status, "ready");
      assert.equal(session?.activeTurnId, undefined);

      const events: Array<ProviderRuntimeEvent> = Array.from(
        yield* Stream.runCollect(
          adapter.streamEvents.pipe(
            Stream.filter((event) => event.threadId === threadId),
            Stream.take(7),
          ),
        ),
      );
      const turnCompleted = events.find((event) => event.type === "turn.completed");
      assert.ok(turnCompleted);
      if (turnCompleted?.type === "turn.completed") {
        assert.equal(turnCompleted.payload.state, "interrupted");
      }
    }),
  );

  it.effect("maps Claude thinking and effort model options into process env", () =>
    Effect.gen(function* () {
      mockState.spawnCalls.length = 0;
      mockState.spawnMock.mockClear();

      const adapter = yield* ClaudeAdapter;
      const threadId = asThreadId("thread-claude-model-options");

      yield* adapter.startSession({
        provider: "claude",
        threadId,
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        model: "sonnet",
        input: "reason more",
        attachments: [],
        modelOptions: {
          claude: {
            effort: "high",
          },
        },
      });

      const firstSpawn = mockState.spawnCalls[0];
      assert.ok(firstSpawn);
      assert.equal(firstSpawn.env?.CLAUDE_CODE_EFFORT_LEVEL, "high");
      assert.equal(firstSpawn.env?.MAX_THINKING_TOKENS, undefined);

      yield* adapter.startSession({
        provider: "claude",
        threadId,
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        model: "sonnet",
        input: "skip thinking",
        attachments: [],
        modelOptions: {
          claude: {
            thinking: false,
            effort: "high",
          },
        },
      });

      const secondSpawn = mockState.spawnCalls[1];
      assert.ok(secondSpawn);
      assert.equal(secondSpawn.env?.MAX_THINKING_TOKENS, "0");
      assert.equal(secondSpawn.env?.CLAUDE_CODE_EFFORT_LEVEL, undefined);
    }),
  );

  it.effect("passes persisted image attachments to Claude as local file paths", () =>
    Effect.gen(function* () {
      mockState.spawnCalls.length = 0;
      mockState.spawnMock.mockClear();

      const adapter = yield* ClaudeAdapter;
      const threadId = asThreadId("thread-claude-image");
      const attachmentId = "thread-claude-image-att-1";
      const attachmentPath = path.join(claudeAdapterStateDir, "attachments", `${attachmentId}.png`);
      fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
      fs.writeFileSync(attachmentPath, "png-bytes", "utf8");

      yield* adapter.startSession({
        provider: "claude",
        threadId,
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "Describe this image",
        attachments: [
          {
            type: "image",
            id: attachmentId,
            name: "example.png",
            mimeType: "image/png",
            sizeBytes: 9,
          },
        ],
      });

      const spawnCall = mockState.spawnCalls[0];
      assert.ok(spawnCall);
      const prompt = spawnCall.child.stdin.writes.at(-1);
      assert.equal(typeof prompt, "string");
      assert.equal(prompt?.includes("Attached image files are available at these local paths:"), true);
      assert.equal(prompt?.includes(attachmentPath), true);
      assert.equal(prompt?.includes("Describe this image"), true);
    }),
  );

  it.effect("maps Claude permission denials into pending approval events", () =>
    Effect.gen(function* () {
      mockState.spawnCalls.length = 0;
      mockState.spawnMock.mockClear();

      const adapter = yield* ClaudeAdapter;
      const threadId = asThreadId("thread-permission-denial");

      yield* adapter.startSession({
        provider: "claude",
        threadId,
        runtimeMode: "approval-required",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "blocked write",
        attachments: [],
      });
      const child = mockState.spawnCalls[0]?.child;
      assert.ok(child);

      child.stdout.write(
        `${JSON.stringify({
          type: "result",
          subtype: "error_max_turns",
          permission_denials: [
            {
              tool_use_id: "tool-denied-1",
              tool_name: "Write",
              tool_input: {
                file_path: "/tmp/blocked.ts",
              },
            },
          ],
        })}\n`,
      );
      yield* waitForAsyncEffects();

      const events: Array<ProviderRuntimeEvent> = Array.from(
        yield* Stream.runCollect(
          adapter.streamEvents.pipe(
            Stream.filter((event) => event.threadId === threadId),
            Stream.take(6),
          ),
        ),
      );
      const opened = events.find((event) => event.type === "request.opened");
      const resolved = events.find((event) => event.type === "request.resolved");

      assert.ok(opened);
      assert.equal(opened?.requestId, "claude-denial:thread-permission-denial:tool-denied-1");
      if (opened?.type === "request.opened") {
        assert.equal(opened.payload.requestType, "file_change_approval");
        assert.equal(opened.payload.detail, "/tmp/blocked.ts");
      }
      assert.equal(resolved, undefined);
    }),
  );

  it.effect("resolves denied Claude approvals as declined without replaying", () =>
    Effect.gen(function* () {
      mockState.spawnCalls.length = 0;
      mockState.spawnMock.mockClear();

      const adapter = yield* ClaudeAdapter;
      const threadId = asThreadId("thread-permission-decline");

      yield* adapter.startSession({
        provider: "claude",
        threadId,
        runtimeMode: "approval-required",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "blocked write",
        attachments: [],
      });
      const child = mockState.spawnCalls[0]?.child;
      assert.ok(child);

      child.stdout.write(
        `${JSON.stringify({
          type: "result",
          subtype: "error_max_turns",
          permission_denials: [
            {
              tool_use_id: "tool-denied-2",
              tool_name: "Write",
              tool_input: {
                file_path: "/tmp/blocked.ts",
              },
            },
          ],
        })}\n`,
      );
      yield* waitForAsyncEffects();

      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.makeUnsafe("claude-denial:thread-permission-decline:tool-denied-2"),
        "decline",
      );

      const events: Array<ProviderRuntimeEvent> = Array.from(
        yield* Stream.runCollect(
          adapter.streamEvents.pipe(
            Stream.filter((event) => event.threadId === threadId),
            Stream.take(8),
          ),
        ),
      );
      const resolved = events.find((event) => event.type === "request.resolved");

      assert.equal(mockState.spawnCalls.length, 1);
      assert.ok(resolved);
      if (resolved?.type === "request.resolved") {
        assert.equal(resolved.requestId, "claude-denial:thread-permission-decline:tool-denied-2");
        assert.equal(resolved.payload.requestType, "file_change_approval");
        assert.equal(resolved.payload.decision, "decline");
      }
    }),
  );

  it.effect("replays denied Claude approvals with bypass permissions after acceptForSession", () =>
    Effect.gen(function* () {
      mockState.spawnCalls.length = 0;
      mockState.spawnMock.mockClear();

      const adapter = yield* ClaudeAdapter;
      const threadId = asThreadId("thread-permission-accept");

      yield* adapter.startSession({
        provider: "claude",
        threadId,
        runtimeMode: "approval-required",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "blocked write",
        attachments: [],
      });
      const firstChild = mockState.spawnCalls[0]?.child;
      assert.ok(firstChild);

      firstChild.stdout.write(
        `${JSON.stringify({
          type: "result",
          subtype: "error_max_turns",
          permission_denials: [
            {
              tool_use_id: "tool-denied-3",
              tool_name: "Write",
              tool_input: {
                file_path: "/tmp/blocked.ts",
              },
            },
          ],
        })}\n`,
      );
      yield* waitForAsyncEffects();

      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.makeUnsafe("claude-denial:thread-permission-accept:tool-denied-3"),
        "acceptForSession",
      );

      const secondSpawn = mockState.spawnCalls[1];
      assert.ok(secondSpawn);
      assert.equal(secondSpawn.args.includes("--resume"), true);
      assert.equal(secondSpawn.args.includes("--permission-mode"), true);
      assert.equal(
        secondSpawn.args[secondSpawn.args.indexOf("--permission-mode") + 1],
        "bypassPermissions",
      );

      const events: Array<ProviderRuntimeEvent> = Array.from(
        yield* Stream.runCollect(
          adapter.streamEvents.pipe(
            Stream.filter((event) => event.threadId === threadId),
            Stream.take(10),
          ),
        ),
      );
      const resolved = events.find((event) => event.type === "request.resolved");

      assert.ok(resolved);
      if (resolved?.type === "request.resolved") {
        assert.equal(resolved.payload.requestType, "file_change_approval");
        assert.equal(resolved.payload.decision, "acceptForSession");
      }

      const secondChild = secondSpawn.child;
      secondChild.stdout.write(`${JSON.stringify({ type: "result", subtype: "success" })}\n`);
      yield* waitForAsyncEffects();
      secondChild.emitExit(0, null);

      yield* adapter.sendTurn({
        threadId,
        input: "follow-up write",
        attachments: [],
      });
      const thirdSpawn = mockState.spawnCalls[2];
      assert.ok(thirdSpawn);
      assert.equal(
        thirdSpawn.args[thirdSpawn.args.indexOf("--permission-mode") + 1],
        "bypassPermissions",
      );
    }),
  );

  it.effect("resetting Claude rollback clears accept-for-session bypass state", () =>
    Effect.gen(function* () {
      mockState.spawnCalls.length = 0;
      mockState.spawnMock.mockClear();

      const adapter = yield* ClaudeAdapter;
      const threadId = asThreadId("thread-rollback-clears-bypass");

      yield* adapter.startSession({
        provider: "claude",
        threadId,
        runtimeMode: "approval-required",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "blocked write",
        attachments: [],
      });
      const firstChild = mockState.spawnCalls[0]?.child;
      assert.ok(firstChild);
      firstChild.stdout.write(
        `${JSON.stringify({
          type: "result",
          subtype: "error_max_turns",
          permission_denials: [
            {
              tool_use_id: "tool-denied-rollback-1",
              tool_name: "Write",
              tool_input: {
                file_path: "/tmp/blocked.ts",
              },
            },
          ],
        })}\n`,
      );
      yield* waitForAsyncEffects();

      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.makeUnsafe(
          "claude-denial:thread-rollback-clears-bypass:tool-denied-rollback-1",
        ),
        "acceptForSession",
      );

      const secondSpawn = mockState.spawnCalls[1];
      const secondChild = secondSpawn?.child;
      assert.ok(secondSpawn);
      assert.ok(secondChild);
      assert.equal(
        secondSpawn.args[secondSpawn.args.indexOf("--permission-mode") + 1],
        "bypassPermissions",
      );
      secondChild.stdout.write(`${JSON.stringify({ type: "result", subtype: "success" })}\n`);
      yield* waitForAsyncEffects();
      secondChild.emitExit(0, null);

      const rolledBack = yield* adapter.rollbackThread(threadId, 1);
      assert.equal(rolledBack.turns.length, 1);

      yield* adapter.sendTurn({
        threadId,
        input: "needs approval again",
        attachments: [],
      });
      const thirdSpawn = mockState.spawnCalls[2];
      assert.ok(thirdSpawn);
      assert.equal(thirdSpawn.args.includes("--session-id"), true);
      assert.equal(thirdSpawn.args.includes("--resume"), false);
      assert.equal(
        thirdSpawn.args[thirdSpawn.args.indexOf("--permission-mode") + 1],
        "default",
      );
    }),
  );

  it.effect("maps AskUserQuestion tool uses into canonical user-input requests", () =>
    Effect.gen(function* () {
      mockState.spawnCalls.length = 0;
      mockState.spawnMock.mockClear();

      const adapter = yield* ClaudeAdapter;
      const threadId = asThreadId("thread-claude-user-input");

      yield* adapter.startSession({
        provider: "claude",
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "ask me something",
        attachments: [],
      });
      const child = mockState.spawnCalls[0]?.child;
      assert.ok(child);

      child.stdout.write(
        `${JSON.stringify({
          type: "assistant",
          message: {
            id: "msg-user-input",
            content: [
              {
                type: "tool_use",
                id: "ask-user-input-1",
                name: "AskUserQuestion",
                input: {
                  questions: [
                    {
                      id: "sandbox_mode",
                      header: "Sandbox",
                      question: "Which mode should be used?",
                      options: [
                        {
                          label: "workspace-write",
                          description: "Allow workspace writes only",
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        })}\n`,
      );
      yield* waitForAsyncEffects();

      const events: Array<ProviderRuntimeEvent> = Array.from(
        yield* Stream.runCollect(
          adapter.streamEvents.pipe(
            Stream.filter((event) => event.threadId === threadId),
            Stream.take(5),
          ),
        ),
      );
      const requested = events.find((event) => event.type === "user-input.requested");

      assert.ok(requested);
      assert.equal(
        requested?.requestId,
        "claude-user-input:thread-claude-user-input:ask-user-input-1",
      );
      if (requested?.type === "user-input.requested") {
        assert.equal(requested.payload.questions[0]?.id, "sandbox_mode");
        assert.equal(
          requested.payload.questions[0]?.options[0]?.label,
          "workspace-write",
        );
      }
    }),
  );

  it.effect("continues Claude user-input requests through a follow-up turn", () =>
    Effect.gen(function* () {
      mockState.spawnCalls.length = 0;
      mockState.spawnMock.mockClear();

      const adapter = yield* ClaudeAdapter;
      const threadId = asThreadId("thread-claude-user-input-answer");

      yield* adapter.startSession({
        provider: "claude",
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "ask me something",
        attachments: [],
      });
      const firstChild = mockState.spawnCalls[0]?.child;
      assert.ok(firstChild);

      firstChild.stdout.write(
        `${JSON.stringify({
          type: "assistant",
          message: {
            id: "msg-user-input-answer",
            content: [
              {
                type: "tool_use",
                id: "ask-user-input-2",
                name: "AskUserQuestion",
                input: {
                  question: "Which mode should be used?",
                  header: "Sandbox",
                  options: [
                    {
                      label: "workspace-write",
                      description: "Allow workspace writes only",
                    },
                  ],
                },
              },
            ],
          },
        })}\n`,
      );
      firstChild.stdout.write(`${JSON.stringify({ type: "result", subtype: "success" })}\n`);
      yield* waitForAsyncEffects();
      firstChild.emitExit(0, null);

      yield* adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.makeUnsafe(
          "claude-user-input:thread-claude-user-input-answer:ask-user-input-2",
        ),
        {
          answer: "workspace-write",
        },
      );

      const secondSpawn = mockState.spawnCalls[1];
      assert.ok(secondSpawn);
      assert.equal(secondSpawn.args.includes("--resume"), true);
      assert.equal(
        secondSpawn.child.stdin.writes.at(-1)?.includes("workspace-write"),
        true,
      );
      assert.equal(
        secondSpawn.child.stdin.writes.at(-1)?.includes("<t3-user-input-response"),
        true,
      );

      const events: Array<ProviderRuntimeEvent> = Array.from(
        yield* Stream.runCollect(
          adapter.streamEvents.pipe(
            Stream.filter((event) => event.threadId === threadId),
            Stream.take(10),
          ),
        ),
      );
      const resolved = events.find((event) => event.type === "user-input.resolved");

      assert.ok(resolved);
      if (resolved?.type === "user-input.resolved") {
        assert.equal(
          resolved.requestId,
          "claude-user-input:thread-claude-user-input-answer:ask-user-input-2",
        );
        assert.deepEqual(resolved.payload.answers, {
          answer: "workspace-write",
        });
      }
    }),
  );

  it.effect("normalizes Claude plan-mode text into proposed plan and plan updates", () =>
    Effect.gen(function* () {
      mockState.spawnCalls.length = 0;
      mockState.spawnMock.mockClear();

      const adapter = yield* ClaudeAdapter;
      const threadId = asThreadId("thread-claude-plan-mode");

      yield* adapter.startSession({
        provider: "claude",
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "plan this work",
        attachments: [],
        interactionMode: "plan",
      });
      const child = mockState.spawnCalls[0]?.child;
      assert.ok(child);

      child.stdout.write(
        `${JSON.stringify({
          type: "stream_event",
          event: {
            type: "message_start",
            message: {
              id: "msg-plan",
            },
          },
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: {
              type: "text_delta",
              text: "## Ship plan\n\n- inspect code",
            },
          },
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "assistant",
          message: {
            id: "msg-plan",
            content: [
              {
                type: "text",
                text: "## Ship plan\n\n- inspect code\n- patch adapter",
              },
            ],
          },
        })}\n`,
      );
      yield* waitForAsyncEffects();

      const events: Array<ProviderRuntimeEvent> = Array.from(
        yield* Stream.runCollect(
          adapter.streamEvents.pipe(
            Stream.filter((event) => event.threadId === threadId),
            Stream.take(8),
          ),
        ),
      );

      const proposedDelta = events.find((event) => event.type === "turn.proposed.delta");
      const proposedCompleted = events.find((event) => event.type === "turn.proposed.completed");
      const planUpdatedEvents = events.filter((event) => event.type === "turn.plan.updated");

      assert.ok(proposedDelta);
      assert.ok(proposedCompleted);
      assert.equal(planUpdatedEvents.length >= 1, true);
      if (proposedDelta?.type === "turn.proposed.delta") {
        assert.equal(proposedDelta.payload.delta, "## Ship plan\n\n- inspect code");
      }
      if (proposedCompleted?.type === "turn.proposed.completed") {
        assert.equal(proposedCompleted.payload.planMarkdown, "## Ship plan\n\n- inspect code\n- patch adapter");
      }
      const latestPlanUpdated = planUpdatedEvents.at(-1);
      if (latestPlanUpdated?.type === "turn.plan.updated") {
        assert.deepEqual(latestPlanUpdated.payload.plan, [
          { step: "inspect code", status: "pending" },
          { step: "patch adapter", status: "pending" },
        ]);
      }
    }),
  );
});
