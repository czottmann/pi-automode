export interface EditPathExtraction {
	paths: string[];
	error?: string;
	format: "pi" | "omp";
}

const lid = "[1-9][0-9]*";
const span = `(?:${lid}\\.=${lid}|${lid}\\*)`;
const gap = `(?:<${lid}|>${lid}\\*?|>\\$)`;
const locator = `(?:${span}|${gap})`;
const register = " @[A-Za-z0-9_-]+";
const bodyPut = new RegExp(`^PUT ${locator}:$`);
const registerPut = new RegExp(`^PUT ${locator}${register}$`);
const emptyPut = new RegExp(`^PUT ${gap}$`);
const cut = new RegExp(`^CUT ${span}(?:${register})?$`);
const fileHeader = /^\[([^#\r\n]+)#([0-9A-F]{4})\]$/;
const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const control = /[\u0000-\u001f\u007f-\u009f]/;
// Native hashline recovers these prefixes as another filename. Do not authorize
// the unrecovered spelling or silently accept syntax outside the wire grammar.
const recoveredHeader = /^(?:\*|(?:update|add|delete|move)[^A-Za-z0-9]*(?:file|to)?[^A-Za-z0-9]*:)/i;

function failure(format: "pi" | "omp", error: string): EditPathExtraction {
	return { paths: [], error, format };
}

function pathError(value: unknown, format: "pi" | "omp"): string | undefined {
	if (typeof value !== "string" || value.trim().length === 0) {
		return "Edit target must be a non-empty string path";
	}
	if (control.test(value)) return "Edit target contains control characters";
	const target = value.trimStart();
	if (scheme.test(target) && !/^[A-Za-z]:[/\\]/.test(target) && !(format === "pi" && target.startsWith("file://"))) {
		return "Opaque URL or control-scheme edit targets are unsupported";
	}
	return undefined;
}

function hasOnlyKeys(input: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(input).every(key => keys.includes(key));
}

/** Native quoting removes only the surrounding quotes, not backslash escapes. */
function hashlinePath(raw: string, move: boolean): string | undefined {
	const value = raw.trim();
	const quote = value[0];
	if (quote !== '"' && quote !== "'") return value;
	if (value.length < 2 || value[value.length - 1] !== quote) return undefined;
	if (move) {
		// Reject ambiguous quote spellings beyond the supported outer-quote form.
		for (let index = 1; index < value.length - 1; index++) {
			if (value[index] === "\\") index++;
			else if (value[index] === quote) return undefined;
		}
		let escapes = 0;
		for (let index = value.length - 2; index >= 0 && value[index] === "\\"; index--) escapes++;
		if (escapes % 2 !== 0) return undefined;
	}
	return value.slice(1, -1);
}

function extractHashline(payload: string): EditPathExtraction {
	// Every header, hunk and body row needs LF. Only End Patch may omit it.
	if (payload.includes("\r")) return failure("omp", "Hashline edits require LF line endings");
	const lines = payload.split("\n");
	const finalLf = lines[lines.length - 1] === "";
	if (finalLf) lines.pop();
	const wrapped = lines[0] === "*** Begin Patch";
	let start = 0;
	let end = lines.length;
	if (wrapped) {
		if (lines[lines.length - 1] !== "*** End Patch") {
			return failure("omp", "Hashline edit has a missing or non-terminal End Patch wrapper");
		}
		start++;
		end--;
	} else if (!finalLf) {
		return failure("omp", "Wrapperless hashline edits require a final LF");
	}

	const paths: string[] = [];
	let sections = 0;
	let hunks = 0;
	let bodyRows = -1;
	for (let index = start; index < end; index++) {
		const line = lines[index];
		if (bodyRows >= 0) {
			if (line.startsWith("+")) {
				bodyRows++;
				continue;
			}
			if (bodyRows === 0) return failure("omp", `PUT needs a body at line ${index + 1}`);
			bodyRows = -1;
		}

		const header = fileHeader.exec(line);
		if (header) {
			if (sections > 0 && hunks === 0) return failure("omp", "Hashline file section needs a hunk");
			const path = hashlinePath(header[1], false);
			if (path === undefined) return failure("omp", "Malformed quoted hashline path");
			const error = pathError(path, "omp");
			if (error) return failure("omp", error);
			if (path !== path.trimStart() || recoveredHeader.test(path)) {
				return failure("omp", "Recovered hashline filename prefixes are unsupported");
			}
			paths.push(path);
			sections++;
			hunks = 0;
			continue;
		}
		if (sections === 0) return failure("omp", `Unsupported or malformed hashline header at line ${index + 1}`);
		if (bodyPut.test(line)) {
			bodyRows = 0;
		} else if (registerPut.test(line) || emptyPut.test(line) || cut.test(line) || line === "REM") {
			// These grammar productions take no body.
		} else if (line.startsWith("MV ") && !line.slice(3).includes("#")) {
			const path = hashlinePath(line.slice(3), true);
			if (path === undefined) return failure("omp", "Malformed quoted hashline move destination");
			const error = pathError(path, "omp");
			if (error) return failure("omp", error);
			// Native MV normalizes a second time, including quote/noise recovery.
			// Refuse those spellings instead of authorizing a different target.
			if (path !== path.trim() || recoveredHeader.test(path) || path.startsWith('"') || path.startsWith("'")) {
				return failure("omp", "Recovered hashline move destinations are unsupported");
			}
			paths.push(path);
		} else {
			return failure("omp", `Unsupported or malformed hashline hunk at line ${index + 1}`);
		}
		hunks++;
	}
	if (sections === 0 || hunks === 0 || bodyRows === 0) {
		return failure("omp", "Hashline edit requires complete file sections and hunk bodies");
	}
	return { paths: [...new Set(paths)], format: "omp" };
}

function validReplacement(input: Record<string, unknown>, withPath: boolean): boolean {
	return hasOnlyKeys(input, withPath
		? ["path", "old_string", "new_string", "replace_all"]
		: ["old_string", "new_string", "replace_all"])
		&& typeof input.old_string === "string"
		&& typeof input.new_string === "string"
		&& (!Object.hasOwn(input, "replace_all") || typeof input.replace_all === "boolean");
}

function extractPiPrepared(input: Record<string, unknown>): EditPathExtraction {
	if (!hasOnlyKeys(input, ["path", "edits"]) || !Array.isArray(input.edits) || input.edits.length === 0) {
		return failure("pi", "Unsupported Pi prepared edit schema");
	}
	const error = pathError(input.path, "pi");
	if (error) return failure("pi", error);
	for (const value of input.edits) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return failure("pi", "Pi edits must contain replacement objects");
		}
		const edit = value as Record<string, unknown>;
		if (!hasOnlyKeys(edit, ["oldText", "newText"])
			|| typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
			return failure("pi", "Malformed Pi replacement edit");
		}
	}
	return { paths: [input.path as string], format: "pi" };
}

function extractStructured(input: Record<string, unknown>): EditPathExtraction {
	const error = pathError(input.path, "omp");
	if (error) return failure("omp", error);
	const paths = [input.path as string];
	if (Object.hasOwn(input, "edits")) {
		if (!hasOnlyKeys(input, ["path", "edits"]) || !Array.isArray(input.edits) || input.edits.length === 0) {
			return failure("omp", "Unsupported structured edit schema");
		}
		let kind: "patch" | "replace" | undefined;
		for (const value of input.edits) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				return failure("omp", "Structured edits must contain objects");
			}
			const edit = value as Record<string, unknown>;
			const replacement = Object.hasOwn(edit, "old_string") || Object.hasOwn(edit, "new_string") || Object.hasOwn(edit, "replace_all");
			const entryKind = replacement ? "replace" : "patch";
			if (kind && kind !== entryKind) return failure("omp", "Mixed structured edit schemas are unsupported");
			kind = entryKind;
			if (replacement) {
				if (!validReplacement(edit, false)) return failure("omp", "Malformed replacement edit");
				continue;
			}
			if (!hasOnlyKeys(edit, ["op", "rename", "diff"])
				|| (!Object.hasOwn(edit, "op") && !Object.hasOwn(edit, "rename") && !Object.hasOwn(edit, "diff"))
				|| (Object.hasOwn(edit, "op") && !["create", "delete", "update"].includes(edit.op as string))
				|| (Object.hasOwn(edit, "diff") && typeof edit.diff !== "string")) {
				return failure("omp", "Unsupported structured patch entry");
			}
			if (Object.hasOwn(edit, "rename")) {
				const renameError = pathError(edit.rename, "omp");
				if (renameError) return failure("omp", renameError);
				paths.push(edit.rename as string);
			}
		}
	} else if (!validReplacement(input, true)) {
		return failure("omp", "Unsupported structured edit schema");
	}
	return { paths: [...new Set(paths)], format: "omp" };
}

/** Extract the complete raw target set without resolving paths or consulting policy. */
export function extractEditPaths(input: Record<string, unknown>): EditPathExtraction {
	if (Object.hasOwn(input, "input")) {
		if (typeof input.input !== "string" || !hasOnlyKeys(input, ["input", "path", "paths"])) {
			return failure("omp", "Unsupported OMP input payload");
		}
		// A compatibility path is not evidence about the payload's targets.
		return extractHashline(input.input);
	}
	// Pi normalizes legacy scalar replacements into this array before tool_call.
	// A Pi-looking entry selects the strict whole batch validator, never a path-only
	// fallback that could hide an OMP rename or another alternate payload.
	if (Array.isArray(input.edits) && input.edits.some(value =>
		typeof value === "object" && value !== null
		&& (Object.hasOwn(value, "oldText") || Object.hasOwn(value, "newText")))) {
		return extractPiPrepared(input);
	}
	if (Object.hasOwn(input, "edits") || Object.hasOwn(input, "old_string")
		|| Object.hasOwn(input, "new_string") || Object.hasOwn(input, "replace_all")) {
		return extractStructured(input);
	}
	if (!hasOnlyKeys(input, ["path", "oldText", "newText"])) {
		return failure("omp", "Unsupported edit payload format");
	}
	const error = pathError(input.path, "pi");
	if (error) return failure("pi", error);
	if ((Object.hasOwn(input, "oldText") && typeof input.oldText !== "string")
		|| (Object.hasOwn(input, "newText") && typeof input.newText !== "string")) {
		return failure("pi", "Pi edit text must be strings");
	}
	return { paths: [input.path as string], format: "pi" };
}
