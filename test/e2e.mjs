// End-to-end check: starts its own server on a spare port with a throwaway
// data folder, runs a short interview (one spoken answer on Windows, the rest
// typed), and builds the report. Uses real Claude calls.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = mkdtempSync(path.join(os.tmpdir(), "visa-coach-test-"));
const PORT = 5199;
const base = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, ["server.js"], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), VISA_COACH_DATA: dataDir, VISA_COACH_NO_WARMUP: "1" },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((ok) => server.stdout.on("data", (d) => String(d).includes("running") && ok()));

const api = async (method, p, body, raw) => {
  const r = await fetch(base + p, {
    method,
    headers: raw ? { "content-type": "application/octet-stream" } : { "content-type": "application/json" },
    body: raw ? body : body && JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${j.error}`);
  return j;
};
const t0 = Date.now();
const lap = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

function wavToFloat32(file) {
  const b = readFileSync(file);
  let off = 12, fmt, data;
  while (off < b.length) {
    const id = b.toString("ascii", off, off + 4), size = b.readUInt32LE(off + 4);
    if (id === "fmt ") fmt = { ch: b.readUInt16LE(off + 10), rate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === "data") data = b.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size % 2);
  }
  if (fmt.rate !== 16000 || fmt.ch !== 1 || fmt.bits !== 16) throw new Error(`Unexpected WAV format ${JSON.stringify(fmt)}`);
  const out = new Float32Array(data.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = data.readInt16LE(i * 2) / 32768;
  return out;
}

try {
  await api("PUT", "/api/profile", {
    visaId: "us-f1",
    consulate: "US Consulate, Chennai",
    name: "Test Applicant",
    nationality: "India",
    purpose: "MS in Computer Science, Purdue University, Fall 2027. Admitted with I-20.",
    funding: "Father (civil engineer, ~INR 30 lakh/yr) pays; INR 45 lakh education loan from SBI sanctioned.",
    ties: "Parents and younger sister in Bengaluru; family-owned flat; job offer letter interest from Bengaluru firm after graduation.",
    background: "B.Tech CSE 2025, 8.4 CGPA; 1 year as software engineer at a Bengaluru startup.",
  });
  console.log(lap(), "profile saved");

  let s = await api("POST", "/api/sessions", { persona: "neutral" });
  console.log(lap(), "OFFICER:", s.turns.at(-1).text);

  // Spoken answer (Windows: synthesise with the built-in voice, then run local Whisper on it).
  let firstAnswer = "I am going to Purdue University for a master's in computer science.";
  let metrics = {};
  if (process.platform === "win32") {
    const wav = path.join(dataDir, "answer.wav");
    execFileSync("powershell", ["-NoProfile", "-Command", `
      Add-Type -AssemblyName System.Speech
      $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
      $f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
      $s.SetOutputToWaveFile('${wav}', $f)
      $s.Speak('${firstAnswer.replace(/'/g, "''")}')
      $s.Dispose()`]);
    const pcm = wavToFloat32(wav);
    console.log(lap(), `transcribing ${(pcm.length / 16000).toFixed(1)}s of audio (first run downloads Whisper)...`);
    const tr = await api("POST", "/api/transcribe", Buffer.from(pcm.buffer), true);
    console.log(lap(), `WHISPER (${tr.ms} ms):`, tr.text, JSON.stringify(tr.metrics));
    firstAnswer = tr.text;
    metrics = tr.metrics;
  }

  const answers = [
    firstAnswer,
    "Purdue has a strong systems and distributed computing group, and I worked on backend infrastructure at my startup, so I want to go deeper there.",
    "My father is paying, and we also have a sanctioned education loan of 45 lakh rupees from SBI.",
    "I will come back to Bengaluru. My parents are there, and the tech industry there is growing fast.",
  ];
  for (const text of answers) {
    if (s.status !== "active") break;
    console.log(lap(), "APPLICANT:", text);
    s = await api("POST", `/api/sessions/${s.id}/answer`, { text, metrics, startDelaySec: 1.2 });
    metrics = {};
    const a = s.turns.filter((t) => t.role === "applicant").at(-1);
    console.log(lap(), `  (officer's private read: ${a.officerRead} [${a.officerEffect}])`);
    console.log(lap(), "OFFICER:", s.turns.at(-1).text);
  }

  s = await api("POST", `/api/sessions/${s.id}/report`);
  const r = s.report;
  console.log(lap(), `REPORT: ${r.decision}, score ${r.overall_score}`);
  console.log("  basis:", r.decision_basis);
  for (const a of r.areas) console.log(`  ${a.key}: ${a.score}/10 — ${a.verdict}`);
  console.log("  top fixes:", r.top_fixes);
  console.log("  next drill:", r.next_drill);

  const list = await api("GET", "/api/sessions");
  if (list.length !== 1 || list[0].score !== r.overall_score) throw new Error("history listing mismatch");
  console.log(lap(), "PASS");
} catch (e) {
  console.error("FAIL:", e.message);
  process.exitCode = 1;
} finally {
  server.kill();
  rmSync(dataDir, { recursive: true, force: true });
}
