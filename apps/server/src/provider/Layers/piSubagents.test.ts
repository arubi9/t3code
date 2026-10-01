import { assert, it } from "@effect/vitest";
import { TurnId } from "@t3tools/contracts";
import { makePiSubagents } from "./piSubagents.ts";
const turnId = TurnId.make("parent-turn");
const base = {
  turnId,
  toolCallId: "spawn",
  toolName: "Agent",
  args: { prompt: "task" },
  completed: true,
  failed: false,
  interrupted: false,
};

it("an immediate terminal closes background liveness; its delayed echo cannot close a resumed agent", () => {
  const live = new Set<string>();
  const tasks = makePiSubagents(live);
  const started = tasks.tool({
    ...base,
    result: { details: { agentId: "a", status: "background" } },
  });
  const oldId = started[0]?.payload.taskId;
  const immediate = tasks.notification(
    { details: { id: "a", status: "completed", resultPreview: "first" } },
    true,
  );
  assert.equal(immediate[0]?.payload.taskId, oldId);
  assert.isFalse(tasks.hasBackgroundWork());
  const resumed = tasks.tool({
    ...base,
    toolCallId: "resume",
    args: { resume: "a", prompt: "continue" },
    result: { details: { agentId: "a", status: "background", sessionFile: "/fixture/new.jsonl" } },
  });
  assert.notEqual(resumed[0]?.payload.taskId, oldId);
  const echo = tasks.notification({
    details: { id: "a", status: "completed", sessionFile: "/fixture/old.jsonl" },
  });
  assert.equal(echo[0]?.payload.taskId, oldId);
  assert.isTrue(tasks.hasBackgroundWork());
  assert.isTrue(live.has("/fixture/new.jsonl"));
  const done = tasks.notification({
    details: { id: "a", status: "error", error: "failed second" },
  });
  assert.equal(done[0]?.payload.taskId, resumed[0]?.payload.taskId);
  assert.isFalse(tasks.hasBackgroundWork());
  assert.equal(live.size, 0);
});

it("task-result fetches close the original row, and duplicate terminal notifications are ignored", () => {
  const tasks = makePiSubagents(new Set());
  const start = tasks.tool({
    ...base,
    result: { details: { agentId: "a", description: "worker", status: "background" } },
  });
  const fetched = tasks.tool({
    ...base,
    toolName: "get_subagent_result",
    toolCallId: "fetch",
    args: { agent_id: "a" },
    result: {
      content: [
        { type: "text", text: "Agent: a\nType: worker | Status: completed\n\nfinal result" },
      ],
    },
  });
  assert.equal(fetched[0]?.payload.taskId, start[0]?.payload.taskId);
  assert.isFalse(tasks.hasBackgroundWork());
  assert.deepEqual(tasks.notification({ details: { id: "a", status: "completed" } }), []);
});

it("native child results keep failure stderr, session handles, stable task identities, and release live-session guards", () => {
  const live = new Set<string>();
  const tasks = makePiSubagents(live);
  const result = {
    agent: "worker",
    task: "task",
    sessionFile: "/fixture/child.jsonl",
    finished: false,
    messages: [],
  };
  const started = tasks.tool({
    ...base,
    toolName: "subagent",
    completed: false,
    result: { details: { results: [result] } },
  });
  assert.isTrue(live.has(result.sessionFile));
  const failed = tasks.tool({
    ...base,
    toolName: "subagent",
    result: {
      details: {
        results: [
          {
            ...result,
            finished: true,
            stopReason: "error",
            errorMessage: "",
            stderr: "only error",
            exitCode: 1,
          },
        ],
      },
    },
  });
  assert.equal(failed[0]?.payload.taskId, started[0]?.payload.taskId);
  assert.deepInclude(failed[0]?.payload, {
    status: "failed",
    summary: "only error",
    outputFile: result.sessionFile,
  });
  assert.equal(live.size, 0);
  assert.deepEqual(tasks.stop(), []);
});

it("Stop terminalizes both foreground agents and workflows once and rejects late resurrection", () => {
  const tasks = makePiSubagents(new Set());
  tasks.tool({
    ...base,
    completed: false,
    result: { details: { agentId: "a", status: "running" } },
  });
  tasks.tool({
    ...base,
    toolName: "SubagentWorkflow",
    toolCallId: "workflow",
    result: { details: { taskId: "w" } },
  });
  assert.equal(tasks.stop().length, 2);
  assert.deepEqual(tasks.stop(), []);
  assert.deepEqual(tasks.notification({ details: { id: "w", status: "completed" } }), []);
});
