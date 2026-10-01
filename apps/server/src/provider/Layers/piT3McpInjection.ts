import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

import type { McpProviderSessionConfig } from "../../mcp/McpProviderSession.ts";
import {
  PI_T3_MCP_EXTENSION_FILENAME,
  PI_T3_MCP_EXTENSION_SOURCE,
  T3_MCP_BEARER_ENV,
  T3_MCP_URL_ENV,
} from "./piT3McpExtensionSource.ts";
// Native T3 child-thread projection is not ported. Never load the old override
// alongside ordinary Pi subagent extensions; those remain user-owned tools.
const PI_T3_SUBAGENT_EXTENSION_FILENAME = "pi-t3-subagent-extension.ts";
export const T3_PI_MCP_EXTENSION_PATH_ENV = "T3_PI_MCP_EXTENSION_PATH";

function bearerTokenFromAuthorizationHeader(header: string): string {
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : header;
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
              const normalizedMatch = normalizePiPath(match);
              const path = normalizedMatch.startsWith(`${normalizePiPath(packageRoot)}/`)
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

/** Explicit extension arguments bypass Pi trust. Re-add only user-installed
 * resources and project extensions under canonical standing trust, never
 * project settings/packages from an untrusted checkout. No package installs. */
export const discoverPiUserExtensions = Effect.fn("discoverPiUserExtensions")(function* (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const home = input.environment["HOME"] ?? input.environment["USERPROFILE"];
  const agentDir =
    input.environment["PI_CODING_AGENT_DIR"] ??
    (home === undefined ? undefined : `${normalizePiPath(home)}/.pi/agent`);
  const normalizedAgentDir = agentDir === undefined ? undefined : normalizePiPath(agentDir);
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
    // Missing trust is different from unreadable/corrupt trust: only the
    // former permits the user's default policy to apply.
    const trustRaw = yield* fs
      .readFileString(trustPath)
      .pipe(Effect.catch((error) => Effect.succeed(error.reason._tag === "NotFound" ? "{}" : "")));
    const trustStore = Option.getOrUndefined(decodePiTrustStore(trustRaw));
    const canonicalCwd = yield* fs.realPath(cwd).pipe(Effect.orElseSucceed(() => undefined));
    const decision =
      trustStore === undefined || canonicalCwd === undefined
        ? false
        : piNearestProjectTrustDecision(trustStore, canonicalCwd);
    const projectTrusted = decision ?? settings?.defaultProjectTrust === "always";
    if (projectTrusted) {
      roots.push(`${normalizePiPath(cwd)}/.pi/extensions`);
    }
  }
  const found: Array<string> = [];
  const addFound = (path: string) => {
    if (!isDeferredPiSubagentOverride(path) && !found.includes(path)) found.push(path);
  };
  for (const root of roots) {
    const entries = yield* fs
      .readDirectory(root)
      .pipe(Effect.orElseSucceed(() => [] as Array<string>));
    for (const entry of entries.toSorted()) {
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

function piT3McpExtensionDestPath(cacheDir: string): string {
  return `${cacheDir.replace(/\\/g, "/")}/${PI_T3_MCP_EXTENSION_FILENAME}`;
}

function normalizePiPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isDeferredPiSubagentOverride(path: string): boolean {
  return normalizePiPath(path).split("/").at(-1) === PI_T3_SUBAGENT_EXTENSION_FILENAME;
}

export const materializePiT3McpExtension = Effect.fn("materializePiT3McpExtension")(function* (
  cacheDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(cacheDir, { recursive: true });
  const dest = piT3McpExtensionDestPath(cacheDir);
  yield* fs.writeFileString(dest, PI_T3_MCP_EXTENSION_SOURCE);
  return dest;
});

/** A probe or a different thread must never inherit a previous MCP identity. */
export function piEnvironmentWithoutT3Mcp(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...environment };
  for (const key of [
    T3_MCP_URL_ENV,
    T3_MCP_BEARER_ENV,
    T3_PI_MCP_EXTENSION_PATH_ENV,
    "T3_PI_CHILD_SESSION_ROOT",
  ])
    delete env[key];
  return env;
}

export function buildPiRpcLaunch(input: {
  readonly launchArgs: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly mcpSession?: McpProviderSessionConfig | undefined;
  readonly extensionPath?: string | undefined;
  readonly discoveredExtensionPaths?: ReadonlyArray<string>;
}): {
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly hasT3Mcp: boolean;
} {
  const userArgs = tokenizeCliArgs(input.launchArgs);
  const hasT3Mcp = input.mcpSession !== undefined && input.extensionPath !== undefined;
  const args = ["--mode", "rpc", "--no-extensions"];
  const seen = new Set<string>();
  const add = (path: string) => {
    const normalized = normalizePiPath(path);
    // Old override depends on v2 lifecycle consumers; loading it in v1 both
    // loses child ownership and conflicts with ordinary `subagent` tools.
    if (isDeferredPiSubagentOverride(path) || seen.has(normalized)) return;
    // T3 alone injects its bridge, only when this launch has a scoped session.
    if (
      normalized.split("/").at(-1) === PI_T3_MCP_EXTENSION_FILENAME &&
      (!hasT3Mcp || path !== input.extensionPath)
    )
      return;
    seen.add(normalized);
    args.push("--extension", path);
  };
  // An explicit user opt-out suppresses rediscovery, not T3's owned bridge.
  if (!userArgs.includes("--no-extensions") && !userArgs.includes("-ne")) {
    for (const path of input.discoveredExtensionPaths ?? []) add(path);
  }
  for (let i = 0; i < userArgs.length; i++) {
    const arg = userArgs[i]!;
    if (arg === "--no-extensions" || arg === "-ne") continue;
    if (arg === "--extension" || arg === "-e") {
      const path = userArgs[++i];
      if (path) add(path);
    } else if (arg.startsWith("--extension=")) add(arg.slice("--extension=".length));
    else args.push(arg);
  }
  const env = piEnvironmentWithoutT3Mcp(input.environment);
  if (hasT3Mcp && input.mcpSession && input.extensionPath) {
    add(input.extensionPath);
    env[T3_MCP_URL_ENV] = input.mcpSession.endpoint;
    env[T3_MCP_BEARER_ENV] = bearerTokenFromAuthorizationHeader(
      input.mcpSession.authorizationHeader,
    );
    env[T3_PI_MCP_EXTENSION_PATH_ENV] = input.extensionPath;
  }
  return { args, env, hasT3Mcp };
}
