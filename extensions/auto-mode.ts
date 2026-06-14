/**
 * Claude Code-style auto mode for Pi.
 *
 * The enforcement order is deliberately different from simple "auto reviewer" plugins:
 * permission deny/ask rules and deterministic hard-deny checks run before any fast-path allow.
 * Only then do read-only tools pass, and all remaining tools go through the classifier.
 */

export * from "./auto-mode/classifier.ts";
export * from "./auto-mode/config.ts";
export * from "./auto-mode/constants.ts";
export * from "./auto-mode/extension.ts";
export * from "./auto-mode/hard-deny.ts";
export * from "./auto-mode/model.ts";
export * from "./auto-mode/model-selector.ts";
export * from "./auto-mode/paths.ts";
export * from "./auto-mode/permissions.ts";
export * from "./auto-mode/state.ts";
export * from "./auto-mode/transcript.ts";
export * from "./auto-mode/types.ts";

import { createPiAutomode } from "./auto-mode/extension.ts";

export default createPiAutomode();
