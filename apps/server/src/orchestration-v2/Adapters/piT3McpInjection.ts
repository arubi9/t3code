import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { McpProviderSessionConfig } from "../../mcp/McpProviderSession.ts";
import {
  PI_T3_MCP_EXTENSION_FILENAME,
  PI_T3_MCP_EXTENSION_SOURCE,
  T3_MCP_BEARER_ENV,
  T3_MCP_URL_ENV,
  T3_PI_RUNTIME_MODE_ENV,
} from "./piT3McpExtensionSource.ts";
import {
  PI_T3_SUBAGENT_EXTENSION_FILENAME,
  PI_T3_SUBAGENT_EXTENSION_SOURCE,
  T3_PI_CHILD_SESSION_ROOT_ENV,
} from "./piT3SubagentExtensionSource.ts";

export { PI_T3_SUBAGENT_EXTENSION_FILENAME, T3_PI_CHILD_SESSION_ROOT_ENV };

/** Env var telling the T3 subagent override where the MCP extension lives. */
export const T3_PI_MCP_EXTENSION_PATH_ENV = "T3_PI_MCP_EXTENSION_PATH";

const RESERVED_PI_LAUNCH_ARGUMENTS = new Set([
  "--continue",
  "-c",
  "--export",
  "--fork",
  "--help",
  "-h",
  "--list-models",
  "--mode",
  "--no-session",
  "--print",
  "-p",
  "--resume",
  "-r",
  "--session",
  "--session-id",
  "--version",
  "-v",
]);

const PI_ARGUMENTS_WITH_VALUES = new Set([
  "--api-key",
  "--append-system-prompt",
  "--exclude-tools",
  "-xt",
  "--extension",
  "-e",
  "--model",
  "--models",
  "--name",
  "-n",
  "--prompt-template",
  "--provider",
  "--session-dir",
  "--skill",
  "--system-prompt",
  "--theme",
  "--thinking",
  "--tools",
  "-t",
  "--tui-mode",
  "--use-theme",
]);

const PI_ARGUMENTS_WITHOUT_VALUES = new Set([
  "--approve",
  "-a",
  "--no-approve",
  "-na",
  "--no-builtin-tools",
  "-nbt",
  "--no-context-files",
  "-nc",
  "--no-extensions",
  "-ne",
  "--no-prompt-templates",
  "-np",
  "--no-skills",
  "-ns",
  "--no-themes",
  "--no-tools",
  "-nt",
  "--offline",
  "--verbose",
]);

export type PiLaunchArgsResolution =
  | { readonly ok: true; readonly args: ReadonlyArray<string> }
  | { readonly ok: false; readonly message: string };

function reservedPiArgument(arg: string): string | undefined {
  for (const reserved of RESERVED_PI_LAUNCH_ARGUMENTS) {
    if (arg === reserved || (reserved.startsWith("--") && arg.startsWith(`${reserved}=`))) {
      return reserved;
    }
  }
  return undefined;
}

function normalizePiBuiltInEqualsArguments(args: ReadonlyArray<string>): ReadonlyArray<string> {
  return args.flatMap((arg) => {
    const equalsIndex = arg.indexOf("=");
    if (equalsIndex <= 0) return [arg];
    const option = arg.slice(0, equalsIndex);
    return PI_ARGUMENTS_WITH_VALUES.has(option) ? [option, arg.slice(equalsIndex + 1)] : [arg];
  });
}

/**
 * Pi launch arguments may configure resources, models, tools, trust, and
 * storage. T3 owns RPC mode and session identity, so arguments that select a
 * different execution mode or native session are rejected before spawn.
 */
export function resolvePiLaunchArgs(launchArgs: string): PiLaunchArgsResolution {
  // Pi parses equals-form tokens only as extension flags, even when their name
  // matches a built-in option. Split known built-ins while leaving arbitrary
  // extension flags in their native form.
  const args = normalizePiBuiltInEqualsArguments(tokenizeCliArgs(launchArgs));
  let hasProvider = false;
  let hasModel = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    const reserved = reservedPiArgument(arg);
    if (reserved !== undefined) {
      return {
        ok: false,
        message: `Pi launch argument '${reserved}' is controlled by T3 Code and cannot be overridden.`,
      };
    }
    if (arg === "--") {
      return {
        ok: false,
        message: "Pi launch arguments cannot include positional prompts.",
      };
    }
    if (PI_ARGUMENTS_WITH_VALUES.has(arg)) {
      const value = args[index + 1];
      if (value === undefined) {
        return { ok: false, message: `Pi launch argument '${arg}' requires a value.` };
      }
      if (arg === "--provider") hasProvider = true;
      if (arg === "--model") hasModel = true;
      index += 1;
      continue;
    }
    if (PI_ARGUMENTS_WITHOUT_VALUES.has(arg) || (arg.startsWith("--") && arg.includes("="))) {
      continue;
    }
    if (arg.startsWith("--")) {
      // Pi extensions may register arbitrary long flags. Treat one following
      // non-flag token as that extension flag's value.
      if (
        args[index + 1] !== undefined &&
        !args[index + 1]!.startsWith("-") &&
        !args[index + 1]!.startsWith("@")
      ) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("-")) {
      return { ok: false, message: `Pi launch argument '${arg}' is not supported by T3 Code.` };
    }
    return {
      ok: false,
      message: `Pi launch arguments cannot include positional prompt '${arg}'.`,
    };
  }
  // Pi 1.0 exits at startup on `--provider` without `--model`; older versions
  // silently ran another provider's default model. Rejecting it here makes
  // every spawn site report the reason instead of a bare exit code.
  if (hasProvider && !hasModel) {
    return { ok: false, message: "Pi launch argument '--provider' requires '--model'." };
  }
  return { ok: true, args };
}

function bearerTokenFromAuthorizationHeader(header: string): string {
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : header;
}

function normalizedPiPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function hasExplicitExtension(args: ReadonlyArray<string>, extensionPath: string): boolean {
  const wanted = normalizedPiPath(extensionPath);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--extension" && arg !== "-e") continue;
    const configured = args[index + 1];
    if (configured !== undefined && normalizedPiPath(configured) === wanted) return true;
    index += 1;
  }
  return false;
}

function withoutExplicitExtensions(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const filtered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--extension" || arg === "-e") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--extension=") || arg.startsWith("-e=")) continue;
    filtered.push(arg);
  }
  return filtered;
}

function withoutToolSelectionArgs(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const filtered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "--tools" || arg === "-t" || arg === "--exclude-tools" || arg === "-xt") {
      index += 1;
      continue;
    }
    if (
      arg === "--no-tools" ||
      arg === "-nt" ||
      arg === "--no-builtin-tools" ||
      arg === "-nbt" ||
      arg.startsWith("--tools=") ||
      arg.startsWith("-t=") ||
      arg.startsWith("--exclude-tools=") ||
      arg.startsWith("-xt=")
    ) {
      continue;
    }
    filtered.push(arg);
  }
  return filtered;
}

const PiPackageSource = Schema.Union([
  Schema.String,
  Schema.Struct({
    source: Schema.String,
    autoload: Schema.optional(Schema.Boolean),
    extensions: Schema.optional(Schema.Array(Schema.String)),
  }),
]);

const PiSettingsFile = Schema.Struct({
  defaultProjectTrust: Schema.optional(Schema.String),
  packages: Schema.optional(Schema.Array(PiPackageSource)),
});

const PiPackageJson = Schema.Struct({
  pi: Schema.optional(
    Schema.Struct({
      extensions: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
});

const PiTrustStore = Schema.Record(Schema.String, Schema.NullOr(Schema.Boolean));

const decodePiSettings = Schema.decodeUnknownOption(Schema.fromJsonString(PiSettingsFile));
const decodePiPackageJson = Schema.decodeUnknownOption(Schema.fromJsonString(PiPackageJson));
const decodePiTrustStore = Schema.decodeUnknownOption(Schema.fromJsonString(PiTrustStore));

function normalizePiTrustPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalized.length === 0) return "/";
  return /^[A-Za-z]:$/.test(normalized) ? `${normalized}/` : normalized;
}

function piTrustParentPath(value: string): string | undefined {
  if (value === "/" || /^[A-Za-z]:\/$/.test(value)) return undefined;
  const uncRoot = value.match(/^\/\/[^/]+\/[^/]+/)?.[0];
  if (uncRoot === value) return undefined;
  const separatorIndex = value.lastIndexOf("/");
  if (separatorIndex < 0) return undefined;
  const parent = separatorIndex === 0 ? "/" : value.slice(0, separatorIndex);
  return uncRoot !== undefined && parent.length < uncRoot.length
    ? uncRoot
    : normalizePiTrustPath(parent);
}

/** Mirrors Pi's canonical nearest-ancestor lookup over `trust.json`. */
function piNearestProjectTrustDecision(
  trust: typeof PiTrustStore.Type,
  cwd: string,
): boolean | undefined {
  const decisions = new Map(
    Object.entries(trust).map(([path, decision]) => [normalizePiTrustPath(path), decision]),
  );
  let current: string | undefined = normalizePiTrustPath(cwd);
  while (current !== undefined) {
    const decision = decisions.get(current);
    if (decision === true || decision === false) return decision;
    current = piTrustParentPath(current);
  }
  return undefined;
}

function piNpmPackageName(source: string): string | undefined {
  if (!source.startsWith("npm:")) return undefined;
  const spec = source.slice("npm:".length).trim();
  const name = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@.+)?$/)?.[1];
  return name !== undefined &&
    /^(?:@[A-Za-z0-9._~-]+\/[A-Za-z0-9._~-]+|[A-Za-z0-9._~-]+)$/.test(name)
    ? name
    : undefined;
}

function piGitPackageRoot(agentDir: string, source: string): string | undefined {
  if (!source.startsWith("git:")) return undefined;
  const spec = source.slice("git:".length).trim();
  const withoutRef = spec.replace(/@[^/@]+$/u, "").replace(/\.git$/u, "");
  const [host, ...segments] = withoutRef.split("/");
  if (
    host === undefined ||
    host === "." ||
    host === ".." ||
    !/^[A-Za-z0-9.-]+$/u.test(host) ||
    segments.length < 2 ||
    segments.some(
      (segment) => segment === "." || segment === ".." || !/^[A-Za-z0-9._~-]+$/u.test(segment),
    )
  ) {
    return undefined;
  }
  return `${agentDir}/git/${host}/${segments.join("/")}`;
}

function piPackageSource(pkg: typeof PiPackageSource.Type): string {
  return typeof pkg === "string" ? pkg : pkg.source;
}

function piPackageExtensionPath(packageRoot: string, entry: string): string | undefined {
  const segments: Array<string> = [];
  for (const segment of entry.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.pop() === undefined) return undefined;
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? undefined : `${packageRoot}/${segments.join("/")}`;
}

function piPackagePatternPaths(
  fs: FileSystem.FileSystem,
  packageRoot: string,
  pattern: string,
  exact: boolean,
): Effect.Effect<Set<string>> {
  const normalizedPattern = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    normalizedPattern.length === 0 ||
    normalizedPattern.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalizedPattern) ||
    normalizedPattern.split("/").includes("..")
  ) {
    return Effect.succeed(new Set());
  }
  const patterns =
    exact || normalizedPattern.includes("/")
      ? [normalizedPattern]
      : [normalizedPattern, `**/${normalizedPattern}`];
  return Effect.forEach(patterns, (candidate) =>
    exact
      ? Effect.succeed([candidate])
      : fs.glob(candidate, { root: packageRoot }).pipe(Effect.orElseSucceed(() => [])),
  ).pipe(
    Effect.map(
      (groups) =>
        new Set(
          groups.flatMap((matches) =>
            matches.flatMap((match) => {
              const normalizedMatch = normalizedPiPath(match);
              const path = normalizedMatch.startsWith(`${normalizedPiPath(packageRoot)}/`)
                ? normalizedMatch
                : piPackageExtensionPath(packageRoot, normalizedMatch);
              return path === undefined ? [] : [path];
            }),
          ),
        ),
    ),
  );
}

function piEnabledPackageExtensions(
  fs: FileSystem.FileSystem,
  packageRoot: string,
  extensionPaths: ReadonlyArray<string>,
  pkg: typeof PiPackageSource.Type,
): Effect.Effect<Array<string>> {
  return Effect.gen(function* () {
    if (typeof pkg === "string") return [...extensionPaths];
    if (pkg.extensions === undefined) return pkg.autoload === false ? [] : [...extensionPaths];
    if (pkg.extensions.length === 0) return [];
    const includes = pkg.extensions.filter((pattern) => !/^[!+-]/.test(pattern));
    const patterns =
      pkg.autoload === false
        ? pkg.extensions
        : [
            ...includes,
            ...pkg.extensions.filter((pattern) => pattern.startsWith("!")),
            ...pkg.extensions.filter((pattern) => pattern.startsWith("+")),
            ...pkg.extensions.filter((pattern) => pattern.startsWith("-")),
          ];
    const enabled = new Set(pkg.autoload === false || includes.length > 0 ? [] : extensionPaths);
    for (const pattern of patterns) {
      const prefix = pattern[0];
      const target = /^[!+-]/.test(prefix ?? "") ? pattern.slice(1) : pattern;
      const matches = yield* piPackagePatternPaths(
        fs,
        packageRoot,
        target,
        prefix === "+" || prefix === "-",
      );
      for (const path of extensionPaths) {
        if (!matches.has(path)) continue;
        if (prefix === "!" || prefix === "-") enabled.delete(path);
        else enabled.add(path);
      }
    }
    return extensionPaths.filter((path) => enabled.has(path));
  });
}

/**
 * Re-discover the user's pi extensions for a `--no-extensions` spawn: the
 * subagent override forces discovery off (a second `subagent` registration
 * aborts pi), which must not cost the user every other extension they have.
 * Mirrors pi's own discovery roots and user package manifests:
 * `<agent dir>/extensions`, `settings.json` package `pi.extensions`, and the
 * project-local `.pi/extensions` only under Pi's recorded per-project trust
 * or, when no decision exists, `defaultProjectTrust: "always"` —
 * explicit `--extension` paths bypass pi's trust prompt, so anything short
 * of standing trust must not be silently loaded. Pi's `pi-subagents` package
 * and conventional `subagent` entries are skipped in favor of the T3 override.
 */
export const discoverPiUserExtensions = Effect.fn("discoverPiUserExtensions")(function* (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const home = input.environment["HOME"] ?? input.environment["USERPROFILE"];
  const agentDir =
    input.environment["PI_CODING_AGENT_DIR"] ??
    (home === undefined ? undefined : `${normalizedPiPath(home)}/.pi/agent`);
  const normalizedAgentDir = agentDir === undefined ? undefined : normalizedPiPath(agentDir);
  const settingsRaw =
    normalizedAgentDir === undefined
      ? ""
      : yield* fs
          .readFileString(`${normalizedAgentDir}/settings.json`)
          .pipe(Effect.orElseSucceed(() => ""));
  const settings = Option.getOrUndefined(decodePiSettings(settingsRaw));
  const roots: Array<string> = [];
  if (normalizedAgentDir !== undefined) roots.push(`${normalizedAgentDir}/extensions`);
  if (normalizedAgentDir !== undefined && input.cwd !== undefined) {
    const cwd = input.cwd;
    const trustPath = `${normalizedAgentDir}/trust.json`;
    const trustExists = yield* fs.exists(trustPath).pipe(Effect.orElseSucceed(() => false));
    const trustRaw = trustExists
      ? yield* fs.readFileString(trustPath).pipe(Effect.orElseSucceed(() => ""))
      : undefined;
    const trustStore =
      trustRaw === undefined ? {} : Option.getOrUndefined(decodePiTrustStore(trustRaw));
    const canonicalCwd = yield* fs.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));
    const decision =
      trustStore === undefined ? false : piNearestProjectTrustDecision(trustStore, canonicalCwd);
    const projectTrusted = decision ?? settings?.defaultProjectTrust === "always";
    if (projectTrusted) {
      roots.push(`${normalizedPiPath(cwd)}/.pi/extensions`);
    }
  }
  const found: Array<string> = [];
  const addFound = (path: string) => {
    if (!isConflictingPiSubagentExtensionPath(path) && !found.includes(path)) found.push(path);
  };
  for (const root of roots) {
    const entries = yield* fs
      .readDirectory(root)
      .pipe(Effect.orElseSucceed(() => [] as Array<string>));
    for (const entry of entries.toSorted()) {
      if (entry === "subagent" || entry === "subagent.ts" || entry === "subagent.js") continue;
      const path = `${root}/${entry}`;
      if (entry.endsWith(".ts") || entry.endsWith(".js")) {
        addFound(path);
        continue;
      }
      for (const indexPath of [`${path}/index.ts`, `${path}/index.js`]) {
        const hasIndex = yield* fs.exists(indexPath).pipe(Effect.orElseSucceed(() => false));
        if (hasIndex) {
          addFound(indexPath);
          break;
        }
      }
    }
  }
  if (normalizedAgentDir !== undefined) {
    for (const pkg of settings?.packages ?? []) {
      const source = piPackageSource(pkg);
      const packageName = piNpmPackageName(source);
      if (packageName === "pi-subagents") continue;
      const packageRoot =
        packageName === undefined
          ? piGitPackageRoot(normalizedAgentDir, source)
          : `${normalizedAgentDir}/npm/node_modules/${packageName}`;
      if (packageRoot === undefined) continue;
      const packageJsonRaw = yield* fs
        .readFileString(`${packageRoot}/package.json`)
        .pipe(Effect.orElseSucceed(() => ""));
      const packageJson = Option.getOrUndefined(decodePiPackageJson(packageJsonRaw));
      const extensionPaths: Array<string> = [];
      for (const entry of packageJson?.pi?.extensions ?? []) {
        const extensionPath = piPackageExtensionPath(packageRoot, entry);
        if (extensionPath === undefined) continue;
        const exists = yield* fs.exists(extensionPath).pipe(Effect.orElseSucceed(() => false));
        if (exists) extensionPaths.push(extensionPath);
      }
      const enabledExtensions = yield* piEnabledPackageExtensions(
        fs,
        packageRoot,
        extensionPaths,
        pkg,
      );
      for (const extensionPath of enabledExtensions) {
        addFound(extensionPath);
      }
    }
  }
  return found;
});

/** Official / user-installed `subagent` tool. Not the T3 override file. */
function isConflictingPiSubagentExtensionPath(extensionPath: string): boolean {
  const normalized = normalizedPiPath(extensionPath);
  if (normalized.endsWith(`/${PI_T3_SUBAGENT_EXTENSION_FILENAME}`)) return false;
  return (
    normalized.endsWith("/extensions/subagent/index.ts") ||
    normalized.endsWith("/extensions/subagent/index.js") ||
    normalized.endsWith("/examples/extensions/subagent/index.ts") ||
    normalized.endsWith("/examples/extensions/subagent/index.js")
  );
}

function stripConflictingPiSubagentExtensionArgs(args: ReadonlyArray<string>): string[] {
  const stripped: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    const next = args[index + 1];
    if (
      (arg === "--extension" || arg === "-e") &&
      next !== undefined &&
      isConflictingPiSubagentExtensionPath(next)
    ) {
      index += 1;
      continue;
    }
    stripped.push(arg);
  }
  return stripped;
}

function deduplicatePiExtensionArgs(args: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const deduplicated: Array<string> = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    const extensionPath = args[index + 1];
    if ((arg === "--extension" || arg === "-e") && extensionPath !== undefined) {
      index += 1;
      const normalized = normalizedPiPath(extensionPath);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      deduplicated.push(arg, extensionPath);
      continue;
    }
    deduplicated.push(arg);
  }
  return deduplicated;
}

function piChildSessionRoot(launchArgs: ReadonlyArray<string>): string | undefined {
  const index = launchArgs.indexOf("--session-dir");
  const sessionDir = index >= 0 ? launchArgs[index + 1] : undefined;
  if (sessionDir === undefined || sessionDir.length === 0) return undefined;
  return `${sessionDir.replace(/\\/g, "/")}/children`;
}

const materializeExtension = Effect.fn("materializePiExtension")(function* (
  cacheDir: string,
  filename: string,
  source: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(cacheDir, { recursive: true });
  const dest = `${cacheDir.replace(/\\/g, "/")}/${filename}`;
  const existing = yield* fs.readFileString(dest).pipe(Effect.orElseSucceed(() => ""));
  if (existing !== source) yield* fs.writeFileString(dest, source);
  return dest;
});

export const materializePiT3McpExtension = (cacheDir: string) =>
  materializeExtension(cacheDir, PI_T3_MCP_EXTENSION_FILENAME, PI_T3_MCP_EXTENSION_SOURCE);

export const materializePiT3SubagentExtension = (cacheDir: string) =>
  materializeExtension(
    cacheDir,
    PI_T3_SUBAGENT_EXTENSION_FILENAME,
    PI_T3_SUBAGENT_EXTENSION_SOURCE,
  );

export function buildPiRpcLaunch(input: {
  readonly launchArgs: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
  readonly mcpSession: McpProviderSessionConfig | undefined;
  readonly extensionPath: string | undefined;
  /** T3's `subagent` override; replaces Pi's discovery so only one registers. */
  readonly subagentExtensionPath?: string | undefined;
  /** User extensions re-added around the `--no-extensions` subagent spawn. */
  readonly discoveredExtensionPaths?: ReadonlyArray<string> | undefined;
  readonly ephemeral?: boolean;
  readonly disableExtensions?: boolean;
  readonly disableTools?: boolean;
  readonly runtimeMode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
}): {
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly hasT3Mcp: boolean;
} {
  const hasT3Extension = input.disableExtensions !== true && input.extensionPath !== undefined;
  const hasT3Mcp = hasT3Extension && input.mcpSession !== undefined;
  const useSubagentOverride =
    input.disableExtensions !== true && input.subagentExtensionPath !== undefined;
  const extensionSafeArgs =
    input.disableExtensions === true
      ? withoutExplicitExtensions(input.launchArgs)
      : useSubagentOverride
        ? stripConflictingPiSubagentExtensionArgs(input.launchArgs)
        : input.launchArgs;
  const launchArgs =
    input.disableTools === true ? withoutToolSelectionArgs(extensionSafeArgs) : extensionSafeArgs;
  let args = ["--mode", "rpc", ...(input.ephemeral === true ? ["--no-session"] : [])];
  if (useSubagentOverride) {
    // Duplicate `subagent` registrations abort Pi: disable discovery, load the
    // T3 override, then re-add the user's other extensions explicitly.
    if (!input.launchArgs.includes("--no-extensions") && !input.launchArgs.includes("-ne")) {
      args.push("--no-extensions");
    }
    args.push("--extension", input.subagentExtensionPath);
    for (const discovered of input.discoveredExtensionPaths ?? []) {
      args.push("--extension", discovered);
    }
  }
  args.push(
    ...launchArgs,
    // Restrictions follow user launch args so a configured --tools or
    // --extension cannot silently re-enable unattended text-generation code.
    ...(input.disableExtensions === true ? ["--no-extensions"] : []),
    ...(input.disableTools === true ? ["--no-tools"] : []),
  );
  if (
    hasT3Extension &&
    input.extensionPath !== undefined &&
    !hasExplicitExtension(args, input.extensionPath)
  ) {
    args.push("--extension", input.extensionPath);
  }
  args = deduplicatePiExtensionArgs(args);
  const childSessionRoot = piChildSessionRoot(input.launchArgs);
  const environment = { ...input.environment };
  // These values belong to the current T3 session. Never let a Pi child reuse
  // credentials inherited from the server or a parent provider process.
  delete environment[T3_MCP_URL_ENV];
  delete environment[T3_MCP_BEARER_ENV];

  return {
    args,
    env: {
      ...environment,
      ...(!useSubagentOverride || childSessionRoot === undefined
        ? {}
        : { [T3_PI_CHILD_SESSION_ROOT_ENV]: childSessionRoot }),
      ...(hasT3Extension && input.runtimeMode !== undefined
        ? {
            [T3_PI_RUNTIME_MODE_ENV]:
              input.runtimeMode === "auto" ? "approval-required" : input.runtimeMode,
          }
        : {}),
      ...(hasT3Mcp && input.mcpSession !== undefined
        ? {
            [T3_MCP_URL_ENV]: input.mcpSession.endpoint,
            [T3_MCP_BEARER_ENV]: bearerTokenFromAuthorizationHeader(
              input.mcpSession.authorizationHeader,
            ),
            // The subagent override passes this to child spawns so native
            // children get the T3 tools too (env is inherited).
            ...(input.extensionPath === undefined
              ? {}
              : { [T3_PI_MCP_EXTENSION_PATH_ENV]: input.extensionPath }),
          }
        : {}),
    },
    hasT3Mcp,
  };
}
