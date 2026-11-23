// Visa Coach: local server. Listens on 127.0.0.1 only.
import http from "node:http";
import { readFile, writeFile, readdir, mkdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { VISAS, PERSONAS, AREAS, visaById } from "./lib/visas.js";
import { officerTurn, buildReport, extractCase, MAX_TURNS } from "./lib/officer.js";
import { createDocStore } from "./lib/docs.js";
import { claudeInfo, ClaudeError } from "./lib/claude.js";
import { transcribe, loadWhisper, sttStatus, textMetrics } from "./lib/stt.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.VISA_COACH_DATA || path.join(here, "data");
const SESSIONS = path.join(DATA, "sessions");
const PROFILE = path.join(DATA, "profile.json");
const PUBLIC = path.join(here, "public");
const PORT = Number(process.env.PORT || 5178);

await mkdir(SESSIONS, { recursive: true });
const docs = createDocStore(DATA);
await docs.init();

// ---------- storage ----------

const readJson = async (f, fallback) => {
  try { return JSON.parse(await readFile(f, "utf8")); } catch { return fallback; }
};
const writeJson = (f, data) => writeFile(f, JSON.stringify(data, null, 2), "utf8");
const sessionFile = (id) => path.join(SESSIONS, `${id.replace(/[^a-f0-9-]/gi, "")}.json`);
const loadSession = (id) => readJson(sessionFile(id), null);
const saveSession = (s) => writeJson(sessionFile(s.id), s);

const DEFAULT_PROFILE = {
  visaId: "us-f1", consulate: "", name: "", nationality: "", purpose: "", funding: "",
  ties: "", background: "", travel: "", refusals: "", worries: "", docFacts: "",
};

function summary(s) {
  const v = visaById(s.profile.visaId);
  return {
    id: s.id,
    createdAt: s.createdAt,
    visa: `${v.country} · ${v.name}`,
    persona: s.options.persona,
    drillArea: s.options.drillArea || null,
    status: s.status,
    decision: s.decision || s.report?.decision || null,
    answers: s.turns.filter((t) => t.role === "applicant").length,
    score: s.report?.overall_score ?? null,
    areas: s.report ? Object.fromEntries(s.report.areas.map((a) => [a.key, a.score])) : null,
  };
}

// ---------- officer helpers ----------

const busy = new Set();

async function runOfficer(s) {
  const r = await officerTurn(s);
  const lastAnswer = [...s.turns].reverse().find((t) => t.role === "applicant");
  if (lastAnswer && r.private_read) {
    lastAnswer.officerRead = r.private_read;
    lastAnswer.officerEffect = r.last_answer_effect;
  }
  s.turns.push({ role: "officer", text: r.say, probing: r.probing, at: Date.now(), ms: r.ms });
  if (r.interview_over) {
    s.status = "decided";
    s.decision = r.decision === "none" ? "administrative_processing" : r.decision;
    s.endedAt = Date.now();
  }
}

// ---------- http ----------

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function body(req, limit = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, "Upload too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
const jsonBody = async (req) => {
  const b = await body(req, 2 * 1024 * 1024);
  if (!b.length) return {};
  try { return JSON.parse(b.toString("utf8")); } catch { throw new HttpError(400, "Invalid JSON"); }
};

function send(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};

async function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === "/") p = "/index.html";
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC) || !existsSync(file) || !(await stat(file)).isFile()) {
    res.writeHead(404); return res.end("Not found");
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
  res.end(await readFile(file));
}

const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern}$`), fn });

route("GET", "/api/meta", async () => ({
  visas: VISAS, personas: PERSONAS, areas: AREAS, maxTurns: MAX_TURNS,
  claude: claudeInfo(), stt: sttStatus(),
}));

route("GET", "/api/profile", async () => ({ ...DEFAULT_PROFILE, ...(await readJson(PROFILE, {})) }));
route("PUT", "/api/profile", async (req) => {
  const b = await jsonBody(req);
  const old = await readJson(PROFILE, {});
  const p = { ...DEFAULT_PROFILE, autoFilled: old.autoFilled || {}, docInsights: old.docInsights || null };
  for (const k of Object.keys(DEFAULT_PROFILE)) if (typeof b[k] === "string") p[k] = b[k].slice(0, 8000);
  await writeJson(PROFILE, p);
  return p;
});

// documents: one CV, one SOP, any number of other files
route("GET", "/api/docs", async () => docs.list());
route("POST", "/api/docs/(cv|sop|other)", async (req, m) => {
  const name = decodeURIComponent(req.headers["x-filename"] || "");
  try {
    return await docs.add(m[1], name, await body(req));
  } catch (e) {
    throw e instanceof HttpError ? e : new HttpError(400, e.message);
  }
});
route("DELETE", "/api/docs/(cv|sop|other)/(.+)", async (req, m) => {
  await docs.remove(m[1], decodeURIComponent(m[2]));
  return { ok: true };
});

// Read the documents and fill the case file. A field is overwritten only if it is
// empty or still holds what the last read put there, so anything you typed stays.
route("POST", "/api/docs/extract", async () => {
  const files = await docs.readable();
  if (!files.cv.length && !files.sop.length && !files.other.length) {
    throw new HttpError(400, "Upload your CV or statement of purpose first.");
  }
  const p = { ...DEFAULT_PROFILE, ...(await readJson(PROFILE, {})) };
  const auto = { ...(p.autoFilled || {}) };
  const typed = Object.fromEntries(Object.keys(DEFAULT_PROFILE)
    .filter((k) => !["visaId", "docFacts"].includes(k) && p[k]?.trim() && p[k].trim() !== auto[k])
    .map((k) => [k, p[k].trim()]));
  const r = await extractCase(DATA, files, VISAS, typed);
  const filled = [], kept = [];
  for (const [k, v] of Object.entries(r.fields)) {
    const val = String(v || "").trim();
    if (!val) continue;
    const cur = String(p[k] || "").trim();
    const untouched = !cur || cur === auto[k] || (k === "visaId" && !auto[k] && cur === DEFAULT_PROFILE.visaId);
    if (untouched) { p[k] = val; auto[k] = val; filled.push(k); }
    else if (cur !== val) kept.push(k);
  }
  p.docFacts = r.facts;
  auto.docFacts = r.facts;
  p.autoFilled = auto;
  p.docInsights = { missing: r.missing, watchOut: r.watch_out, filled, kept, at: Date.now() };
  await writeJson(PROFILE, p);
  return p;
});

// speech
route("POST", "/api/stt/load", async () => {
  loadWhisper().catch(() => {});
  return sttStatus();
});
route("GET", "/api/stt", async () => sttStatus());
route("POST", "/api/transcribe", async (req) => {
  const b = await body(req);
  if (b.length < 3200 || b.length % 4) throw new HttpError(400, "Expected 16 kHz mono float32 audio.");
  const pcm = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  return transcribe(pcm);
});

// sessions
route("GET", "/api/sessions", async () => {
  const files = (await readdir(SESSIONS)).filter((f) => f.endsWith(".json"));
  const all = (await Promise.all(files.map((f) => readJson(path.join(SESSIONS, f), null)))).filter(Boolean);
  return all.sort((a, b) => b.createdAt - a.createdAt).map(summary);
});

route("POST", "/api/sessions", async (req) => {
  const b = await jsonBody(req);
  const { autoFilled, docInsights, ...saved } = await readJson(PROFILE, {});
  const profile = { ...DEFAULT_PROFILE, ...saved };
  if (!profile.purpose && !profile.docFacts) {
    throw new HttpError(400, "Upload your CV and statement of purpose (or fill in your purpose) so the officer has a case to read.");
  }
  const s = {
    id: randomUUID(),
    createdAt: Date.now(),
    profile,
    options: {
      persona: PERSONAS[b.persona] ? b.persona : "neutral",
      drillArea: AREAS.some((a) => a.key === b.drillArea) ? b.drillArea : null,
      inputMode: b.inputMode === "text" ? "text" : "voice",
    },
    status: "active",
    turns: [],
  };
  await runOfficer(s);
  await saveSession(s);
  return s;
});

route("GET", "/api/sessions/([a-f0-9-]+)", async (req, m) => {
  const s = await loadSession(m[1]);
  if (!s) throw new HttpError(404, "Session not found");
  return s;
});

route("DELETE", "/api/sessions/([a-f0-9-]+)", async (req, m) => {
  await rm(sessionFile(m[1]), { force: true });
  return { ok: true };
});

route("POST", "/api/sessions/([a-f0-9-]+)/answer", async (req, m) => {
  const b = await jsonBody(req);
  const text = String(b.text || "").trim().slice(0, 4000);
  if (!text) throw new HttpError(400, "Empty answer");
  if (busy.has(m[1])) throw new HttpError(409, "The officer is still responding.");
  busy.add(m[1]);
  try {
    const s = await loadSession(m[1]);
    if (!s) throw new HttpError(404, "Session not found");
    if (s.status !== "active") throw new HttpError(409, "This interview is over.");
    const metrics = { ...textMetrics(text), ...(b.metrics || {}) };
    metrics.words = textMetrics(text).words;
    if (typeof b.startDelaySec === "number") metrics.startDelaySec = b.startDelaySec;
    s.turns.push({ role: "applicant", text, metrics, at: Date.now() });
    await runOfficer(s);
    await saveSession(s);
    return s;
  } finally {
    busy.delete(m[1]);
  }
});

route("POST", "/api/sessions/([a-f0-9-]+)/end", async (req, m) => {
  const s = await loadSession(m[1]);
  if (!s) throw new HttpError(404, "Session not found");
  if (s.status === "active") {
    s.status = "ended";
    s.endedAt = Date.now();
    await saveSession(s);
  }
  return s;
});

route("POST", "/api/sessions/([a-f0-9-]+)/report", async (req, m) => {
  if (busy.has(m[1])) throw new HttpError(409, "Already working on this session.");
  busy.add(m[1]);
  try {
    const s = await loadSession(m[1]);
    if (!s) throw new HttpError(404, "Session not found");
    if (!s.turns.some((t) => t.role === "applicant")) throw new HttpError(400, "Answer at least one question first.");
    if (s.status === "active") { s.status = "ended"; s.endedAt = Date.now(); }
    s.report = await buildReport(s);
    await saveSession(s);
    return s;
  } finally {
    busy.delete(m[1]);
  }
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (!url.pathname.startsWith("/api/")) return await serveStatic(req, res, url);
    for (const r of routes) {
      const m = r.method === req.method && url.pathname.match(r.re);
      if (m) return send(res, 200, await r.fn(req, m));
    }
    throw new HttpError(404, "No such endpoint");
  } catch (e) {
    const status = e instanceof HttpError ? e.status : e instanceof ClaudeError ? 502 : 500;
    if (status >= 500) console.error(e);
    send(res, status, { error: e.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Visa Coach running at http://localhost:${PORT}`);
  console.log(`Officer: ${claudeInfo().model} via ${claudeInfo().bin}`);
  // Warm up Whisper in the background so the first answer is quick.
  if (process.env.VISA_COACH_NO_WARMUP !== "1") loadWhisper().then(
    () => console.log("Speech recognition ready."),
    (e) => console.error("Speech recognition failed to load:", e.message),
  );
});
