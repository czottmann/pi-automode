import type { Model } from "@earendil-works/pi-ai";
import type { EffectiveConfig } from "./types.ts";

export function parseModelSpec(
  spec: string,
): { provider: string; id: string } | undefined {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash >= spec.length - 1) return undefined;
  return { provider: spec.slice(0, slash), id: spec.slice(slash + 1) };
}

export function classifierModelForProvider(
  config: Pick<EffectiveConfig, "classifierModel" | "classifierModelByProvider">,
  provider?: string,
): string | undefined {
  if (
    provider && config.classifierModelByProvider &&
    Object.prototype.hasOwnProperty.call(
      config.classifierModelByProvider,
      provider,
    )
  ) {
    return config.classifierModelByProvider[provider];
  }
  return config.classifierModel;
}

export function formatModelSpec(model: Model<any>): string {
  return `${model.provider}/${model.id}`;
}
