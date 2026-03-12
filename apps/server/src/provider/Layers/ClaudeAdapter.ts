import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";

import {
  type CanonicalRequestType,
  type CanonicalItemType,
  type ChatAttachment,
  EventId,
  ProviderItemId,
  type ProviderApprovalDecision,
  type ProviderUserInputAnswers,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { resolveClaudeModelOptions } from "@t3tools/shared/model";
import { Effect, FileSystem, Layer, Queue, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { ClaudeAdapter, type ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";

const PROVIDER = "claude" as const;
type ClaudePermissionMode = "default" | "bypassPermissions" | "plan";

export interface ClaudeAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

interface ClaudeToolState {
  readonly itemId: ProviderItemId;
  readonly itemType: CanonicalItemType;
  readonly title: string;
}

interface ClaudeTurnState {
  readonly turnId: TurnId;
  readonly child: ReturnType<typeof spawn>;
  readonly toolStates: Map<string, ClaudeToolState>;
  proposedPlanMarkdown: string;
  assistantItemId?: ProviderItemId;
  completed: boolean;
  interrupted: boolean;
  finalizePromise: Promise<unknown> | null;
}

interface ClaudePendingApprovalState {
  readonly requestId: RuntimeRequestId;
  readonly turnId: TurnId;
  readonly requestType: CanonicalRequestType;
  readonly toolName: string;
  readonly detail?: string;
  readonly denial: unknown;
  readonly replayInput: ProviderSendTurnInput;
}

interface ClaudePendingUserInputState {
  readonly requestId: RuntimeRequestId;
  readonly turnId: TurnId;
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly toolName: string;
  readonly raw: unknown;
  readonly continuationInput: ProviderSendTurnInput;
}

interface ClaudeSessionState {
  session: ProviderSession;
  readonly binaryPath: string;
  hasConversation: boolean;
  approvalBypassEnabled: boolean;
  currentTurn: ClaudeTurnState | null;
  readonly pendingApprovals: Map<string, ClaudePendingApprovalState>;
  readonly pendingUserInputs: Map<string, ClaudePendingUserInputState>;
}

interface ClaudeThreadTurnSnapshotState {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

interface ClaudeThreadSnapshotState {
  readonly threadId: ThreadId;
  turns: Array<ClaudeThreadTurnSnapshotState>;
}

interface ClaudeResolvedImageAttachment {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly path: string;
}

interface ParsedClaudeSlashCommandInput {
  readonly rawInput: string;
  readonly commandName: string;
  readonly argumentsText: string;
}

interface ClaudeCommandDefinition {
  readonly aliases: ReadonlyArray<string>;
  readonly body: string;
  readonly model?: string;
  readonly allowedTools: ReadonlyArray<string>;
}

type ClaudeResolvedSlashCommand =
  | {
      readonly kind: "cli-subcommand";
      readonly rawInput: string;
      readonly commandName: string;
      readonly args: ReadonlyArray<string>;
    }
  | {
      readonly kind: "custom-prompt";
      readonly rawInput: string;
      readonly commandName: string;
      readonly promptText: string;
      readonly model?: string;
      readonly allowedTools: ReadonlyArray<string>;
    };

function resetClaudeSessionRuntimeState(state: ClaudeSessionState): void {
  state.hasConversation = false;
  state.approvalBypassEnabled = false;
  state.pendingApprovals.clear();
  state.pendingUserInputs.clear();
}

function interruptClaudeTurn(turnState: ClaudeTurnState): void {
  turnState.interrupted = true;
  turnState.child.kill("SIGTERM");
}

function cloneThreadSnapshot(state: ClaudeThreadSnapshotState): ProviderThreadSnapshot {
  return {
    threadId: state.threadId,
    turns: state.turns.map((turn) => ({
      id: turn.id,
      items: [...turn.items],
    })),
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function randomEventId(): ReturnType<typeof EventId.makeUnsafe> {
  return EventId.makeUnsafe(crypto.randomUUID());
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function coerceDetail(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (Array.isArray(value)) {
    const joined = value
      .map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)))
      .join("\n")
      .trim();
    return joined.length > 0 ? joined : undefined;
  }

  if (value !== undefined) {
    try {
      const serialized = JSON.stringify(value);
      return serialized.length > 2 ? serialized : undefined;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function toValidationError(operation: string, issue: string, cause?: unknown) {
  return new ProviderAdapterValidationError({
    provider: PROVIDER,
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function toRequestError(method: string, detail: string, cause?: unknown) {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function toProcessError(threadId: ThreadId, detail: string, cause?: unknown) {
  return new ProviderAdapterProcessError({
    provider: PROVIDER,
    threadId,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function normalizeClaudeCommandAlias(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/:+/g, ":")
    .replace(/\.md$/i, "")
    .toLowerCase();
}

function parseClaudeSlashCommandInput(input: string | undefined): ParsedClaudeSlashCommandInput | null {
  const trimmed = input?.trim();
  if (!trimmed?.startsWith("/")) {
    return null;
  }

  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) {
    return null;
  }

  return {
    rawInput: trimmed,
    commandName: normalizeClaudeCommandAlias(match[1] ?? ""),
    argumentsText: (match[2] ?? "").trim(),
  };
}

function splitClaudeCommandArgs(value: string): Array<string> {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const char of value) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += "\\";
  }
  if (current.length > 0) {
    args.push(current);
  }
  return args;
}

function stripClaudeFrontmatterValue(value: string): string {
  const trimmed = value.trim();
  const quoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"));
  return quoted ? trimmed.slice(1, -1).trim() : trimmed;
}

function parseClaudeCommandDefinition(content: string, relativePath: string): ClaudeCommandDefinition {
  let body = content;
  const metadata = new Map<string, string | Array<string>>();

  const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (frontmatterMatch) {
    body = content.slice(frontmatterMatch[0].length);
    let currentListKey: string | null = null;
    for (const line of (frontmatterMatch[1] ?? "").split(/\r?\n/)) {
      const keyMatch = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
      if (keyMatch) {
        const key = keyMatch[1]?.toLowerCase() ?? "";
        const rawValue = keyMatch[2] ?? "";
        if (rawValue.length === 0) {
          currentListKey = key;
          metadata.set(key, []);
          continue;
        }
        currentListKey = null;
        if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
          metadata.set(
            key,
            rawValue
              .slice(1, -1)
              .split(",")
              .map((entry) => stripClaudeFrontmatterValue(entry))
              .filter((entry) => entry.length > 0),
          );
          continue;
        }
        metadata.set(key, stripClaudeFrontmatterValue(rawValue));
        continue;
      }

      const listMatch = currentListKey ? /^\s*-\s*(.+)$/.exec(line) : null;
      if (!listMatch || !currentListKey) {
        currentListKey = null;
        continue;
      }

      const existing = metadata.get(currentListKey);
      const nextValues = Array.isArray(existing) ? existing : [];
      nextValues.push(stripClaudeFrontmatterValue(listMatch[1] ?? ""));
      metadata.set(currentListKey, nextValues);
    }
  }

  const normalizedRelativePath = relativePath.replace(/\\/g, "/").replace(/\.md$/i, "");
  const aliases = new Set<string>([
    normalizeClaudeCommandAlias(normalizedRelativePath),
    normalizeClaudeCommandAlias(normalizedRelativePath.replace(/\//g, ":")),
  ]);
  const explicitName = metadata.get("name");
  if (typeof explicitName === "string" && explicitName.trim().length > 0) {
    aliases.add(normalizeClaudeCommandAlias(explicitName));
  }

  const allowedToolsRaw = metadata.get("allowed-tools") ?? metadata.get("allowed_tools");
  const allowedTools = Array.isArray(allowedToolsRaw)
    ? allowedToolsRaw.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : typeof allowedToolsRaw === "string" && allowedToolsRaw.length > 0
      ? splitClaudeCommandArgs(allowedToolsRaw)
      : [];
  const model = metadata.get("model");

  return {
    aliases: [...aliases].filter((alias) => alias.length > 0),
    body,
    ...(typeof model === "string" && model.length > 0 ? { model } : {}),
    allowedTools,
  };
}

function applyClaudeCommandArguments(template: string, argumentsText: string): string {
  const normalizedArguments = argumentsText.trim();
  if (template.includes("$ARGUMENTS")) {
    return template.replaceAll("$ARGUMENTS", normalizedArguments);
  }
  if (normalizedArguments.length === 0) {
    return template;
  }
  return `${template.trimEnd()}\n\n${normalizedArguments}`;
}

async function collectClaudeCommandDefinitions(rootDir: string): Promise<Array<ClaudeCommandDefinition>> {
  const results: ClaudeCommandDefinition[] = [];

  const walk = async (currentDir: string) => {
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
        continue;
      }

      const relativePath = path.relative(rootDir, entryPath);
      const content = await readFile(entryPath, "utf8");
      results.push(parseClaudeCommandDefinition(content, relativePath));
    }
  };

  await walk(rootDir);
  return results;
}

async function resolveClaudeSlashCommand(input: {
  readonly cwd: string;
  readonly input: string | undefined;
}): Promise<ClaudeResolvedSlashCommand | null> {
  const parsed = parseClaudeSlashCommandInput(input.input);
  if (!parsed) {
    return null;
  }

  if (parsed.commandName === "mcp" || parsed.commandName === "agents") {
    return {
      kind: "cli-subcommand",
      rawInput: parsed.rawInput,
      commandName: parsed.commandName,
      args: [parsed.commandName, ...splitClaudeCommandArgs(parsed.argumentsText)],
    };
  }

  const homeCommandsDir = path.join(os.homedir(), ".claude", "commands");
  const projectCommandsDir = path.join(input.cwd, ".claude", "commands");

  for (const commandsDir of [projectCommandsDir, homeCommandsDir]) {
    const definitions = await collectClaudeCommandDefinitions(commandsDir);
    const definition = definitions.find((entry) => entry.aliases.includes(parsed.commandName));
    if (!definition) {
      continue;
    }

    return {
      kind: "custom-prompt",
      rawInput: parsed.rawInput,
      commandName: parsed.commandName,
      promptText: applyClaudeCommandArguments(definition.body, parsed.argumentsText),
      ...(definition.model ? { model: definition.model } : {}),
      allowedTools: definition.allowedTools,
    };
  }

  return null;
}

function buildSession(input: {
  readonly threadId: ThreadId;
  readonly cwd?: string;
  readonly model?: string;
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly sessionId: string;
}): ProviderSession {
  const createdAt = nowIso();
  return {
    provider: PROVIDER,
    status: "ready",
    runtimeMode: input.runtimeMode,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.model ? { model: input.model } : {}),
    threadId: input.threadId,
    resumeCursor: input.sessionId,
    createdAt,
    updatedAt: createdAt,
  };
}

function permissionModeFor(input: {
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly interactionMode: ProviderSendTurnInput["interactionMode"];
}): ClaudePermissionMode {
  if (input.interactionMode === "plan") {
    return "plan";
  }
  return input.runtimeMode === "approval-required" ? "default" : "bypassPermissions";
}

function resolveClaudePermissionMode(input: {
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly interactionMode: ProviderSendTurnInput["interactionMode"];
  readonly approvalBypassEnabled: boolean;
  readonly override?: ClaudePermissionMode;
}): ClaudePermissionMode {
  if (input.override) {
    return input.override;
  }
  if (input.interactionMode === "plan") {
    return "plan";
  }
  if (input.approvalBypassEnabled) {
    return "bypassPermissions";
  }
  return permissionModeFor(input);
}

const CLAUDE_REASONING_ENV_KEYS = [
  "CLAUDE_CODE_EFFORT_LEVEL",
  "MAX_THINKING_TOKENS",
  "CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING",
] as const;

function environmentForClaudeTurn(input: {
  readonly model: string | undefined;
  readonly modelOptions: ProviderSendTurnInput["modelOptions"];
}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of CLAUDE_REASONING_ENV_KEYS) {
    delete env[key];
  }
  const options = resolveClaudeModelOptions(input.model, input.modelOptions?.claude);
  if (options?.thinking === false) {
    env.MAX_THINKING_TOKENS = "0";
  }
  if (options?.effort) {
    env.CLAUDE_CODE_EFFORT_LEVEL = options.effort;
  }
  return env;
}

function toolItemType(name: string): CanonicalItemType {
  const normalized = name.trim().toLowerCase();
  if (normalized === "bash") return "command_execution";
  if (normalized === "edit" || normalized === "write" || normalized === "notebookedit")
    return "file_change";
  if (normalized === "websearch" || normalized === "webfetch") return "web_search";
  if (normalized.startsWith("mcp__")) return "mcp_tool_call";
  return "dynamic_tool_call";
}

function toolTitle(name: string): string {
  switch (toolItemType(name)) {
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "web_search":
      return "Web search";
    case "mcp_tool_call":
      return "MCP tool call";
    default:
      return name.trim() || "Tool call";
  }
}

function isClaudeUserInputTool(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    normalized === "askuserquestion" ||
    normalized === "ask_user_question" ||
    normalized === "ask-user-question"
  );
}

function toolDetail(name: string, input: unknown): string | undefined {
  const record = asRecord(input);
  const detail =
    asString(record?.command) ??
    asString(record?.description) ??
    asString(record?.file_path) ??
    asString(record?.path) ??
    asString(record?.query);

  return detail ?? coerceDetail(input);
}

function toUserInputQuestionOptions(
  value: unknown,
): Array<{ label: string; description: string }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (typeof entry === "string") {
      const label = entry.trim();
      return label ? [{ label, description: label }] : [];
    }

    const record = asRecord(entry);
    const label =
      asString(record?.label) ??
      asString(record?.value) ??
      asString(record?.name) ??
      asString(record?.id);
    if (!label) {
      return [];
    }
    const description =
      asString(record?.description) ?? asString(record?.detail) ?? asString(record?.summary) ?? label;
    return [{ label, description }];
  });
}

function toClaudeUserInputQuestion(
  value: unknown,
  fallbackId: string,
  fallbackHeader: string,
): UserInputQuestion | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const question =
    asString(record.question) ??
    asString(record.prompt) ??
    asString(record.text) ??
    asString(record.message) ??
    asString(record.description);
  if (!question) {
    return null;
  }

  const id = asString(record.id) ?? asString(record.question_id) ?? fallbackId;
  const header = asString(record.header) ?? asString(record.title) ?? asString(record.label) ?? fallbackHeader;
  const options = toUserInputQuestionOptions(
    record.options ?? record.choices ?? record.answers ?? record.allowed_answers,
  );

  return {
    id,
    header,
    question,
    options,
  };
}

function toClaudeUserInputQuestions(toolName: string, input: unknown): Array<UserInputQuestion> | null {
  const record = asRecord(input);
  if (!record) {
    return null;
  }

  const structuredQuestions = Array.isArray(record.questions)
    ? record.questions
        .map((question, index) =>
          toClaudeUserInputQuestion(question, `question_${index + 1}`, `Question ${index + 1}`),
        )
        .filter((question): question is UserInputQuestion => question !== null)
    : [];
  if (structuredQuestions.length > 0) {
    return structuredQuestions;
  }

  const singleQuestion = toClaudeUserInputQuestion(
    record,
    "answer",
    toolName.trim() || "Question",
  );
  if (singleQuestion) {
    return [singleQuestion];
  }

  const fallbackQuestion = toolDetail(toolName, input);
  if (!fallbackQuestion) {
    return null;
  }
  return [
    {
      id: "answer",
      header: toolName.trim() || "Question",
      question: fallbackQuestion,
      options: [],
    },
  ];
}

function formatClaudeUserInputAnswer(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : "(empty)";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildClaudeUserInputContinuationPrompt(input: {
  readonly requestId: RuntimeRequestId;
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly answers: ProviderUserInputAnswers;
}): string {
  const lines = [
    "Continue the previous Claude Code workflow using these user answers from T3 Code.",
    `<t3-user-input-response request-id="${input.requestId}">`,
  ];

  for (const question of input.questions) {
    lines.push(`question_id: ${question.id}`);
    lines.push(`question: ${question.question}`);
    lines.push(`answer: ${formatClaudeUserInputAnswer(input.answers[question.id])}`);
    lines.push("");
  }

  lines.push("</t3-user-input-response>");
  return lines.join("\n");
}

function parseRuntimePlanFromMarkdown(markdown: string): {
  readonly explanation?: string;
  readonly plan: Array<{ step: string; status: "pending" | "inProgress" | "completed" }>;
} | null {
  const trimmed = markdown.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const lines = trimmed.split(/\r?\n/);
  const steps: Array<{ step: string; status: "pending" | "inProgress" | "completed" }> = [];
  const explanationLines: string[] = [];
  let sawStep = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) {
      if (!sawStep && explanationLines.length > 0) {
        explanationLines.push("");
      }
      continue;
    }

    const checklistMatch = line.match(/^[-*+]\s+\[( |x|X|-|~)\]\s+(.+)$/);
    if (checklistMatch) {
      sawStep = true;
      const marker = checklistMatch[1];
      const step = checklistMatch[2]?.trim();
      if (!step) {
        continue;
      }
      steps.push({
        step,
        status:
          marker === "x" || marker === "X"
            ? "completed"
            : marker === "-" || marker === "~"
              ? "inProgress"
              : "pending",
      });
      continue;
    }

    const bulletMatch = line.match(/^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
    if (bulletMatch) {
      sawStep = true;
      const step = bulletMatch[1]?.trim();
      if (!step) {
        continue;
      }
      steps.push({
        step,
        status: "pending",
      });
      continue;
    }

    if (!sawStep && !line.startsWith("#")) {
      explanationLines.push(line);
    }
  }

  if (steps.length === 0) {
    return null;
  }

  const explanation = explanationLines.join("\n").trim();
  return {
    ...(explanation ? { explanation } : {}),
    plan: steps,
  };
}

function requestTypeForClaudeTool(name: string): CanonicalRequestType {
  const normalized = name.trim().toLowerCase();
  if (normalized === "bash") {
    return "command_execution_approval";
  }
  if (
    normalized === "edit" ||
    normalized === "write" ||
    normalized === "multiedit" ||
    normalized === "notebookedit"
  ) {
    return "file_change_approval";
  }
  if (
    normalized === "read" ||
    normalized === "glob" ||
    normalized === "grep" ||
    normalized === "ls"
  ) {
    return "file_read_approval";
  }
  return "unknown";
}

function buildRaw(record: unknown, method: string): ProviderRuntimeEvent["raw"] {
  return {
    source: "claude.cli",
    method,
    payload: record,
  };
}

function buildBaseEvent(input: {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId;
  readonly itemId?: ProviderItemId;
  readonly requestId?: RuntimeRequestId;
  readonly raw?: ProviderRuntimeEvent["raw"];
}) {
  return {
    eventId: randomEventId(),
    provider: PROVIDER,
    threadId: input.threadId,
    createdAt: nowIso(),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: RuntimeItemId.makeUnsafe(input.itemId) } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.raw ? { raw: input.raw } : {}),
  } satisfies Omit<ProviderRuntimeEvent, "type" | "payload">;
}

function cloneSendTurnInput(input: ProviderSendTurnInput): ProviderSendTurnInput {
  return {
    ...input,
    attachments: structuredClone(input.attachments ?? []),
    ...(input.modelOptions ? { modelOptions: structuredClone(input.modelOptions) } : {}),
  };
}

function buildClaudeImagePrompt(input: {
  readonly attachments: ReadonlyArray<ClaudeResolvedImageAttachment>;
  readonly inputText: string | undefined;
}): string {
  return [
    "Attached image files are available at these local paths:",
    ...input.attachments.map((attachment) => `- ${attachment.path}`),
    "",
    input.inputText?.trim().length
      ? input.inputText
      : "Please analyze the attached image files.",
  ].join("\n");
}

function writeClaudePromptToStdin(input: {
  readonly threadId: ThreadId;
  readonly child: ReturnType<typeof spawn>;
  readonly promptText: string | undefined;
}) {
  return Effect.try({
    try: () => {
      input.child.stdin?.end(input.promptText ?? "");
    },
    catch: (cause) =>
      toProcessError(
        input.threadId,
        "Failed to write Claude Code prompt to stdin.",
        cause,
      ),
  });
}

export function makeClaudeAdapterLive(options?: ClaudeAdapterLiveOptions) {
  return Layer.effect(
    ClaudeAdapter,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const serverConfig = yield* Effect.service(ServerConfig);
      const nativeEventLogger =
        options?.nativeEventLogger ??
        (options?.nativeEventLogPath !== undefined
          ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
              stream: "native",
            })
          : undefined);

      const runtimeServices = yield* Effect.services<never>();
      const runPromise = Effect.runPromiseWith(runtimeServices);
      const sessions = new Map<ThreadId, ClaudeSessionState>();
      const threadSnapshots = new Map<ThreadId, ClaudeThreadSnapshotState>();
      const eventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

      const publish = (event: ProviderRuntimeEvent) =>
        Effect.gen(function* () {
          if (nativeEventLogger) {
            yield* nativeEventLogger.write(event.raw ?? event, event.threadId);
          }
          yield* Queue.offer(eventQueue, event).pipe(Effect.asVoid);
        });

      const runBackgroundEffect = <TSuccess>(effect: Effect.Effect<TSuccess>) => runPromise(effect);

      const publishFork = (event: ProviderRuntimeEvent) => {
        runBackgroundEffect(publish(event));
      };

      const getSessionState = (threadId: ThreadId) => {
        const state = sessions.get(threadId);
        if (!state) {
          return Effect.fail(
            new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId,
            }),
          );
        }
        return Effect.succeed(state);
      };

      const ensureThreadSnapshot = (threadId: ThreadId): ClaudeThreadSnapshotState => {
        const existing = threadSnapshots.get(threadId);
        if (existing) {
          return existing;
        }
        const created: ClaudeThreadSnapshotState = {
          threadId,
          turns: [],
        };
        threadSnapshots.set(threadId, created);
        return created;
      };

      const createTurnSnapshot = (threadId: ThreadId, turnId: TurnId) => {
        const snapshot = ensureThreadSnapshot(threadId);
        const existing = snapshot.turns.find((turn) => turn.id === turnId);
        if (existing) {
          return existing;
        }
        const created: ClaudeThreadTurnSnapshotState = {
          id: turnId,
          items: [],
        };
        snapshot.turns.push(created);
        return created;
      };

      const COALESCABLE_DELTA_KINDS = new Set(["content.delta", "turn.proposed.delta"]);

      const appendTurnSnapshotItem = (threadId: ThreadId, turnId: TurnId, item: unknown) => {
        const items = createTurnSnapshot(threadId, turnId).items;
        const record = asRecord(item);
        const kind = record ? asString(record.kind) : undefined;
        if (kind && COALESCABLE_DELTA_KINDS.has(kind) && items.length > 0) {
          const last = asRecord(items[items.length - 1]);
          if (last && asString(last.kind) === kind) {
            const nextDelta = record ? (asString(record.delta) ?? "") : "";
            last.delta = (asString(last.delta) ?? "") + nextDelta;
            return;
          }
        }
        items.push(item);
      };

      const publishResolvedApproval = (input: {
        readonly threadId: ThreadId;
        readonly turnId: TurnId;
        readonly requestId: RuntimeRequestId;
        readonly requestType: CanonicalRequestType;
        readonly decision: ProviderApprovalDecision;
        readonly resolution: unknown;
        readonly raw: unknown;
        readonly method: string;
      }) =>
        Effect.gen(function* () {
          appendTurnSnapshotItem(input.threadId, input.turnId, {
            kind: "approval.resolved",
            requestId: input.requestId,
            requestType: input.requestType,
            decision: input.decision,
            resolution: input.resolution,
          });

          yield* publish({
            ...buildBaseEvent({
              threadId: input.threadId,
              turnId: input.turnId,
              requestId: input.requestId,
              raw: buildRaw(input.raw, input.method),
            }),
            type: "request.resolved",
            payload: {
              requestType: input.requestType,
              decision: input.decision,
              resolution: input.resolution,
            },
          });
        });

      const resolveClaudeImageAttachments = (
        threadId: ThreadId,
        attachments: ReadonlyArray<ChatAttachment>,
      ) =>
        Effect.forEach(
          attachments,
          (attachment) =>
            Effect.gen(function* () {
              const attachmentPath = resolveAttachmentPath({
                stateDir: serverConfig.stateDir,
                attachment,
              });
              if (!attachmentPath) {
                return yield* toRequestError(
                  "claude.sendTurn",
                  `Invalid attachment id '${attachment.id}'.`,
                );
              }
              const exists = yield* fileSystem.exists(attachmentPath).pipe(
                Effect.mapError((cause) =>
                  toRequestError(
                    "claude.sendTurn",
                    `Failed to resolve attachment '${attachment.name}'.`,
                    cause,
                  ),
                ),
              );
              if (!exists) {
                return yield* toRequestError(
                  "claude.sendTurn",
                  `Attachment '${attachment.name}' is unavailable on disk.`,
                );
              }
              return {
                id: attachment.id,
                name: attachment.name,
                mimeType: attachment.mimeType,
                path: attachmentPath,
              } satisfies ClaudeResolvedImageAttachment;
            }),
          { concurrency: 1 },
        );

      const emitSessionReady = (state: ClaudeSessionState) =>
        Effect.all([
          publish({
            ...buildBaseEvent({
              threadId: state.session.threadId,
              raw: buildRaw(
                { sessionId: state.session.resumeCursor, model: state.session.model },
                "session/started",
              ),
            }),
            type: "session.started",
            payload: {
              message: "Claude Code session ready",
              resume: state.session.resumeCursor,
            },
          }),
          publish({
            ...buildBaseEvent({
              threadId: state.session.threadId,
              raw: buildRaw({ state: "ready" }, "session/state"),
            }),
            type: "session.state.changed",
            payload: {
              state: "ready",
              reason: "Claude Code session ready",
            },
          }),
        ]).pipe(Effect.asVoid);

      const finalizeTurn = (input: {
        readonly threadId: ThreadId;
        readonly turnId: TurnId;
        readonly state: "completed" | "failed" | "interrupted";
        readonly stopReason?: string | null;
        readonly usage?: unknown;
        readonly modelUsage?: Record<string, unknown>;
        readonly totalCostUsd?: number;
        readonly errorMessage?: string;
      }) =>
        Effect.gen(function* () {
          const state = yield* getSessionState(input.threadId);
          const isCurrentTurn = state.currentTurn?.turnId === input.turnId;
          if (isCurrentTurn) {
            state.currentTurn = null;
            const { lastError: _lastError, activeTurnId: _activeTurnId, ...sessionBase } =
              state.session;
            state.session = {
              ...sessionBase,
              status: input.state === "failed" ? "error" : "ready",
              updatedAt: nowIso(),
              ...(input.errorMessage ? { lastError: input.errorMessage } : {}),
            };
            sessions.set(input.threadId, state);
          }

          appendTurnSnapshotItem(input.threadId, input.turnId, {
            kind: "turn.completed",
            state: input.state,
            ...(input.stopReason !== undefined ? { stopReason: input.stopReason } : {}),
            ...(input.usage !== undefined ? { usage: input.usage } : {}),
            ...(input.modelUsage !== undefined ? { modelUsage: input.modelUsage } : {}),
            ...(input.totalCostUsd !== undefined ? { totalCostUsd: input.totalCostUsd } : {}),
            ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
          });

          yield* publish({
            ...buildBaseEvent({
              threadId: input.threadId,
              turnId: input.turnId,
              raw: buildRaw(
                {
                  state: input.state,
                  stopReason: input.stopReason,
                  usage: input.usage,
                  modelUsage: input.modelUsage,
                  totalCostUsd: input.totalCostUsd,
                  errorMessage: input.errorMessage,
                },
                "turn/completed",
              ),
            }),
            type: "turn.completed",
            payload: {
              state: input.state,
              ...(input.stopReason !== undefined ? { stopReason: input.stopReason } : {}),
              ...(input.usage !== undefined ? { usage: input.usage } : {}),
              ...(input.modelUsage !== undefined ? { modelUsage: input.modelUsage } : {}),
              ...(input.totalCostUsd !== undefined ? { totalCostUsd: input.totalCostUsd } : {}),
              ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
            },
          });

          if (isCurrentTurn) {
            yield* publish({
              ...buildBaseEvent({
                threadId: input.threadId,
                raw: buildRaw({ state: state.session.status }, "session/state"),
              }),
              type: "session.state.changed",
              payload: {
                state: input.state === "failed" ? "error" : "ready",
                ...(input.errorMessage ? { reason: input.errorMessage } : {}),
              },
            });
          }
        });

      const startSession: ClaudeAdapterShape["startSession"] = (input) =>
        Effect.gen(function* () {
          if (input.provider && input.provider !== PROVIDER) {
            return yield* toValidationError(
              "ClaudeAdapter.startSession",
              `Expected provider '${PROVIDER}', received '${input.provider}'.`,
            );
          }

          const resumeCursor =
            typeof input.resumeCursor === "string" && input.resumeCursor.trim().length > 0
              ? input.resumeCursor.trim()
              : crypto.randomUUID();

          const binaryPath =
            input.providerOptions?.claude?.binaryPath?.trim() || "claude";
          const session = buildSession({
            threadId: input.threadId,
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(input.model ? { model: input.model } : {}),
            runtimeMode: input.runtimeMode,
            sessionId: resumeCursor,
          });

          const existing = sessions.get(input.threadId);
          if (existing?.currentTurn) {
            existing.currentTurn.interrupted = true;
            existing.currentTurn.child.kill("SIGTERM");
          }

          const nextState: ClaudeSessionState = {
            session,
            binaryPath,
            hasConversation: input.resumeCursor !== undefined,
            approvalBypassEnabled: false,
            currentTurn: null,
            pendingApprovals: new Map(),
            pendingUserInputs: new Map(),
          };
          sessions.set(input.threadId, nextState);
          ensureThreadSnapshot(input.threadId);
          yield* emitSessionReady(nextState);
          return session;
        });

      const handleClaudeCliSubcommand = (input: {
        readonly threadId: ThreadId;
        readonly state: ClaudeSessionState;
        readonly slashCommand: Extract<ClaudeResolvedSlashCommand, { kind: "cli-subcommand" }>;
      }) =>
        Effect.gen(function* () {
          const turnId = TurnId.makeUnsafe(crypto.randomUUID());
          const sessionId = String(input.state.session.resumeCursor ?? crypto.randomUUID());

          yield* publish({
            ...buildBaseEvent({
              threadId: input.threadId,
              turnId,
              raw: buildRaw({ command: input.slashCommand.rawInput }, "turn/started"),
            }),
            type: "turn.started",
            payload: {},
          });

          appendTurnSnapshotItem(input.threadId, turnId, {
            kind: "turn.started",
            input: input.slashCommand.rawInput,
          });

          const result = yield* Effect.promise(
            () =>
              new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve) => {
                const child = spawn(input.state.binaryPath, input.slashCommand.args, {
                  cwd: input.state.session.cwd ?? process.cwd(),
                  shell: process.platform === "win32",
                  stdio: ["pipe", "pipe", "pipe"],
                });

                let stdout = "";
                let stderr = "";

                child.stdout?.on("data", (chunk: Buffer) => {
                  stdout += chunk.toString("utf8");
                });
                child.stderr?.on("data", (chunk: Buffer) => {
                  stderr += chunk.toString("utf8");
                });
                child.on("close", (exitCode) => {
                  resolve({ stdout, stderr, exitCode });
                });
                child.on("error", (err) => {
                  resolve({ stdout, stderr: stderr || String(err), exitCode: 1 });
                });
                child.stdin?.end();
              }),
          );

          const outputText =
            result.exitCode === 0
              ? result.stdout.trim() || "(no output)"
              : `Error (exit ${result.exitCode}):\n${(result.stderr || result.stdout).trim()}`;

          const assistantItemId = ProviderItemId.makeUnsafe(crypto.randomUUID());

          appendTurnSnapshotItem(input.threadId, turnId, {
            kind: "assistant.text",
            itemId: assistantItemId,
            text: outputText,
          });

          yield* publish({
            ...buildBaseEvent({
              threadId: input.threadId,
              turnId,
              itemId: assistantItemId,
              raw: buildRaw({ text: outputText }, "assistant/text"),
            }),
            type: "item.completed",
            payload: {
              itemType: "assistant_message" as const,
              status: "completed" as const,
              title: `/${input.slashCommand.commandName}`,
              detail: outputText,
            },
          });

          yield* finalizeTurn({
            threadId: input.threadId,
            turnId,
            state: result.exitCode === 0 ? "completed" : "failed",
            stopReason: "end_turn",
            ...(result.exitCode !== 0 ? { errorMessage: outputText } : {}),
          });

          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: sessionId,
          };
        });

      const startClaudeTurn = (
        input: ProviderSendTurnInput,
        options?: {
          readonly permissionModeOverride?: ClaudePermissionMode;
        },
      ) =>
        Effect.gen(function* () {
          const state = yield* getSessionState(input.threadId);
          if (state.currentTurn) {
            return yield* toRequestError(
              "claude.sendTurn",
              `A Claude turn is already running for thread '${input.threadId}'.`,
            );
          }
          const resolvedAttachments = yield* resolveClaudeImageAttachments(
            input.threadId,
            input.attachments ?? [],
          );
          let promptText =
            resolvedAttachments.length > 0
              ? buildClaudeImagePrompt({
                  attachments: resolvedAttachments,
                  inputText: input.input,
                })
              : input.input;

          // Resolve slash commands before sending to CLI
          const slashCommand = yield* Effect.promise(() =>
            resolveClaudeSlashCommand({
              cwd: state.session.cwd ?? process.cwd(),
              input: promptText,
            }),
          );

          // CLI management subcommands (e.g. /mcp, /agents) run a separate process
          if (slashCommand?.kind === "cli-subcommand") {
            return yield* handleClaudeCliSubcommand({
              threadId: input.threadId,
              state,
              slashCommand,
            });
          }

          // Custom prompt commands expand the template
          if (slashCommand?.kind === "custom-prompt") {
            promptText = slashCommand.promptText;
          }

          const turnId = TurnId.makeUnsafe(crypto.randomUUID());
          const sessionId = String(state.session.resumeCursor ?? crypto.randomUUID());
          const model = (slashCommand?.kind === "custom-prompt" ? slashCommand.model : undefined) ??
            input.model ?? state.session.model;
          const env = environmentForClaudeTurn({
            model,
            modelOptions: input.modelOptions,
          });
          const args = [
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--permission-mode",
            resolveClaudePermissionMode({
              runtimeMode: state.session.runtimeMode,
              interactionMode: input.interactionMode,
              approvalBypassEnabled: state.approvalBypassEnabled,
              ...(options?.permissionModeOverride
                ? { override: options.permissionModeOverride }
                : {}),
            }),
          ];

          if (model) {
            args.push("--model", model);
          }

          if (state.hasConversation) {
            args.push("--resume", sessionId);
          } else {
            args.push("--session-id", sessionId);
          }

          const child = yield* Effect.try({
            try: () =>
              spawn(state.binaryPath, args, {
                cwd: state.session.cwd ?? process.cwd(),
                env,
                shell: process.platform === "win32",
                stdio: ["pipe", "pipe", "pipe"],
              }),
            catch: (cause) =>
              toProcessError(
                input.threadId,
                `Failed to spawn Claude Code CLI '${state.binaryPath}'.`,
                cause,
              ),
          });
          yield* writeClaudePromptToStdin({
            threadId: input.threadId,
            child,
            promptText,
          });

          const turnState: ClaudeTurnState = {
            turnId,
            child,
            toolStates: new Map(),
            proposedPlanMarkdown: "",
            completed: false,
            interrupted: false,
            finalizePromise: null,
          };
          state.currentTurn = turnState;
          // Claude should resume this session ID on any follow-up turn, even if the current turn is interrupted.
          state.hasConversation = true;
          state.session = {
            ...state.session,
            ...(model ? { model } : {}),
            status: "running",
            activeTurnId: turnId,
            updatedAt: nowIso(),
            resumeCursor: sessionId,
          };
          sessions.set(input.threadId, state);
          appendTurnSnapshotItem(input.threadId, turnId, {
            kind: "turn.started",
            ...(model ? { model } : {}),
            ...(promptText ? { input: promptText } : {}),
            ...(resolvedAttachments.length > 0
              ? {
                  attachments: resolvedAttachments.map((attachment) => ({
                    id: attachment.id,
                    name: attachment.name,
                    mimeType: attachment.mimeType,
                    path: attachment.path,
                  })),
                }
              : {}),
            interactionMode: input.interactionMode ?? null,
          });

          yield* publish({
            ...buildBaseEvent({
              threadId: input.threadId,
              turnId,
              raw: buildRaw({ model }, "turn/started"),
            }),
            type: "turn.started",
            payload: model ? { model } : {},
          });

          yield* publish({
            ...buildBaseEvent({
              threadId: input.threadId,
              raw: buildRaw({ state: "running" }, "session/state"),
            }),
            type: "session.state.changed",
            payload: {
              state: "running",
              reason: "Claude Code turn started",
            },
          });

          let stdoutBuffer = "";
          let stderrBuffer = "";

          const publishClaudePlanUpdate = (planMarkdown: string, rawRecord: unknown, method: string) => {
            const parsedPlan = parseRuntimePlanFromMarkdown(planMarkdown);
            if (!parsedPlan) {
              return;
            }
            appendTurnSnapshotItem(input.threadId, turnId, {
              kind: "turn.plan.updated",
              ...parsedPlan,
            });
            publishFork({
              ...buildBaseEvent({
                threadId: input.threadId,
                turnId,
                raw: buildRaw(rawRecord, method),
              }),
              type: "turn.plan.updated",
              payload: parsedPlan,
            });
          };

          const processClaudeRecord = (record: Record<string, unknown>) => {
            const type = asString(record.type);
            if (!type) {
              return;
            }

            if (type === "stream_event") {
              const event = asRecord(record.event);
              const eventType = asString(event?.type);
              if (eventType === "message_start") {
                const message = asRecord(event?.message);
                const messageId = asString(message?.id);
                if (messageId) {
                  turnState.assistantItemId = ProviderItemId.makeUnsafe(messageId);
                }
                return;
              }

              if (eventType === "content_block_delta") {
                const delta = asRecord(event?.delta);
                const deltaType = asString(delta?.type);
                if (deltaType === "text_delta" && turnState.assistantItemId) {
                  const textDelta = asString(delta?.text) ?? "";
                  if (input.interactionMode === "plan") {
                    turnState.proposedPlanMarkdown += textDelta;
                    appendTurnSnapshotItem(input.threadId, turnId, {
                      kind: "turn.proposed.delta",
                      delta: textDelta,
                    });
                    publishFork({
                      ...buildBaseEvent({
                        threadId: input.threadId,
                        turnId,
                        raw: buildRaw(record, "stream_event/content_block_delta/plan"),
                      }),
                      type: "turn.proposed.delta",
                      payload: {
                        delta: textDelta,
                      },
                    });
                    publishClaudePlanUpdate(
                      turnState.proposedPlanMarkdown,
                      record,
                      "stream_event/content_block_delta/plan_updated",
                    );
                    return;
                  }
                  appendTurnSnapshotItem(input.threadId, turnId, {
                    kind: "content.delta",
                    itemId: turnState.assistantItemId,
                    streamKind: "assistant_text",
                    delta: textDelta,
                  });
                  publishFork({
                    ...buildBaseEvent({
                      threadId: input.threadId,
                      turnId,
                      itemId: turnState.assistantItemId,
                      raw: buildRaw(record, "stream_event/content_block_delta"),
                    }),
                    type: "content.delta",
                    payload: {
                      streamKind: "assistant_text",
                      delta: textDelta,
                    },
                  });
                }
                return;
              }

              return;
            }

            if (type === "assistant") {
              const message = asRecord(record.message);
              const messageId = asString(message?.id);
              const content = Array.isArray(message?.content) ? message.content : [];
              for (const block of content) {
                const contentBlock = asRecord(block);
                const contentType = asString(contentBlock?.type);
                if (contentType === "thinking") {
                  const thinking = asString(contentBlock?.thinking);
                  if (thinking) {
                    appendTurnSnapshotItem(input.threadId, turnId, {
                      kind: "task.progress",
                      taskId: `claude-thinking:${turnId}`,
                      description: thinking,
                    });
                    publishFork({
                      ...buildBaseEvent({
                        threadId: input.threadId,
                        turnId,
                        raw: buildRaw(record, "assistant/thinking"),
                      }),
                      type: "task.progress",
                      payload: {
                        taskId: RuntimeTaskId.makeUnsafe(`claude-thinking:${turnId}`),
                        description: thinking,
                      },
                    });
                  }
                  continue;
                }

                if (contentType === "tool_use") {
                  const toolId = asString(contentBlock?.id);
                  const toolName = asString(contentBlock?.name) ?? "Tool";
                  if (!toolId || turnState.toolStates.has(toolId)) {
                    continue;
                  }
                  if (isClaudeUserInputTool(toolName)) {
                    const questions = toClaudeUserInputQuestions(toolName, contentBlock?.input);
                    if (!questions) {
                      continue;
                    }
                    const requestId = RuntimeRequestId.makeUnsafe(
                      `claude-user-input:${input.threadId}:${toolId}`,
                    );
                    state.pendingUserInputs.set(String(requestId), {
                      requestId,
                      turnId,
                      questions,
                      toolName,
                      raw: contentBlock,
                      continuationInput: {
                        threadId: input.threadId,
                        ...(model ? { model } : {}),
                        attachments: [],
                        ...(input.modelOptions ? { modelOptions: structuredClone(input.modelOptions) } : {}),
                        ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
                      },
                    });
                    appendTurnSnapshotItem(input.threadId, turnId, {
                      kind: "user-input.requested",
                      requestId,
                      questions,
                      toolName,
                      data: contentBlock,
                    });
                    publishFork({
                      ...buildBaseEvent({
                        threadId: input.threadId,
                        turnId,
                        requestId,
                        raw: buildRaw(record, `assistant/tool_use/${toolName}/user_input`),
                      }),
                      type: "user-input.requested",
                      payload: {
                        questions,
                      },
                    });
                    continue;
                  }
                  const itemId = ProviderItemId.makeUnsafe(toolId);
                  const nextToolState: ClaudeToolState = {
                    itemId,
                    itemType: toolItemType(toolName),
                    title: toolTitle(toolName),
                  };
                  turnState.toolStates.set(toolId, nextToolState);
                  const detail = toolDetail(toolName, contentBlock?.input);
                  appendTurnSnapshotItem(input.threadId, turnId, {
                    kind: "item.started",
                    itemId,
                    itemType: nextToolState.itemType,
                    title: nextToolState.title,
                    ...(detail ? { detail } : {}),
                    data: contentBlock,
                  });
                  publishFork({
                    ...buildBaseEvent({
                      threadId: input.threadId,
                      turnId,
                      itemId,
                      raw: buildRaw(record, `assistant/tool_use/${toolName}`),
                    }),
                    type: "item.started",
                    payload: {
                      itemType: nextToolState.itemType,
                      status: "inProgress",
                      title: nextToolState.title,
                      ...(detail ? { detail } : {}),
                      data: contentBlock,
                    },
                  });
                  continue;
                }

                if (contentType === "text") {
                  const text = asString(contentBlock?.text);
                  const itemId = messageId
                    ? ProviderItemId.makeUnsafe(messageId)
                    : turnState.assistantItemId;
                  if (input.interactionMode === "plan" && text) {
                    turnState.proposedPlanMarkdown = text;
                    appendTurnSnapshotItem(input.threadId, turnId, {
                      kind: "turn.proposed.completed",
                      planMarkdown: text,
                    });
                    publishFork({
                      ...buildBaseEvent({
                        threadId: input.threadId,
                        turnId,
                        raw: buildRaw(record, "assistant/plan"),
                      }),
                      type: "turn.proposed.completed",
                      payload: {
                        planMarkdown: text,
                      },
                    });
                    publishClaudePlanUpdate(text, record, "assistant/plan_updated");
                    continue;
                  }
                  if (text && itemId) {
                    appendTurnSnapshotItem(input.threadId, turnId, {
                      kind: "item.completed",
                      itemId,
                      itemType: "assistant_message",
                      status: "completed",
                      title: "Assistant message",
                      detail: text,
                      data: contentBlock,
                    });
                    publishFork({
                      ...buildBaseEvent({
                        threadId: input.threadId,
                        turnId,
                        itemId,
                        raw: buildRaw(record, "assistant/message"),
                      }),
                      type: "item.completed",
                      payload: {
                        itemType: "assistant_message",
                        status: "completed",
                        title: "Assistant message",
                        detail: text,
                        data: contentBlock,
                      },
                    });
                  }
                }
              }
              return;
            }

            if (type === "user") {
              const message = asRecord(record.message);
              const content = Array.isArray(message?.content) ? message.content : [];
              for (const block of content) {
                const contentBlock = asRecord(block);
                if (asString(contentBlock?.type) !== "tool_result") {
                  continue;
                }
                const toolUseId = asString(contentBlock?.tool_use_id);
                if (!toolUseId) {
                  continue;
                }
                const toolState = turnState.toolStates.get(toolUseId);
                const itemId = toolState?.itemId ?? ProviderItemId.makeUnsafe(toolUseId);
                appendTurnSnapshotItem(input.threadId, turnId, {
                  kind: "item.completed",
                  itemId,
                  itemType: toolState?.itemType ?? "dynamic_tool_call",
                  status: contentBlock?.is_error === true ? "failed" : "completed",
                  title: toolState?.title ?? "Tool call",
                  ...(coerceDetail(contentBlock?.content)
                    ? { detail: coerceDetail(contentBlock?.content) }
                    : {}),
                  data: contentBlock,
                });
                publishFork({
                  ...buildBaseEvent({
                    threadId: input.threadId,
                    turnId,
                    itemId,
                    raw: buildRaw(record, "user/tool_result"),
                  }),
                  type: "item.completed",
                  payload: {
                    itemType: toolState?.itemType ?? "dynamic_tool_call",
                    status: contentBlock?.is_error === true ? "failed" : "completed",
                    title: toolState?.title ?? "Tool call",
                    ...(coerceDetail(contentBlock?.content)
                      ? { detail: coerceDetail(contentBlock?.content) }
                      : {}),
                    data: contentBlock,
                  },
                });
                turnState.toolStates.delete(toolUseId);
              }
              return;
            }

            if (type === "result") {
              turnState.completed = true;
              state.hasConversation = true;
              const permissionDenials = Array.isArray(record.permission_denials)
                ? record.permission_denials
                : [];
              for (const denial of permissionDenials) {
                const denialRecord = asRecord(denial);
                const toolUseId =
                  asString(denialRecord?.tool_use_id) ??
                  asString(denialRecord?.toolUseId) ??
                  asString(denialRecord?.id) ??
                  crypto.randomUUID();
                const toolName =
                  asString(denialRecord?.tool_name) ??
                  asString(denialRecord?.toolName) ??
                  asString(denialRecord?.name) ??
                  "Tool";
                const detail = toolDetail(
                  toolName,
                  denialRecord?.tool_input ?? denialRecord?.toolInput ?? denialRecord?.input,
                );
                const requestId = RuntimeRequestId.makeUnsafe(
                  `claude-denial:${input.threadId}:${toolUseId}`,
                );
                const requestType = requestTypeForClaudeTool(toolName);
                state.pendingApprovals.set(String(requestId), {
                  requestId,
                  turnId,
                  requestType,
                  toolName,
                  ...(detail ? { detail } : {}),
                  denial: denialRecord ?? denial,
                  replayInput: cloneSendTurnInput(input),
                });

                appendTurnSnapshotItem(input.threadId, turnId, {
                  kind: "approval.requested",
                  requestId,
                  requestType,
                  toolName,
                  ...(detail ? { detail } : {}),
                  data: denialRecord ?? denial,
                });

                publishFork({
                  ...buildBaseEvent({
                    threadId: input.threadId,
                    turnId,
                    requestId,
                    raw: buildRaw(denialRecord ?? denial, "result/permission_denial/request_opened"),
                  }),
                  type: "request.opened",
                  payload: {
                    requestType,
                    ...(detail ? { detail } : {}),
                    args: denialRecord ?? denial,
                  },
                });
              }
              const errorMessage =
                record.is_error === true
                  ? coerceDetail(record.errors) ?? asString(record.result) ?? "Claude turn failed"
                  : permissionDenials.length > 0
                    ? `Claude denied ${permissionDenials.length} tool request(s).`
                    : undefined;
              const stopReason =
                asString(record.stop_reason) ??
                (record.subtype === "success" ? "end_turn" : asString(record.subtype)) ??
                null;

              turnState.finalizePromise = runBackgroundEffect(
                finalizeTurn({
                  threadId: input.threadId,
                  turnId,
                  state: errorMessage ? "failed" : "completed",
                  ...(stopReason !== null ? { stopReason } : {}),
                  ...(record.usage !== undefined ? { usage: record.usage } : {}),
                  ...(asRecord(record.modelUsage) ? { modelUsage: record.modelUsage as Record<string, unknown> } : {}),
                  ...(typeof record.total_cost_usd === "number"
                    ? { totalCostUsd: record.total_cost_usd }
                    : {}),
                  ...(errorMessage ? { errorMessage } : {}),
                }).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("failed to finalize Claude turn", {
                      threadId: input.threadId,
                      error,
                    }),
                  ),
                ),
              );
            }
          };

          const drainStdout = (chunk: Buffer) => {
            stdoutBuffer += chunk.toString("utf8");
            while (true) {
              const newlineIndex = stdoutBuffer.indexOf("\n");
              if (newlineIndex === -1) {
                return;
              }
              const line = stdoutBuffer.slice(0, newlineIndex).trim();
              stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
              if (!line) {
                continue;
              }
              try {
                const record = JSON.parse(line) as Record<string, unknown>;
                processClaudeRecord(record);
              } catch (error) {
                publishFork({
                  ...buildBaseEvent({
                    threadId: input.threadId,
                    turnId,
                    raw: buildRaw({ line }, "stdout/parse-error"),
                  }),
                  type: "runtime.warning",
                  payload: {
                    message: "Received invalid JSON from Claude Code CLI.",
                    detail: error instanceof Error ? error.message : String(error),
                  },
                });
              }
            }
          };

          child.stdout.on("data", drainStdout);
          child.stderr.on("data", (chunk: Buffer) => {
            stderrBuffer += chunk.toString("utf8");
            if (stderrBuffer.length > 8192) {
              stderrBuffer = stderrBuffer.slice(-8192);
            }
          });
          child.once("error", (error) => {
            publishFork({
              ...buildBaseEvent({
                threadId: input.threadId,
                turnId,
                raw: buildRaw({ error: String(error) }, "process/error"),
              }),
              type: "runtime.error",
              payload: {
                message: `Claude Code process error: ${error.message}`,
                class: "provider_error",
              },
            });
          });
          child.once("exit", (code, signal) => {
            if (turnState.completed) {
              const current = sessions.get(input.threadId);
              if (current?.session.resumeCursor === sessionId) {
                current.hasConversation = true;
                sessions.set(input.threadId, current);
              }
              return;
            }

            const interrupted = turnState.interrupted;
            const errorMessage =
              interrupted
                ? "Claude turn interrupted."
                : stderrBuffer.trim().length > 0
                  ? stderrBuffer.trim()
                  : `Claude Code exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}).`;

            turnState.finalizePromise = runBackgroundEffect(
              finalizeTurn({
                threadId: input.threadId,
                turnId,
                state: interrupted ? "interrupted" : "failed",
                ...(interrupted ? {} : { errorMessage }),
              }).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("failed to finalize Claude turn after exit", {
                    threadId: input.threadId,
                    error,
                  }),
                ),
              ),
            );
          });

          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: sessionId,
          };
        });

      const sendTurn: ClaudeAdapterShape["sendTurn"] = (input) => startClaudeTurn(input);

      const interruptTurn: ClaudeAdapterShape["interruptTurn"] = (threadId) =>
        Effect.gen(function* () {
          const state = yield* getSessionState(threadId);
          if (!state.currentTurn) {
            return;
          }
          interruptClaudeTurn(state.currentTurn);
        });

      const respondToRequest: ClaudeAdapterShape["respondToRequest"] = (
        threadId,
        requestId,
        decision,
      ) =>
        Effect.gen(function* () {
          const state = yield* getSessionState(threadId);
          const pendingApproval = state.pendingApprovals.get(String(requestId));
          if (!pendingApproval) {
            return yield* toRequestError(
              "claude.respondToRequest",
              `Unknown pending approval request: ${requestId}.`,
            );
          }

          if (decision === "accept" || decision === "acceptForSession") {
            yield* startClaudeTurn(pendingApproval.replayInput, {
              permissionModeOverride: "bypassPermissions",
            });
            if (decision === "acceptForSession") {
              state.approvalBypassEnabled = true;
            }

            const sameTurnPendingApprovals = [...state.pendingApprovals.values()].filter(
              (entry) => entry.turnId === pendingApproval.turnId,
            );
            for (const entry of sameTurnPendingApprovals) {
              state.pendingApprovals.delete(String(entry.requestId));
            }

            yield* publishResolvedApproval({
              threadId,
              turnId: pendingApproval.turnId,
              requestId: pendingApproval.requestId,
              requestType: pendingApproval.requestType,
              decision,
              resolution: {
                source: "claude.approval.bridge",
                denial: pendingApproval.denial,
                replay: "started",
                toolName: pendingApproval.toolName,
              },
              raw: pendingApproval.denial,
              method: "approval/responded",
            });

            for (const entry of sameTurnPendingApprovals) {
              if (entry.requestId === pendingApproval.requestId) {
                continue;
              }
              yield* publishResolvedApproval({
                threadId,
                turnId: entry.turnId,
                requestId: entry.requestId,
                requestType: entry.requestType,
                decision: "cancel",
                resolution: {
                  source: "claude.approval.bridge",
                  denial: entry.denial,
                  supersededByRequestId: pendingApproval.requestId,
                },
                raw: entry.denial,
                method: "approval/superseded",
              });
            }
            return;
          }

          state.pendingApprovals.delete(String(requestId));
          yield* publishResolvedApproval({
            threadId,
            turnId: pendingApproval.turnId,
            requestId: pendingApproval.requestId,
            requestType: pendingApproval.requestType,
            decision,
            resolution: {
              source: "claude.approval.bridge",
              denial: pendingApproval.denial,
              replay: "skipped",
              toolName: pendingApproval.toolName,
            },
            raw: pendingApproval.denial,
            method: "approval/responded",
          });
        });

      const respondToUserInput: ClaudeAdapterShape["respondToUserInput"] = (
        threadId,
        requestId,
        answers,
      ) =>
        Effect.gen(function* () {
          const state = yield* getSessionState(threadId);
          const pendingUserInput = state.pendingUserInputs.get(String(requestId));
          if (!pendingUserInput) {
            return yield* toRequestError(
              "claude.respondToUserInput",
              `Unknown pending user input request: ${requestId}.`,
            );
          }

          const continuationPrompt = buildClaudeUserInputContinuationPrompt({
            requestId: pendingUserInput.requestId,
            questions: pendingUserInput.questions,
            answers,
          });

          yield* startClaudeTurn({
            ...pendingUserInput.continuationInput,
            input: continuationPrompt,
          });

          state.pendingUserInputs.delete(String(requestId));
          appendTurnSnapshotItem(threadId, pendingUserInput.turnId, {
            kind: "user-input.resolved",
            requestId: pendingUserInput.requestId,
            answers,
            source: "claude.user_input.continuation",
          });

          yield* publish({
            ...buildBaseEvent({
              threadId,
              turnId: pendingUserInput.turnId,
              requestId: pendingUserInput.requestId,
              raw: buildRaw(
                {
                  answers,
                  toolName: pendingUserInput.toolName,
                },
                "user_input/responded",
              ),
            }),
            type: "user-input.resolved",
            payload: {
              answers,
            },
          });
        });

      const waitForTurnFinalization = (turnState: ClaudeTurnState) =>
        turnState.finalizePromise
          ? Effect.promise(() =>
              turnState.finalizePromise?.then(
                () => undefined,
                () => undefined,
              ) ?? Promise.resolve(),
            )
          : Effect.void;

      const settleCurrentTurnBeforeTeardown = (
        threadId: ThreadId,
        turnState: ClaudeTurnState,
      ) =>
        Effect.gen(function* () {
          if (turnState.completed) {
            turnState.child.kill("SIGTERM");
            yield* waitForTurnFinalization(turnState);
            return;
          }

          turnState.completed = true;
          interruptClaudeTurn(turnState);
          yield* finalizeTurn({
            threadId,
            turnId: turnState.turnId,
            state: "interrupted",
          });
        });

      const stopSession: ClaudeAdapterShape["stopSession"] = (threadId) =>
        Effect.gen(function* () {
          const state = sessions.get(threadId);
          if (!state) {
            return;
          }
          const currentTurn = state.currentTurn;
          if (currentTurn) {
            yield* settleCurrentTurnBeforeTeardown(threadId, currentTurn);
          }
          resetClaudeSessionRuntimeState(state);
          sessions.delete(threadId);
          yield* publish({
            ...buildBaseEvent({
              threadId,
              raw: buildRaw({ exitKind: "graceful" }, "session/exited"),
            }),
            type: "session.exited",
            payload: {
              exitKind: "graceful",
            },
          });
        });

      const stopAll: ClaudeAdapterShape["stopAll"] = () =>
        Effect.forEach([...sessions.keys()], (threadId) => stopSession(threadId)).pipe(Effect.asVoid);

      const readThread: ClaudeAdapterShape["readThread"] = (threadId) =>
        Effect.gen(function* () {
          const snapshot = threadSnapshots.get(threadId);
          if (snapshot) {
            return cloneThreadSnapshot(snapshot);
          }
          if (sessions.has(threadId)) {
            return cloneThreadSnapshot(ensureThreadSnapshot(threadId));
          }
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        });

      const rollbackThread: ClaudeAdapterShape["rollbackThread"] = (threadId, numTurns) =>
        Effect.gen(function* () {
          if (!Number.isInteger(numTurns) || numTurns < 1) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "ClaudeAdapter.rollbackThread",
              issue: "numTurns must be an integer >= 1.",
            });
          }

          const snapshot = threadSnapshots.get(threadId);
          if (!snapshot && !sessions.has(threadId)) {
            return yield* new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId,
            });
          }

          const nextSnapshot =
            snapshot ??
            ({
              threadId,
              turns: [],
            } satisfies ClaudeThreadSnapshotState);
          const state = sessions.get(threadId);
          if (state) {
            const currentTurn = state.currentTurn;
            if (currentTurn) {
              yield* settleCurrentTurnBeforeTeardown(threadId, currentTurn);
            }

            const { activeTurnId: _activeTurnId, lastError: _lastError, ...sessionBase } =
              state.session;
            resetClaudeSessionRuntimeState(state);
            state.session = {
              ...sessionBase,
              status: "ready",
              updatedAt: nowIso(),
              resumeCursor: crypto.randomUUID(),
            };
            sessions.set(threadId, state);

            yield* publish({
              ...buildBaseEvent({
                threadId,
                raw: buildRaw(
                  {
                    detail:
                      "Claude conversation context was reset after rollback because Claude Code cannot rewind provider history.",
                    numTurns,
                  },
                  "thread/rollback",
                ),
              }),
              type: "runtime.warning",
              payload: {
                message:
                  "Claude rollback reset the provider conversation. Earlier thread state remains in T3 history only.",
              },
            });

            yield* publish({
              ...buildBaseEvent({
                threadId,
                raw: buildRaw({ state: "ready", reason: "rollback-reset" }, "session/state"),
              }),
              type: "session.state.changed",
              payload: {
                state: "ready",
                reason: "Claude conversation reset after rollback",
              },
            });
          }

          nextSnapshot.turns = nextSnapshot.turns.slice(
            0,
            Math.max(0, nextSnapshot.turns.length - numTurns),
          );
          threadSnapshots.set(threadId, nextSnapshot);

          return cloneThreadSnapshot(nextSnapshot);
        });

      return {
        provider: PROVIDER,
        capabilities: {
          sessionModelSwitch: "in-session",
        },
        startSession,
        sendTurn,
        interruptTurn,
        respondToRequest,
        respondToUserInput,
        stopSession,
        listSessions: () => Effect.sync(() => [...sessions.values()].map((state) => state.session)),
        hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
        readThread,
        rollbackThread,
        stopAll,
        streamEvents: Stream.fromQueue(eventQueue),
      } satisfies ClaudeAdapterShape;
    }),
  );
}
