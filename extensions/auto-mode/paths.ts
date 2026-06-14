import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { HOME, PROFILE_FILES } from "./constants.ts";

function stripLeadingAt(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

export function resolveInputPath(cwd: string, value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const raw = stripLeadingAt(value.trim());
  return isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
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

export function isProtectedPath(path: string, cwd: string, protectedPaths: string[]): boolean {
  // Resolve symlinks so writes through symlinks (e.g. not-git -> .git) are caught.
  let resolved = path;
  try {
    resolved = realpathSync(path);
  } catch {
    // File doesn't exist yet — try resolving the parent directory.
    try {
      const dir = dirname(path);
      const base = basename(path);
      resolved = join(realpathSync(dir), base);
    } catch {
      // Parent doesn't exist either — fall through with raw path.
    }
  }

  // For paths inside the project: use relative path for matching.
  if (resolved.startsWith(cwd)) {
    const relativePath = relative(cwd, resolved);
    for (const pattern of protectedPaths) {
      if (
        relativePath === pattern ||
        relativePath.startsWith(`${pattern}/`)
      ) {
        return true;
      }
    }
    return false;
  }

  // For paths outside the project: check every path component suffix.
  // This catches writes like ../other-project/.git/config even when cwd
  // doesn't contain the target.
  const segments = resolved.split("/").filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    const suffix = segments.slice(i).join("/");
    for (const pattern of protectedPaths) {
      if (
        suffix === pattern ||
        suffix.startsWith(`${pattern}/`)
      ) {
        return true;
      }
    }
  }
  return false;
}

export function isSafetyControlPath(path: string, cwd: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const file = basename(normalized).toLowerCase();
  if (
    normalized.endsWith("/.pi/auto-mode.json") ||
    normalized.endsWith("/auto-mode.json")
  )
    return true;
  if (normalized.includes("/.pi/extensions/") && file.includes("auto"))
    return true;
  if (normalized.includes("/.pi/") && file.startsWith("automode")) return true;
  if (
    normalized.includes("/pi-automode/") ||
    (isInside(path, cwd) && file.includes("auto-mode"))
  )
    return true;
  return false;
}

export function shellPathTokenToPath(token: string, cwd: string): string | undefined {
  let value = token.trim();
  if (!value || value === "-" || value.startsWith("&")) return undefined;
  value = value
    .replace(/^\$HOME(?=\/|$)/, HOME)
    .replace(/^\$\{HOME\}(?=\/|$)/, HOME);
  if (value.startsWith("~/")) value = resolve(HOME, value.slice(2));
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

export function isProfileOrAuthorizedKeysPath(path: string): string | undefined {
  if (PROFILE_FILES.has(path))
    return "shell profile modification is hard-denied";
  if (path === resolve(HOME, ".ssh/authorized_keys"))
    return "SSH authorized_keys modification is hard-denied";
  return undefined;
}
