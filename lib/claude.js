// Runs Claude through the Claude Code CLI you are already signed in to
// (`claude -p`), so no API key is needed. Every call is one headless turn
// with no tools (unless asked) and a JSON schema for the reply.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

export const MODEL = process.env.VISA_COACH_MODEL || "claude-opus-5-5";

function findClaude() {
  if (process.env.CLAUDE_BIN) return { cmd: process.env.CLAUDE_BIN, shell: false };
  if (process.platform === "win32") {
    const exe = path.join(
      process.env.APPDATA || "",
      "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe",
    );
    if (existsSync(exe)) return { cmd: exe, shell: false };
    const local = path.join(os.homedir(), ".local", "bin", "claude.exe");
    if (existsSync(local)) return { cmd: local, shell: false };
  }
  return { cmd: "claude", shell: false };
}

const CLAUDE = findClaude();
const TMP = path.join(os.tmpdir(), "visa-coach");
mkdirSync(TMP, { recursive: true });

export class ClaudeError extends Error {}

/**
 * One headless Claude turn.
 * @param {object} o
 * @param {string} o.system   system prompt
 * @param {string} o.prompt   user message (sent on stdin)
 * @param {object} o.schema   JSON schema the reply must match
 * @param {string} [o.effort] low | medium | high
 * @param {string[]} [o.tools] built-in tools to allow (default none)
 * @param {string} [o.cwd]    working directory (Read is confined to it)
 * @param {number} [o.timeoutMs]
 * @returns {Promise<{data: object, ms: number, costUsd: number}>}
 */
export function askClaude({ system, prompt, schema, effort = "low", tools = [], cwd, timeoutMs = 180_000 }) {
  const sysFile = path.join(TMP, `sys-${randomUUID()}.txt`);
  writeFileSync(sysFile, system, "utf8");
  const args = [
    "-p",
    "--output-format", "json",
    "--model", MODEL,
    "--effort", effort,
    "--no-session-persistence",
    "--safe-mode",
    "--system-prompt-file", sysFile,
    "--json-schema", JSON.stringify(schema),
    "--tools", tools.join(","),
  ];
  if (tools.length) args.push("--allowed-tools", tools.join(","), "--permission-prompts", "none");
  const started = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE.cmd, args, {
      cwd: cwd || TMP,
      shell: CLAUDE.shell,
      windowsHide: true,
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "visa-coach" },
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new ClaudeError(`Claude took longer than ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new ClaudeError(
        `Could not start Claude Code (${CLAUDE.cmd}). Install it and sign in with \`claude\`, ` +
        `or set CLAUDE_BIN to its path. ${e.message}`,
      ));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      rmSync(sysFile, { force: true });
      let res;
      try {
        res = JSON.parse(out);
      } catch {
        return reject(new ClaudeError(`Claude returned no JSON (exit ${code}). ${err.slice(0, 500) || out.slice(0, 500)}`));
      }
      if (res.is_error || res.subtype !== "success") {
        return reject(new ClaudeError(`Claude error: ${res.result || res.subtype || "unknown"}`));
      }
      let data = res.structured_output;
      if (!data) {
        try { data = JSON.parse(res.result); } catch { /* fall through */ }
      }
      if (!data) return reject(new ClaudeError("Claude's reply did not match the expected format."));
      resolve({ data, ms: Date.now() - started, costUsd: res.total_cost_usd || 0 });
    });
    child.stdin.end(prompt, "utf8");
  });
}

export function claudeInfo() {
  return { bin: CLAUDE.cmd, model: MODEL };
}
