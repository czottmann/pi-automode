import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readlinkSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  parse,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { HOME, PATH_BEARING_TOOLS, PROFILE_FILES } from "./constants.ts";
import { extractEditPaths } from "./edit-targets.ts";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Convert Git Bash, MSYS, Cygwin, and WSL drive paths for Windows APIs. */
function normalizeWindowsShellPath(path: string): string {
  if (
    process.platform !== "win32" ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\")
  ) {
    return path;
  }
  const match = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return path;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${match[1]?.toUpperCase()}:\\${suffix ?? ""}`;
}

/** Mirror Pi's path normalization options. */
function normalizeInputPath(
  value: string,
  options: { normalizeUnicodeSpaces?: boolean; stripAtPrefix?: boolean } = {},
): string {
  let normalized = options.normalizeUnicodeSpaces
    ? value.replace(UNICODE_SPACES, " ")
    : value;
  if (options.stripAtPrefix && normalized.startsWith("@")) {
    normalized = normalized.slice(1);
  }
  normalized = normalizeWindowsShellPath(normalized);
  if (normalized === "~") return HOME;
  if (
    normalized.startsWith("~/") ||
    (process.platform === "win32" && normalized.startsWith("~\\"))
  ) {
    return join(HOME, normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
  return normalized;
}

export function resolveInputPath(
  cwd: string,
  value: unknown,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = normalizeInputPath(value, {
    normalizeUnicodeSpaces: true,
    stripAtPrefix: true,
  });
  return isAbsolute(normalized)
    ? resolve(normalized)
    : resolve(normalizeInputPath(cwd), normalized);
}

function existingReadVariant(path: string): string {
  const candidates = [
    path,
    path.replace(/ (AM|PM)\./gi, "\u202F$1."),
    path.normalize("NFD"),
    path.replace(/'/g, "\u2019"),
    path.normalize("NFD").replace(/'/g, "\u2019"),
  ];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.F_OK);
      return candidate;
    } catch {
      // Try the next Pi-compatible read fallback.
    }
  }
  return path;
}

/** Resolve the path that the named Pi file tool will operate on. */
export function resolveToolInputPath(
  toolName: string,
  cwd: string,
  value: unknown,
): string | undefined {
  const resolved = resolveInputPath(cwd, value);
  if (!resolved || toolName !== "read") return resolved;
  return existingReadVariant(resolved);
}

export interface ToolPathExtraction {
  paths: string[];
  error?: string;
}

// OMP's execution-time expansion differs from Pi for @, : and ~name.
// Keep that behavior local to OMP payloads; Pi scalar paths retain their rules.
function resolveOmpPath(cwd: string, value: string): string | undefined {
  let path = value
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ")
    .replace(/\u202F(?=[AP]M)/g, " ");
  if (path.startsWith("@") && /^@(?:~[/\\]|[/\\]|[A-Za-z]:\\)/.test(path)) {
    path = path.slice(1);
  }
  if (/^:(?=[/\\~]|\.\.?[/\\]|[A-Za-z]:)/.test(path)) path = path.slice(1);
  if (!path || /[\u0000\r\n]/.test(path) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(path)) {
    return undefined;
  }
  if (process.platform === "win32") {
    if (/^\\\\[?.]\\/.test(path)) return undefined;
    path = path.replace(/^\/([a-zA-Z])(?:\/|$)/, "$1:/");
  }
  if (path.startsWith("~")) path = join(HOME, path.startsWith("~/") ? path.slice(2) : path.slice(1));
  return isAbsolute(path) ? path : resolve(cwd, path);
}

/** Native WriteTool and resolvePlanPath each recover one complete header. */
function nativeWritePath(path: string): string {
  for (let stage = 0; stage < 2; stage++) {
    const candidate = path.trimEnd();
    if (!candidate.startsWith("[") || !candidate.endsWith("]") || /[\r\n]/.test(candidate)) break;
    const inner = candidate.slice(1, -1);
    const hash = inner.lastIndexOf("#");
    const target = hash >= 0 && /^[0-9a-fA-F]{4}$/.test(inner.slice(hash + 1))
      ? inner.slice(0, hash) : inner;
    if (!target || target.startsWith("/") && target.endsWith("/") && target.length > 1) break;
    path = target;
  }
  return path;
}

/** OMP normalizes these spellings to the session-local URL before filesystem lookup. */
function isNativeLocalAlias(path: string): boolean {
  return /^local:\/(?!\/)/i.test(path) ||
    (!/^(?![A-Za-z]:[/\\])[A-Za-z][A-Za-z0-9+.-]*:/.test(path) &&
      /[/\\]local:\/{1,2}(?=[^/]|$)/i.test(path));
}

/**
 * Literal files win over native read lists and selectors. Support only targets
 * we can enumerate; fail closed on parser-specific grouping or fuzzy recovery.
 */
function nativeReadPaths(value: string, cwd: string, strict: boolean): ToolPathExtraction {
  let entry = value;
  if (strict && isNativeLocalAlias(entry)) {
    return { paths: [], error: "Native local URL aliases cannot be enforced as filesystem paths" };
  }
  if (strict && entry.includes(";") && /["'{}\\]/.test(entry)) {
    return { paths: [], error: "Ambiguous native semicolon-list normalization" };
  }
  if (strict && entry.includes("?")) {
    return { paths: [], error: "OMP read query routing cannot be inspected safely" };
  }
  const range = /^(?:\d+(?:-\d*|\+\d+)?|-\d+)(?:,(?:\d+(?:-\d*|\+\d+)?|-\d+))*$/;
  function atom(item: string): string | undefined {
    const full = resolveOmpPath(cwd, item);
    const colon = item.lastIndexOf(":");
    const suffix = item.slice(colon + 1);
    const hasSelector = colon > 0 &&
      (range.test(suffix) || /^(?:raw|conflicts|img)$/i.test(suffix));
    if (full && existsSync(full)) {
      // Non-line archive/database/binary members may dispatch to an earlier
      // file prefix. Without that handler's target discovery, fail closed.
      if (strict && !hasSelector) {
        for (let index = item.indexOf(":"); index >= 0; index = item.indexOf(":", index + 1)) {
          const prefix = resolveOmpPath(cwd, item.slice(0, index));
          if (prefix && existsSync(prefix) && !lstatSync(prefix).isDirectory()) return undefined;
        }
      }
      return full;
    }
    if (!hasSelector) return undefined;
    let basePath = item.slice(0, colon);
    const innerColon = basePath.lastIndexOf(":");
    const inner = basePath.slice(innerColon + 1);
    if (innerColon > 0 && ((/^raw$/i.test(suffix) && range.test(inner)) ||
      (range.test(suffix) && /^raw$/i.test(inner)))) basePath = basePath.slice(0, innerColon);
    // Compound handlers dispatch before ordinary selector/file handling.
    for (let index = basePath.indexOf(":"); index >= 0; index = basePath.indexOf(":", index + 1)) {
      const prefix = resolveOmpPath(cwd, basePath.slice(0, index));
      if (strict && prefix && existsSync(prefix) && !lstatSync(prefix).isDirectory()) return undefined;
    }
    const base = resolveOmpPath(cwd, basePath);
    return base && existsSync(base) ? base : undefined;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(entry)) {
    return strict ? { paths: [], error: "Opaque OMP read target cannot be enforced" } : { paths: [] };
  }
  const literal = atom(entry);
  if (literal) return { paths: [literal] };
  if (/[,;\s]/.test(entry)) {
    if (strict && !entry.includes(";")) {
      return { paths: [], error: "Native comma/whitespace reads require unsupported suffix discovery" };
    }
    entry = entry.trim();
    if (entry.startsWith('"') && entry.endsWith('"')) entry = entry.slice(1, -1);
    if (strict && atom(entry)) {
      return { paths: [], error: "Normalized read spelling requires ambiguous native recovery" };
    }
    if (/["'{}\\]/.test(entry)) {
      return strict ? { paths: [], error: "Ambiguous OMP read path list" } : { paths: [] };
    }
    for (const delimiter of [/;/, /,/, /\s+/, /[,;\s]+/]) {
      const parts = entry.split(delimiter).map((part) => part.trim()).filter(Boolean);
      if (parts.length < 2) continue;
      const targets = parts.map(atom);
      if (targets.every((target) => target !== undefined)) return { paths: targets as string[] };
      if (strict) {
        return { paths: [], error: "Cannot resolve every OMP read path-list target" };
      }
    }
    return strict
      ? { paths: [], error: "Cannot resolve every OMP read path-list target" }
      : { paths: [] };
  }
  return strict
    ? { paths: [], error: "OMP read target requires unsupported glob, suffix or case recovery" }
    : { paths: [] };
}

/** Complete effective targets, or an error before any edit can be allowed. */
export function extractToolPaths(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  options: { nativeRead?: boolean; nativeWrite?: boolean } = {},
): ToolPathExtraction {
  if (!PATH_BEARING_TOOLS.has(toolName)) return { paths: [] };
  if (toolName === "edit") {
    const extracted = extractEditPaths(input);
    if (extracted.error) return { paths: [], error: extracted.error };
    const paths: string[] = [];
    for (const target of extracted.paths) {
      const path = extracted.format === "omp"
        ? resolveOmpPath(cwd, target)
        : resolveToolInputPath(toolName, cwd, target);
      if (!path) return { paths: [], error: "Edit target cannot be resolved safely" };
      paths.push(path);
      if (extracted.format === "pi") {
        // Scalar Pi and OMP schemas overlap. Cover both host expansions rather
        // than inferring the host from untrusted arguments.
        const ompPath = resolveOmpPath(cwd, target);
        if (ompPath) paths.push(ompPath);
      }
    }
    if (extracted.format === "omp" && input.path !== undefined) {
      const hint = typeof input.path === "string"
        ? resolveOmpPath(cwd, input.path)
        : undefined;
      if (!hint || !paths.includes(hint)) {
        return { paths: [], error: "Edit compatibility path conflicts with payload targets" };
      }
    }
    if (extracted.format === "omp" && input.paths !== undefined) {
      if (
        !Array.isArray(input.paths) || input.paths.length === 0 ||
        input.paths.some((value) => {
          const hint = typeof value === "string" ? resolveOmpPath(cwd, value) : undefined;
          return !hint || !paths.includes(hint);
        })
      ) {
        return { paths: [], error: "Edit compatibility paths conflict with payload targets" };
      }
    }
    if (paths.some((path) => !resolvePathForPolicy(path))) {
      return { paths: [], error: "Cannot canonicalize every edit target" };
    }
    return { paths: [...new Set(paths)] };
  }
  const values = Array.isArray(input.paths)
    ? [...(input.path === undefined ? [] : [input.path]), ...input.paths]
    : [input.path === undefined || input.path === ""
      ? toolName === "grep" || toolName === "find" || toolName === "ls"
        ? "."
        : input.path
      : input.path];
  if (values.length === 0 || values.some((value) => typeof value !== "string" || !value)) {
    return { paths: [], error: "Missing or invalid filesystem target" };
  }
  const paths: string[] = [];
  for (const value of values as string[]) {
    const path = resolveToolInputPath(toolName, cwd, value);
    const nativeWrite = toolName === "write" ? nativeWritePath(value) : value;
    if (toolName === "write" && options.nativeWrite) {
      if (isNativeLocalAlias(nativeWrite)) {
        return { paths: [], error: "Native local URL aliases cannot be enforced as filesystem paths" };
      }
      for (let colon = nativeWrite.indexOf(":"); colon >= 0; colon = nativeWrite.indexOf(":", colon + 1)) {
        if (process.platform === "win32" && colon === 1 && /^[A-Za-z]:/.test(nativeWrite)) continue;
        const prefix = resolveOmpPath(cwd, nativeWrite.slice(0, colon));
        if (prefix && existsSync(prefix) && !lstatSync(prefix).isDirectory()) {
          return { paths: [], error: "Native compound write targets cannot be enumerated safely" };
        }
      }
    }
    const ompPath = resolveOmpPath(cwd, nativeWrite);
    if (!ompPath && !(path && /^file:\/\//.test(value) && !options.nativeRead && !options.nativeWrite)) {
      return { paths: [], error: "Opaque or invalid filesystem target" };
    }
    if (!options.nativeRead && path) paths.push(path);
    if (toolName === "read") {
      let native: ToolPathExtraction;
      try {
        native = nativeReadPaths(value, cwd, options.nativeRead === true);
      } catch {
        return { paths: [], error: "Cannot inspect every native read target" };
      }
      if (native.error) return native;
      paths.push(...native.paths);
      if (!options.nativeRead && native.paths.length === 0 && ompPath) paths.push(ompPath);
    } else {
      if (ompPath) paths.push(ompPath);
    }
  }
  if (paths.some((path) => !resolvePathForPolicy(path))) {
    return { paths: [], error: "Cannot canonicalize every filesystem target" };
  }
  return { paths: [...new Set(paths)] };
}

/** Expand a leading `~`, `$HOME`, or `${HOME}` in a path-denial pattern. */
export function expandHomePattern(pattern: string): string {
  const home = HOME.replace(/\\/g, "/");
  if (pattern === "~" || pattern === "$HOME" || pattern === "${HOME}") {
    return home;
  }
  if (pattern.startsWith("~/")) return `${home}/${pattern.slice(2)}`;
  if (pattern.startsWith("$HOME/")) return `${home}/${pattern.slice(6)}`;
  if (pattern.startsWith("${HOME}/")) return `${home}/${pattern.slice(8)}`;
  return pattern;
}

export function normalizePathForMatch(path: string, cwd: string): string {
  const normalized = normalize(path);
  const rel = relative(cwd, normalized);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : normalized;
}

export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

/** Canonicalize symlinks before "..", including missing and dangling targets. */
export function resolvePathForPolicy(path: string): string | undefined {
  function canonicalize(input: string, links: number): string | undefined {
    if (links > 40) return undefined;
    const root = parse(input).root;
    let current = root;
    for (const component of input.slice(root.length).split(sep)) {
      if (!component || component === ".") continue;
      if (component === "..") {
        current = dirname(current);
        continue;
      }
      const candidate = join(current, component);
      try {
        if (lstatSync(candidate).isSymbolicLink()) {
          const destination = readlinkSync(candidate);
          const target = canonicalize(
            isAbsolute(destination) ? destination : `${current}${sep}${destination}`,
            links + 1,
          );
          if (!target) return undefined;
          current = target;
        } else {
          current = candidate;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
        current = candidate;
      }
    }
    return current;
  }
  return canonicalize(isAbsolute(path) ? path : resolve(path), 0);
}

function normalizeProtectedPathForMatch(value: string): string {
  return value
    .replace(/\\/g, "/")
    .normalize("NFC")
    .toLowerCase()
    .normalize("NFC");
}

export function matchesProtectedPath(
  relativePath: string,
  protectedPaths: string[],
): boolean {
  const normalizedPath = normalizeProtectedPathForMatch(relativePath);
  return protectedPaths.some((pattern) => {
    const normalizedPattern = normalizeProtectedPathForMatch(pattern);
    return normalizedPath === normalizedPattern ||
      normalizedPath.startsWith(`${normalizedPattern}/`);
  });
}

export function isProtectedPath(
  path: string,
  cwd: string,
  protectedPaths: string[],
): boolean {
  const resolvedCwd = resolvePathForPolicy(cwd) ?? cwd;
  const candidates = [resolve(path), resolvePathForPolicy(path) ?? path];
  return candidates.some((candidate) => {
    if (isInside(candidate, resolvedCwd)) {
      return matchesProtectedPath(relative(resolvedCwd, candidate), protectedPaths);
    }
    // Outside the project, match every component suffix, including .git.
    const segments = candidate.replace(/\\/g, "/").split("/").filter(Boolean);
    for (let i = 0; i < segments.length; i++) {
      if (matchesProtectedPath(segments.slice(i).join("/"), protectedPaths)) return true;
    }
    return false;
  });
}

export function isSafetyControlPath(path: string, cwd: string, nativeAgentDir?: string): boolean {
  const policyPath = resolvePathForPolicy(path) ?? resolve(path);
  const policyCwd = resolvePathForPolicy(cwd) ?? resolve(cwd);
  // A symlink must not hide either a control-path spelling or its target.
  return [resolve(path), policyPath].some((candidate) => {
    const normalized = normalizeProtectedPathForMatch(candidate);
    const file = basename(normalized);
    const agentRoots = [
      resolve(HOME, ".pi", "agent"),
      resolve(HOME, ".omp", "agent"),
      resolve(HOME, process.env.PI_CONFIG_DIR?.trim() || ".omp", "agent"),
      join(HOME, process.env.PI_CONFIG_DIR || ".omp", "agent"),
    ];
    const configuredRoot = resolveInputPath(cwd, process.env.PI_CODING_AGENT_DIR);
    if (configuredRoot) agentRoots.push(configuredRoot);
    if (process.env.PI_CODING_AGENT_DIR) agentRoots.push(resolve(process.env.PI_CODING_AGENT_DIR));
    if (nativeAgentDir) agentRoots.push(nativeAgentDir);
    // Deny canonical aliases too, including default roots and project controls.
    agentRoots.push(...agentRoots.map((root) => resolvePathForPolicy(root) ?? root));
    for (const directory of agentRoots) {
      const root = normalizeProtectedPathForMatch(directory);
      if (
        normalized === `${root}/settings.json` ||
        normalized === `${root}/config.yml` ||
        normalized === `${root}/config.yaml` ||
        normalized === `${root}/extensions` ||
        normalized.startsWith(`${root}/extensions/`) ||
        normalized === `${root}/settings` ||
        normalized.startsWith(`${root}/settings/`)
      ) return true;
    }
    const projectRoots = [resolve(cwd, ".omp"), join(cwd, process.env.PI_CONFIG_DIR || ".omp")];
    for (const root of [...projectRoots, ...projectRoots.map((root) => resolvePathForPolicy(root))]) {
      if (!root) continue;
      const projectRoot = normalizeProtectedPathForMatch(root);
      if (
        normalized === `${projectRoot}/settings.json` ||
        normalized === `${projectRoot}/config.yml` ||
        normalized === `${projectRoot}/config.yaml` ||
        normalized === `${projectRoot}/extensions` ||
        normalized.startsWith(`${projectRoot}/extensions/`)
      ) return true;
    }
    if (
      normalized.endsWith("/auto-mode.json") ||
      /\/\.omp\/(?:settings\.json|config\.ya?ml)$/.test(normalized) ||
      normalized.endsWith("/.omp/extensions") ||
      normalized.includes("/.omp/extensions/") ||
      (normalized.includes("/.pi/extensions/") && file.includes("auto")) ||
      ((normalized.includes("/.pi/") || normalized.includes("/.omp/")) && file.startsWith("automode")) ||
      normalized.includes("/pi-automode/") ||
      (isInside(candidate, policyCwd) && file.includes("auto-mode"))
    ) return true;
    return false;
  });
}

export function shellPathTokenToPath(
  token: string,
  cwd: string,
  shellText = token,
): string | undefined {
  let value = token.trim();
  if (!value || value === "-" || value.startsWith("&")) return undefined;
  value = value
    .replace(/^\$HOME(?=\/|$)/, HOME)
    .replace(/^\$\{HOME\}(?=\/|$)/, HOME);
  if (shellText === "~") value = HOME;
  else if (shellText.startsWith("~/")) value = resolve(HOME, value.slice(2));
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

export function isProfileOrAuthorizedKeysPath(
  path: string,
): string | undefined {
  if (PROFILE_FILES.has(path)) {
    return "shell profile modification is hard-denied";
  }
  if (path === resolve(HOME, ".ssh/authorized_keys")) {
    return "SSH authorized_keys modification is hard-denied";
  }
  return undefined;
}
