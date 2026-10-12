import http from "node:http";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { SERVER_INFO, processMessage } from "./mcp";
import type { JsonRpcMsg, JsonRpcResp } from "./mcp";
import type { LogseqClient } from "./client";

const MAX_BODY = 10_000_000;

export function startHttpServer(host: string, port: number, client: LogseqClient): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url === "/" || req.url === "") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(SERVER_INFO));
      return;
    }
    if (req.url !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found. POST /mcp" }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed. Use POST." }));
      return;
    }

    let body = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > MAX_BODY) {
        tooLarge = true;
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32600, message: "Request body too large" }, id: null }));
        req.destroy();
      }
    });
    req.on("end", async () => {
      if (tooLarge) return;
      let msgs: JsonRpcMsg[];
      try {
        const parsed = JSON.parse(body);
        msgs = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
        return;
      }

      const responses: JsonRpcResp[] = [];
      for (const msg of msgs) {
        try {
          const resp = await processMessage(msg, client);
          if (resp) responses.push(resp);
        } catch (err) {
          responses.push({
            jsonrpc: "2.0",
            id: msg.id ?? null,
            error: { code: -32603, message: `Internal error: ${(err as Error).message}` },
          });
        }
      }

      if (responses.length === 0) {
        res.writeHead(202);
        res.end();
        return;
      }
      const out = responses.length === 1 && msgs.length === 1 ? responses[0] : responses;
      // Streamable HTTP clients may expect a session id header. We are stateless,
      // so echo the incoming one (if any) and mint one on initialize.
      const incomingSid = req.headers["mcp-session-id"];
      const sid =
        typeof incomingSid === "string" && incomingSid
          ? incomingSid
          : msgs.some((m) => m.method === "initialize")
            ? randomUUID()
            : undefined;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (sid) headers["Mcp-Session-Id"] = sid;
      res.writeHead(200, headers);
      res.end(JSON.stringify(out));
    });
  });

  server.listen(port, host);
  return server;
}

export function startStdio(client: LogseqClient): void {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msgs: JsonRpcMsg[];
    try {
      const parsed = JSON.parse(trimmed);
      msgs = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }) + "\n");
      return;
    }

    const responses: JsonRpcResp[] = [];
    for (const msg of msgs) {
      try {
        const resp = await processMessage(msg, client);
        if (resp) responses.push(resp);
      } catch (err) {
        responses.push({
          jsonrpc: "2.0",
          id: msg.id ?? null,
          error: { code: -32603, message: `Internal error: ${(err as Error).message}` },
        });
      }
    }

    for (const resp of responses) {
      process.stdout.write(JSON.stringify(resp) + "\n");
    }
  });

  rl.on("close", () => {
    // Do not exit here: in-flight async tool calls must still be flushed to
    // stdout. The process ends naturally once stdin is drained and no work
    // remains on the event loop.
  });
}
