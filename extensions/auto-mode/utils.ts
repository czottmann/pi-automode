export function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.trim().length > 0,
  );
}

export function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

export function truncateMiddle(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const head = Math.floor(maxLength * 0.65);
  const tail = maxLength - head - 18;
  return `${text.slice(0, head)}… […] …${text.slice(text.length - tail)}`;
}

export function safeJson(value: unknown, maxLength = 4000): string {
  const seen = new WeakSet<object>();
  let text = "{}";
  try {
    text = JSON.stringify(
      value,
      (_key, current) => {
        if (typeof current === "string") {
          return truncateMiddle(
            current,
            Math.max(200, Math.floor(maxLength / 4)),
          );
        }
        if (Array.isArray(current)) return current.slice(0, 30);
        if (current && typeof current === "object") {
          if (seen.has(current)) return "[Circular]";
          seen.add(current);
        }
        return current;
      },
      2,
    ) ?? "{}";
  } catch {
    text = String(value);
  }
  return truncateMiddle(text, maxLength);
}
