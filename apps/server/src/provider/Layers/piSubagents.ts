import { RuntimeTaskId, type ProviderRuntimeEvent, type TurnId } from "@t3tools/contracts";
import {
  piRecordField as field,
  piRecordNumber as number,
  piRecordString as string,
} from "./PiRpc.ts";

export function piContentText(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? content
        .map((block) => (field(block, "type") === "text" ? (string(block, "text") ?? "") : ""))
        .join("")
    : "";
}

function resultOutput(result: unknown): string {
  if (
    (number(result, "exitCode") ?? 0) !== 0 ||
    ["error", "aborted"].includes(string(result, "stopReason") ?? "")
  ) {
    const failure = string(result, "errorMessage") || string(result, "stderr");
    if (failure) return failure;
  }
  const messages = field(result, "messages");
  if (!Array.isArray(messages)) return "";
  for (const message of messages.toReversed()) {
    if (string(message, "role") !== "assistant") continue;
    const text = piContentText(field(message, "content"));
    if (text) return text;
  }
  return "";
}

type TaskEvent = Extract<
  ProviderRuntimeEvent,
  { type: "task.started" | "task.progress" | "task.completed" }
>;
export type PiTaskEvent = TaskEvent extends infer E
  ? E extends TaskEvent
    ? Pick<E, "type" | "payload" | "turnId">
    : never
  : never;
interface Task {
  readonly taskId: RuntimeTaskId;
  readonly turnId: TurnId;
  readonly toolUseId: string;
  readonly title: string;
  readonly prompt: string;
  readonly model: string | undefined;
  sessionFile: string | undefined;
  background: boolean;
  terminal: boolean;
}

/** Provider-local task identities survive parent turn settlement and late notification echoes. */
export function makePiSubagents(liveChildSessions: Set<string>) {
  const tasks = new Map<string, Task>();
  const agents = new Map<string, Task>();
  const echoes = new Map<string, Task[]>();

  const update = (
    task: Task,
    output: string,
    status?: "completed" | "failed" | "stopped",
    first = false,
  ): PiTaskEvent[] => {
    if (task.sessionFile) {
      if (status) liveChildSessions.delete(task.sessionFile);
      else liveChildSessions.add(task.sessionFile);
    }
    const payload = {
      taskId: task.taskId,
      taskType: "pi-subagent",
      title: task.title,
      toolUseId: task.toolUseId,
      ...(task.model ? { model: task.model } : {}),
      // The native transcript is resumable using {sessionPath: outputFile}.
      // Main has no app_thread.created event; retain the handle in its native task contract.
      ...(task.sessionFile ? { outputFile: task.sessionFile } : {}),
    };
    const started: PiTaskEvent[] = first
      ? [
          {
            type: "task.started",
            turnId: task.turnId,
            payload: { ...payload, description: task.prompt || task.title },
          },
        ]
      : [];
    if (status) {
      task.terminal = true;
      return [
        ...started,
        {
          type: "task.completed",
          turnId: task.turnId,
          payload: {
            ...payload,
            status,
            ...(output.trim() ? { summary: output.slice(0, 10_000).trim() } : {}),
          },
        },
      ];
    }
    return [
      ...started,
      {
        type: "task.progress",
        turnId: task.turnId,
        payload: {
          ...payload,
          description: task.title,
          status: "running",
          ...(output.trim() ? { summary: output.slice(0, 200).trim() } : {}),
        },
      },
    ];
  };

  const tool = (input: {
    turnId: TurnId;
    toolCallId: string;
    toolName: string;
    args: unknown;
    result: unknown;
    completed: boolean;
    failed: boolean;
    interrupted: boolean;
  }): PiTaskEvent[] => {
    const { turnId, toolCallId, toolName, args, result, completed } = input;
    const details = field(result, "details");
    if (toolName === "subagent") {
      const results = field(details, "results");
      if (!Array.isArray(results)) return [];
      return results.flatMap((result, index) => {
        const title = string(result, "agent");
        const prompt = string(result, "task");
        if (!title || prompt === undefined) return [];
        const id = `${toolCallId}:subagent:${number(result, "step") ?? index}`;
        let task = tasks.get(id);
        if (task?.terminal) return [];
        const first = task === undefined;
        task ??= {
          taskId: RuntimeTaskId.make(id),
          turnId,
          toolUseId: toolCallId,
          title,
          prompt,
          model: string(result, "model"),
          sessionFile: undefined,
          background: false,
          terminal: false,
        };
        task.sessionFile = string(result, "sessionFile") ?? task.sessionFile;
        tasks.set(id, task);
        const finished = completed || field(result, "finished") === true;
        const stopped = input.interrupted || string(result, "stopReason") === "aborted";
        const failed =
          (number(result, "exitCode") ?? 0) !== 0 || string(result, "stopReason") === "error";
        return update(
          task,
          resultOutput(result),
          finished ? (stopped ? "stopped" : failed ? "failed" : "completed") : undefined,
          first,
        );
      });
    }
    if (!["Agent", "get_subagent_result", "SubagentWorkflow"].includes(toolName)) return [];
    const output = piContentText(field(result, "content"));
    const fetched = toolName === "get_subagent_result";
    const workflowId = string(details, "taskId");
    const agentId =
      string(details, "agentId") ??
      workflowId ??
      (fetched ? /^Agent: ([^\n]+)$/m.exec(output)?.[1]?.trim() : undefined) ??
      string(args, "agent_id");
    if (!agentId && !(completed && toolName === "Agent" && input.failed)) return [];
    const rawStatus =
      string(details, "status") ??
      (workflowId ? "background" : undefined) ??
      (fetched ? /^Type: .* \| Status: ([^ |]+)/m.exec(output)?.[1] : undefined);
    const prior = agentId ? agents.get(agentId) : undefined;
    const resume = toolName === "Agent" && string(args, "resume") !== undefined;
    const id = resume
      ? `pi-subagents:${agentId ?? toolCallId}:${toolCallId}`
      : `pi-subagents:${agentId ?? toolCallId}`;
    let task = prior && !prior.terminal ? prior : tasks.get(id);
    if (task?.terminal) return [];
    const first = task === undefined;
    task ??= {
      taskId: RuntimeTaskId.make(id),
      turnId,
      toolUseId: toolCallId,
      title:
        string(details, "description") ||
        string(args, "description") ||
        string(details, "displayName") ||
        (workflowId ? `Workflow ${string(args, "name") ?? workflowId}` : "Agent"),
      prompt: string(args, "prompt") ?? string(args, "description") ?? "",
      model: string(details, "modelName"),
      sessionFile: undefined,
      background: false,
      terminal: false,
    };
    task.sessionFile = string(details, "sessionFile") ?? task.sessionFile;
    task.background ||= rawStatus === "background";
    tasks.set(task.taskId, task);
    if (agentId) agents.set(agentId, task);
    const running = ["background", "running", "queued"].includes(rawStatus ?? "");
    const finished = completed && !running && (!fetched || rawStatus !== undefined);
    const status = !finished
      ? undefined
      : input.interrupted || ["aborted", "stopped"].includes(rawStatus ?? "")
        ? "stopped"
        : input.failed || rawStatus === "error" || string(details, "error") !== undefined
          ? "failed"
          : "completed";
    return update(
      task,
      finished && fetched && output.includes("\n\n")
        ? output.slice(output.indexOf("\n\n") + 2)
        : (string(details, "activity") ?? output),
      status,
      first,
    );
  };

  const notification = (message: unknown, immediate = false): PiTaskEvent[] => {
    const first = field(message, "details");
    const others = field(first, "others");
    return [first, ...(Array.isArray(others) ? others : [])].flatMap((details) => {
      const agentId = string(details, "id");
      if (!agentId) return [];
      const pendingEchoes = echoes.get(agentId);
      const echo = immediate ? undefined : pendingEchoes?.shift();
      if (pendingEchoes?.length === 0) echoes.delete(agentId);
      const task = echo ?? agents.get(agentId);
      if (!task || (task.terminal && !echo)) return [];
      const sessionFile = string(details, "sessionFile");
      if (echo && !sessionFile) return [];
      task.sessionFile = sessionFile ?? task.sessionFile;
      if (immediate) echoes.set(agentId, [...(echoes.get(agentId) ?? []), task]);
      const rawStatus = string(details, "status");
      const status = ["aborted", "stopped"].includes(rawStatus ?? "")
        ? "stopped"
        : rawStatus === "error" || string(details, "error") !== undefined
          ? "failed"
          : "completed";
      return update(
        task,
        string(details, "error") ||
          string(details, "resultPreview") ||
          piContentText(field(message, "content")),
        status,
      );
    });
  };

  const stop = (): PiTaskEvent[] => {
    echoes.clear();
    return [...tasks.values()].flatMap((task) =>
      task.terminal ? [] : update(task, "Parent Pi session stopped.", "stopped"),
    );
  };
  return {
    tool,
    notification,
    stop,
    hasBackgroundWork: () => [...tasks.values()].some((task) => task.background && !task.terminal),
  };
}
