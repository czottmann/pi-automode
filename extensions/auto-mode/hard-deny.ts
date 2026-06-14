import { resolve } from "node:path";
import { HOME } from "./constants.ts";
import {
  isProfileOrAuthorizedKeysPath,
  isSafetyControlPath,
  resolveInputPath,
  shellPathTokenToPath,
} from "./paths.ts";

type ShellSegment = {
  text: string;
  words: string[];
  redirectTargets: string[];
};

function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i] ?? "";
    const next = command[i + 1] ?? "";
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (
      char === ";" ||
      char === "\n" ||
      char === "|" ||
      (char === "&" && next === "&") ||
      (char === "|" && next === "|")
    ) {
      if (current.trim()) segments.push(current.trim());
      current = "";
      if ((char === "&" && next === "&") || (char === "|" && next === "|"))
        i += 1;
      continue;
    }
    current += char;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

function tokenizeShellSegment(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? "";
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    if (char === ">" || char === "<") {
      let op = char;
      if (/^\d+$/.test(current)) {
        op = current + char;
      } else if (current) {
        tokens.push(current);
      }
      if (text[i + 1] === ">" || text[i + 1] === "&") {
        op += text[i + 1];
        i += 1;
      }
      tokens.push(op);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function parseShell(command: string): ShellSegment[] {
  return splitShellSegments(command).map((text) => {
    const tokens = tokenizeShellSegment(text);
    const words: string[] = [];
    const redirectTargets: string[] = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i] ?? "";
      if (/^(?:\d?>|\d?>>|>|>>|&>|<)$/.test(token)) {
        const target = tokens[i + 1];
        if (target) redirectTargets.push(target);
        i += 1;
        continue;
      }
      const attachedRedirect = token.match(/^(?:\d?>|\d?>>|>|>>|&>)(.+)$/);
      if (attachedRedirect?.[1]) {
        redirectTargets.push(attachedRedirect[1]);
        continue;
      }
      words.push(token);
    }
    return { text, words, redirectTargets };
  });
}

function commandName(words: string[]): string | undefined {
  return words.find((word) => !/^\w+=/.test(word));
}

function commandArgs(words: string[]): string[] {
  const index = words.findIndex((word) => !/^\w+=/.test(word));
  return index >= 0 ? words.slice(index + 1) : [];
}

function isRecursiveRmArg(arg: string): boolean {
  return (
    arg === "--recursive" ||
    /^-[A-Za-z]*r[A-Za-z]*f?[A-Za-z]*$/.test(arg) ||
    /^-[A-Za-z]*f[A-Za-z]*r[A-Za-z]*$/.test(arg)
  );
}

function isRootHomeOrSystemPath(path: string): boolean {
  const systemRoots = [
    "/bin",
    "/boot",
    "/dev",
    "/etc",
    "/lib",
    "/lib64",
    "/private",
    "/sbin",
    "/sys",
    "/usr",
    "/var",
  ];
  return (
    path === "/" ||
    path === HOME ||
    systemRoots.some((root) => path === root || path.startsWith(`${root}/`))
  );
}

function segmentHardDeny(
  segment: ShellSegment,
  cwd: string,
): string | undefined {
  for (const target of segment.redirectTargets) {
    const path = shellPathTokenToPath(target, cwd);
    if (!path) continue;
    const profileReason = isProfileOrAuthorizedKeysPath(path);
    if (profileReason) return profileReason;
    if (isSafetyControlPath(path, cwd))
      return "auto-mode or permission safety-control modification is hard-denied";
  }

  for (const word of segment.words) {
    if (
      /^(NODE_TLS_REJECT_UNAUTHORIZED=0|GIT_SSL_NO_VERIFY=(1|true))$/i.test(
        word,
      )
    )
      return "TLS verification weakening is hard-denied";
  }

  const name = commandName(segment.words);
  if (!name) return undefined;
  const args = commandArgs(segment.words);
  const lowerArgs = args.map((arg) => arg.toLowerCase());

  if (
    ["curl", "wget"].includes(name) &&
    lowerArgs.some((arg) =>
      ["--insecure", "-k", "--no-check-certificate"].includes(arg),
    )
  )
    return "certificate verification weakening is hard-denied";
  if (
    ["npm", "yarn", "pnpm"].includes(name) &&
    lowerArgs[0] === "config" &&
    lowerArgs[1] === "set" &&
    ["strict-ssl", "cafile"].includes(lowerArgs[2] ?? "") &&
    ["false", "null"].includes(lowerArgs[3] ?? "")
  )
    return "package-manager TLS weakening is hard-denied";
  if (
    name === "git" &&
    lowerArgs[0] === "config" &&
    lowerArgs.some(
      (arg) => arg === "sslverify" || arg.endsWith(".sslverify"),
    ) &&
    lowerArgs.includes("false")
  )
    return "git TLS verification weakening is hard-denied";
  if (name === "crontab" && !lowerArgs.includes("-l"))
    return "persistence or system service mutation is hard-denied";
  if (
    name === "launchctl" &&
    ["load", "bootstrap", "enable"].includes(lowerArgs[0] ?? "")
  )
    return "persistence or system service mutation is hard-denied";
  if (
    name === "systemctl" &&
    ["enable", "disable"].includes(lowerArgs[0] ?? "")
  )
    return "persistence or system service mutation is hard-denied";
  if (name === "security" && lowerArgs[0] === "add-trusted-cert")
    return "platform security weakening is hard-denied";
  if (name === "spctl" && lowerArgs.includes("--master-disable"))
    return "platform security weakening is hard-denied";
  if (name === "csrutil" && lowerArgs[0] === "disable")
    return "platform security weakening is hard-denied";

  if (name === "rm" && args.some(isRecursiveRmArg)) {
    for (const arg of args.filter((arg) => !arg.startsWith("-"))) {
      const path = shellPathTokenToPath(arg, cwd);
      if (path && isRootHomeOrSystemPath(path))
        return "irreversible deletion of home/root/system paths is hard-denied";
    }
  }

  if (name === "find" && lowerArgs.includes("-delete")) {
    const root = shellPathTokenToPath(args[0] ?? "", cwd);
    if (root && isRootHomeOrSystemPath(root) && root !== HOME)
      return "system-wide delete is hard-denied";
  }

  if (["chmod", "chown"].includes(name)) {
    for (const arg of args.filter((arg) => !arg.startsWith("-"))) {
      const path = shellPathTokenToPath(arg, cwd);
      if (
        path &&
        (path.startsWith("/etc/") ||
          path.startsWith("/usr/") ||
          path.startsWith("/bin/") ||
          path.startsWith("/sbin/") ||
          path.startsWith("/System/") ||
          path.startsWith(resolve(HOME, ".ssh")))
      )
        return "system or SSH permission mutation is hard-denied";
    }
  }

  if (
    [
      "tee",
      "mv",
      "cp",
      "rm",
      "unlink",
      "truncate",
      "python",
      "python3",
      "node",
      "perl",
      "ruby",
      "sd",
      "sed",
    ].includes(name) &&
    /\.pi\/automode|\.pi\/extensions|pi-automode|auto-mode\.json/i.test(
      segment.text,
    )
  ) {
    return "auto-mode or permission safety-control modification is hard-denied";
  }

  return undefined;
}

/**
 * Deterministic deny checks for actions too risky to delegate to the classifier.
 *
 * Bash checks use a small shell lexer instead of only regexes. It is not a full
 * POSIX shell implementation, but it handles quotes, redirects, pipes, `&&`, and
 * `;` well enough to avoid the common "safe prefix hides risky suffix" bypass.
 */
export function deterministicHardDeny(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): string | undefined {
  if (toolName === "write" || toolName === "edit") {
    const path = resolveInputPath(cwd, input.path);
    if (!path) return undefined;
    const profileReason = isProfileOrAuthorizedKeysPath(path);
    if (profileReason) return profileReason;
    if (isSafetyControlPath(path, cwd))
      return "auto-mode or permission safety-control modification is hard-denied";
  }

  if (toolName !== "bash") return undefined;
  const command = typeof input.command === "string" ? input.command : "";
  for (const segment of parseShell(command)) {
    const reason = segmentHardDeny(segment, cwd);
    if (reason) return reason;
  }
  return undefined;
}
