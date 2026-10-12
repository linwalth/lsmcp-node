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

function coerceScalar(type: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (type === "number" && typeof value === "string") {
    const t = value.trim();
    if (t !== "" && !Number.isNaN(Number(t))) return Number(t);
  }
  if (type === "boolean" && typeof value === "string") {
    const t = value.trim().toLowerCase();
    if (t === "true") return true;
    if (t === "false") return false;
  }
  return value;
}

// Coerce raw MCP tool arguments into the shapes the handlers expect:
// - structured fields (array/object/any/union) that arrived as JSON strings are unwrapped
// - numeric/boolean scalars that arrived as strings are converted
// Only fields declared in the tool schema are touched; unknown args pass through.
export function coerceArgs(inputSchema: Record<string, Schema>, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  for (const [key, field] of Object.entries(inputSchema)) {
    if (!(key in out)) continue;
    const type = field.schema?.type;
    if (type === "number" || type === "boolean") {
      out[key] = coerceScalar(type, out[key]);
    } else if (type === "array" || type === "object") {
      out[key] = coerceJsonValue(out[key]);
    } else if (!type) {
      // z.any() / oneOf / union (e.g. blocks) — unwrap a stringified payload.
      out[key] = coerceJsonValue(out[key]);
    }
  }
  return out;
}

// Validate coerced arguments against the tool schema. Fails loud with the
// offending keys instead of letting a wrong type reach the handler.
export function validateArgs(inputSchema: Record<string, Schema>, args: Record<string, unknown>): void {
  const problems: string[] = [];
  for (const [key, field] of Object.entries(inputSchema)) {
    const value = args[key];
    const nullable = !!field.schema?.nullable;
    if (value === undefined) {
      if (!field.isOptional && !nullable) problems.push(`${key}: required`);
      continue;
    }
    if (value === null) {
      if (!nullable && !field.isOptional) problems.push(`${key}: must not be null`);
      continue;
    }
    const type = field.schema?.type;
    if (type === "string" && typeof value !== "string") problems.push(`${key}: expected string`);
    else if (type === "number" && typeof value !== "number") problems.push(`${key}: expected number`);
    else if (type === "boolean" && typeof value !== "boolean") problems.push(`${key}: expected boolean`);
    else if (type === "array" && !Array.isArray(value)) problems.push(`${key}: expected array`);
    else if (type === "object" && (typeof value !== "object" || Array.isArray(value))) problems.push(`${key}: expected object`);
  }
  if (problems.length) throw new Error(`invalid arguments: ${problems.join("; ")}`);
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
