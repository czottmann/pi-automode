import * as hostSdk from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Entries = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;
type ContextBuilder = typeof hostSdk.buildSessionContext;

// Read the SDK export at call time to avoid OMP's loader cycle.
export function snapshotContextEntries(
  ctx: ExtensionContext,
  includeToolResults: boolean,
  buildContext: ContextBuilder | undefined = hostSdk.buildSessionContext,
): { entries: Entries; supportsOutcomes: boolean } {
  const manager = ctx.sessionManager as typeof ctx.sessionManager & {
    buildContextEntries?: () => Entries | null | undefined;
  };
  const retained = manager.buildContextEntries?.();
  if (retained != null) return { entries: retained, supportsOutcomes: true };

  const branch = manager.getBranch();
  if (includeToolResults && typeof buildContext === "function" &&
    branch.every(entry => typeof entry.id === "string" && entry.id.length > 0)) {
    // Pass the branch leaf explicitly so the SDK does not choose another entry.
    const leafId = branch.at(-1)?.id ?? null;
    const context = buildContext(branch, leafId);
    return {
      entries: context.messages.map((message, index) => ({
        type: "message",
        id: `context-${index}`,
        parentId: null,
        timestamp: "",
        message,
      })),
      supportsOutcomes: true,
    };
  }

  // Raw branch results are not classifier evidence.
  return { entries: branch, supportsOutcomes: false };
}
