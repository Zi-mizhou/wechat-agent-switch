import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type JsonRpcMessage = {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: NodeJS.Timeout;
};

export class JsonRpcProcess extends EventEmitter {
  private proc?: ChildProcessWithoutNullStreams;
  private seq = 1;
  private pending = new Map<string | number, Pending>();
  private buffer = "";

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
  ) {
    super();
  }

  start(): void {
    if (this.proc) return;
    this.proc = spawn(this.command, this.args, {
      cwd: this.options.cwd,
      windowsHide: true,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => this.onData(String(chunk)));
    this.proc.stderr.on("data", (chunk) => this.emit("stderr", String(chunk)));
    this.proc.on("exit", (code, signal) => {
      this.emit("exit", { code, signal });
      for (const item of this.pending.values()) {
        clearTimeout(item.timeout);
        item.reject(new Error(`JSON-RPC process exited: code=${code} signal=${signal}`));
      }
      this.pending.clear();
      this.proc = undefined;
    });
  }

  stop(): void {
    this.proc?.kill("SIGTERM");
  }

  async request<T>(method: string, params: unknown = {}, timeoutMs = 120_000): Promise<T> {
    this.start();
    const id = this.seq++;
    const msg = { jsonrpc: "2.0", id, method, params };
    this.emit("request", { id, method });
    const p = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout });
    });
    this.writeMessage(msg);
    return p;
  }

  respond(id: string | number, result: unknown): void {
    this.start();
    this.writeMessage({ jsonrpc: "2.0", id, result });
  }

  private writeMessage(msg: unknown): void {
    const raw = JSON.stringify(msg);
    // Codex app-server currently accepts newline-delimited JSON-RPC on stdio.
    // Keeping this in one place makes it easy to swap to Content-Length framing
    // if a future protocol revision requires it.
    this.proc?.stdin.write(`${raw}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const idx = this.buffer.indexOf("\n");
      if (idx < 0) break;
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        this.handleMessage(JSON.parse(line) as JsonRpcMessage);
      } catch (err) {
        this.emit("parseError", { line, err });
      }
    }
  }

  private handleMessage(msg: JsonRpcMessage): void {
    if (msg.id != null && (Object.prototype.hasOwnProperty.call(msg, "result") || msg.error)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timeout);
      this.emit("response", { id: msg.id, error: Boolean(msg.error) });
      if (msg.error) pending.reject(new JsonRpcError(msg.error));
      else pending.resolve(msg.result);
      return;
    }
    if (msg.method && msg.id != null) {
      this.emit("serverRequest", msg);
      return;
    }
    if (msg.method) {
      this.emit("notification", msg);
    }
  }
}

class JsonRpcError extends Error {
  constructor(readonly detail: unknown) {
    super(formatJsonRpcError(detail));
    this.name = "JsonRpcError";
  }
}

function formatJsonRpcError(detail: unknown): string {
  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return String(detail);
  }
}
