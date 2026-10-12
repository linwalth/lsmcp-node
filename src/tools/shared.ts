import type { Schema } from "../schema";
import type { LogseqClient } from "../client";

// Some MCP clients stringify structured arguments (arrays/objects) before sending.
// A `blocks`/`properties`/`inputs` value may therefore arrive as a JSON string
// instead of a real array/object. Unwrap such strings back into structured values.
// Only strings that look like JSON (`[`/`{`) are parsed; plain text is returned as-is.
export function coerceJsonValue(value: unknown): unknown {
  let current = value;
  for (let i = 0; i < 4; i++) {
    if (typeof current !== "string") return current;
    const trimmed = current.trim();
    if (!trimmed) return current;
    const first = trimmed[0];
    if (first !== "[" && first !== "{") return current;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed === current) return current;
      current = parsed;
    } catch {
      return current;
    }
  }
  return current;
}

export interface ToolReg {
  name: string;
  description: string;
  inputSchema: Record<string, Schema>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  handler: (client: LogseqClient, args: Record<string, unknown>) => Promise<string>;
}

export const ANNOT_READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
export const ANNOT_APPEND = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};
export const ANNOT_UPDATE_IDEMPOTENT = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
export const ANNOT_DELETE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};
export const ANNOT_RENAME = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};
