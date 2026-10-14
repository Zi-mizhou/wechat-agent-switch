import fs from "node:fs";
import path from "node:path";

export class Logger {
  constructor(private readonly filePath: string) {}

  info(message: string): void {
    this.write("INFO", message);
  }

  warn(message: string): void {
    this.write("WARN", message);
  }

  error(message: string): void {
    this.write("ERROR", message);
  }

  private write(level: string, message: string): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const line = `${new Date().toISOString()} ${level} ${message}\n`;
    fs.appendFileSync(this.filePath, line, "utf8");
    if (process.env.CODEX_WEIXIN_FOREGROUND === "1") {
      process.stderr.write(line);
    }
  }
}
