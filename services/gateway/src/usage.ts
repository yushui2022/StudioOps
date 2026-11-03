export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

const FIELD =
  /"(prompt_tokens|completion_tokens|total_tokens|prompt_eval_count|eval_count)"\s*:\s*(\d+)/g;

/**
 * Pull token counts out of an upstream response as it streams past.
 * Only the numeric usage fields are kept. Prompt text is discarded.
 */
export class UsageObserver {
  private tail = "";
  readonly usage: TokenUsage = {};

  observe(chunk: Buffer | string): TokenUsage {
    this.tail += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (this.tail.length > 65_536) this.tail = this.tail.slice(-65_536);
    this.read(this.tail);
    return this.usage;
  }

  private read(text: string): void {
    for (const match of text.matchAll(FIELD)) {
      const value = Number(match[2]);
      if (!Number.isFinite(value)) continue;
      if (match[1] === "prompt_tokens" || match[1] === "prompt_eval_count") {
        this.usage.promptTokens = value;
      } else if (
        match[1] === "completion_tokens" ||
        match[1] === "eval_count"
      ) {
        this.usage.completionTokens = value;
      } else {
        this.usage.totalTokens = value;
      }
    }
    if (
      this.usage.totalTokens === undefined &&
      this.usage.promptTokens !== undefined &&
      this.usage.completionTokens !== undefined
    ) {
      this.usage.totalTokens =
        this.usage.promptTokens + this.usage.completionTokens;
    }
  }
}

/**
 * True when two Ollama names refer to the same resident model.
 * ravenx-cyber and ravenx-cyber:35b match. Different tags do not.
 */
export function sameResidentModel(requested: string, loaded: string): boolean {
  const left = requested.trim();
  const right = loaded.trim();
  if (!left || !right) return false;
  if (left === right) return true;
  const base = (name: string) => {
    const index = name.indexOf(":");
    return index === -1 ? name : name.slice(0, index);
  };
  const untagged = (name: string) => !name.includes(":");
  return (
    (untagged(left) && base(right) === left) ||
    (untagged(right) && base(left) === right)
  );
}
