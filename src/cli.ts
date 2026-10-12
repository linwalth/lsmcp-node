import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LogseqClient } from "./client";
import { startHttpServer, startStdio } from "./transports";

const TRANSPORTS = ["stdio", "sse", "streamable-http"];

function tokenCachePath(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "lsmcp", "token");
}

function cacheToken(token: string): string {
  const filePath = tokenCachePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(path.dirname(filePath), 0o700);
  } catch {
    /* best effort */
  }
  fs.writeFileSync(filePath, token, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* best effort */
  }
  return filePath;
}

function clearCachedToken(): boolean {
  const filePath = tokenCachePath();
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}

function loadCachedToken(): string | null {
  const filePath = tokenCachePath();
  if (!fs.existsSync(filePath)) return null;
  try {
    const token = fs.readFileSync(filePath, "utf-8").trim();
    return token || null;
  } catch {
    return null;
  }
}

interface Args {
  login: boolean;
  logout: boolean;
  transport: string;
  host: string;
  port: number;
}

function usage(prog: string): string {
  return `usage: ${prog} [options]

Node MCP server for Logseq.

options:
  --login               Prompt for the Logseq API token, cache it to ~/.config/lsmcp/token (0600), then exit.
  --logout              Forget the cached Logseq API token, then exit.
  --transport <t>       MCP transport: stdio | http | streamable-http | sse (default: http, or MCP_TRANSPORT)
  --host <host>         Bind host for http transports (default: 127.0.0.1, or MCP_HOST)
  --port <port>         Bind port for http transports (default: 8765, or MCP_PORT)
  -h, --help            Show this help and exit

environment:
  LOGSEQ_API_TOKEN          Logseq API token (required unless cached via --login)
  LOGSEQ_API_URL            Logseq API base URL (default: http://127.0.0.1:12315)
  LOGSEQ_CACHE_TTL_SECONDS  Read-response cache TTL (default: 60, 0 disables)
  LOGSEQ_API_TIMEOUT        API request timeout in seconds (default: 30)`;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    login: false,
    logout: false,
    transport: process.env.MCP_TRANSPORT || "http",
    host: process.env.MCP_HOST || "127.0.0.1",
    port: parseInt(process.env.MCP_PORT || "8765", 10),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--login":
        args.login = true;
        break;
      case "--logout":
        args.logout = true;
        break;
      case "--transport":
        args.transport = argv[++i] ?? "";
        break;
      case "--host":
        args.host = argv[++i] ?? "";
        break;
      case "--port":
        args.port = parseInt(argv[++i] ?? "", 10);
        break;
      case "-h":
      case "--help":
        process.stdout.write(usage(path.basename(process.argv[1] || "lsmcp-node")) + "\n");
        process.exit(0);
      default:
        process.stderr.write(`unknown argument: ${arg}\n`);
        process.exit(2);
    }
  }

  if (args.login && args.logout) {
    process.stderr.write("--login and --logout are mutually exclusive\n");
    process.exit(2);
  }
  return args;
}

async function promptToken(): Promise<string> {
  return new Promise((resolve) => {
    const rl = require("node:readline").createInterface({ input: process.stdin, output: process.stderr });
    rl.question("Paste your Logseq API token: ", (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const prog = path.basename(process.argv[1] || "lsmcp-node");

  if (args.login) {
    const token = await promptToken();
    if (!token) {
      process.stderr.write("token must not be empty\n");
      process.exit(1);
    }
    const filePath = cacheToken(token);
    process.stderr.write(`Cached token to ${filePath}\n`);
    return;
  }

  if (args.logout) {
    const removed = clearCachedToken();
    process.stderr.write(removed ? "removed\n" : "nothing to remove (no cached token)\n");
    return;
  }

  const token = process.env.LOGSEQ_API_TOKEN || loadCachedToken();
  if (!token) {
    process.stderr.write(
      "LOGSEQ_API_TOKEN is required. Set it in your environment, run '" + prog + " --login' to cache it, or set LOGSEQ_API_TOKEN.\n",
    );
    process.exit(1);
  }
  process.env.LOGSEQ_API_TOKEN = token;

  const transport = args.transport === "http" ? "streamable-http" : args.transport;
  if (!TRANSPORTS.includes(transport)) {
    process.stderr.write(`unknown transport: ${args.transport}\n`);
    process.exit(2);
  }

  let client: LogseqClient;
  try {
    client = new LogseqClient();
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }

  if (transport === "stdio") {
    startStdio(client);
    return;
  }

  if (transport === "sse") {
    process.stderr.write("sse transport is not supported by lsmcp-node; use http (streamable-http) or stdio.\n");
    process.exit(2);
  }

  const server = startHttpServer(args.host, args.port, client);
  server.on("error", (err: Error) => {
    process.stderr.write(`server error: ${err.message}\n`);
    process.exit(1);
  });
  process.stderr.write(`lsmcp-node listening on http://${args.host}:${args.port}/mcp\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exit(1);
});
