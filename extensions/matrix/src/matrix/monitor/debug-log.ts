import fs from "node:fs";

const DEBUG_LOG_PATH = "/home/keller/clawd/agents/mondo-assistant/debug-matrix.log";

export function debugLog(message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${message}\n`;
  try {
    fs.appendFileSync(DEBUG_LOG_PATH, line);
  } catch {
    // Ignore errors
  }
}
