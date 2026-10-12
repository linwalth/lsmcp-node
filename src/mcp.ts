import { toJsonSchema } from "./schema";
import type { LogseqClient } from "./client";
import type { ToolReg } from "./tools/shared";
import { coerceArgs, validateArgs } from "./tools/shared";
import { coreTools } from "./tools/core";
import { navTools } from "./tools/nav";
import { writeTools } from "./tools/write";

export const ALL_TOOLS: ToolReg[] = [...coreTools, ...navTools, ...writeTools];

export const SERVER_INFO = { name: "lsmcp-node", version: "0.1.0" };
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

export interface JsonRpcMsg {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
}

export interface JsonRpcResp {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

export function toolDefs(): any[] {
  return ALL_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: toJsonSchema(tool.inputSchema),
    annotations: tool.annotations,
  }));
}

function handleSync(msg: JsonRpcMsg): JsonRpcResp | null {
  const id = msg.id ?? null;
  switch (msg.method) {
    case "initialize": {
      const clientVersion = msg.params?.protocolVersion as string | undefined;
      const protocolVersion =
        clientVersion && SUPPORTED_PROTOCOL_VERSIONS.includes(clientVersion) ? clientVersion : SUPPORTED_PROTOCOL_VERSIONS[0];
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      };
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: toolDefs() } };
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}

async function handleCall(msg: JsonRpcMsg, client: LogseqClient): Promise<JsonRpcResp> {
  const id = msg.id ?? null;
  const toolName = msg.params?.name as string;
  const rawArgs = (msg.params?.arguments || {}) as Record<string, unknown>;
  const tool = ALL_TOOLS.find((t) => t.name === toolName);

  if (!tool) {
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Unknown tool: ${toolName}` }], isError: true } };
  }

  let args: Record<string, unknown>;
  try {
    args = coerceArgs(tool.inputSchema, rawArgs);
    validateArgs(tool.inputSchema, args);
  } catch (err) {
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true } };
  }

  try {
    const text = await tool.handler(client, args);
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } };
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true },
    };
  }
}

export async function processMessage(msg: JsonRpcMsg, client: LogseqClient): Promise<JsonRpcResp | null> {
  if (msg.method === "tools/call") return handleCall(msg, client);
  return handleSync(msg);
}
