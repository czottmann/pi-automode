import type { Model } from "@earendil-works/pi-ai";

export function parseModelSpec(
  spec: string,
): { provider: string; id: string } | undefined {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash >= spec.length - 1) return undefined;
  return { provider: spec.slice(0, slash), id: spec.slice(slash + 1) };
}

export function formatModelSpec(model: Model<any>): string {
  return `${model.provider}/${model.id}`;
}
