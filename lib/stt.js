// Local speech-to-text (Whisper via transformers.js on the CPU) and simple
// delivery analysis. Audio never leaves this machine.
import path from "node:path";
import os from "node:os";
import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const MODEL_DIR = process.env.VISA_COACH_MODELS ||
  path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".cache"), "visa-coach", "models");
export const WHISPER_MODEL = process.env.VISA_COACH_WHISPER || "onnx-community/whisper-base.en";
export const SAMPLE_RATE = 16000;

let pipePromise = null;
let status = "idle"; // idle | loading | ready | error
let lastError = "";

export function sttStatus() {
  return { status, model: WHISPER_MODEL, error: lastError };
}

// Errors that mean the model files on disk are unreadable or incomplete.
const BROKEN_FILE = /protobuf parsing failed|invalid (onnx )?model|doesn't exist|no such file|unexpected end|corrupt/i;

/** Create the Whisper pipeline, downloading the model on first use. */
export async function openWhisper() {
  const { pipeline, env } = await import("@huggingface/transformers");
  // A short path: model file paths are deep, and Windows refuses paths over 260 characters.
  env.cacheDir = MODEL_DIR;
  return pipeline("automatic-speech-recognition", WHISPER_MODEL, {
    dtype: { encoder_model: "fp32", decoder_model_merged: "q8" },
    device: "cpu",
  });
}

// Try opening the model in a throwaway process (lib/stt-check.js).
function checkInChild() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./stt-check.js", import.meta.url))], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => resolve({ ok: false, error: e.message }));
    child.on("exit", (code) => resolve({ ok: code === 0, error: err.trim().split("\n").pop() || `exit ${code}` }));
  });
}

// Two quirks of transformers.js 3.8.1 decide how this works:
// - It loads a downloaded file before it has finished writing it, so the first load
//   after any download can fail with "Protobuf parsing failed" on a file that ends up fine.
// - After one failed load, that model never loads again in the same process.
// So the model is checked (and downloaded or repaired) in a short-lived child process,
// and this process only opens it once a clean load has worked.
// Child attempts: 1 load/download · 2 retry · 3 files damaged → delete, download again · 4 load.
async function ensureModelFiles() {
  for (let attempt = 1; ; attempt++) {
    const r = await checkInChild();
    if (r.ok) return;
    if (attempt === 4 || (attempt >= 2 && !BROKEN_FILE.test(r.error))) throw new Error(r.error);
    if (attempt === 2) {
      console.warn("Speech model files look damaged. Downloading them again (~100 MB)…");
      await rm(path.join(MODEL_DIR, ...WHISPER_MODEL.split("/")), { recursive: true, force: true });
    }
  }
}

export function loadWhisper() {
  if (pipePromise) return pipePromise;
  status = "loading";
  lastError = "";
  pipePromise = (async () => {
    await ensureModelFiles();
    const pipe = await openWhisper();
    status = "ready";
    return pipe;
  })().catch((e) => {
    status = "error";
    lastError = e.message;
    pipePromise = null;
    throw e;
  });
  return pipePromise;
}

const FILLERS = /\b(um+|uh+|erm|er|hmm+|you know|i mean|basically|kind of|sort of)\b/gi;

/** Pause analysis on 16 kHz mono float PCM using 20 ms frame energy. */
export function analyseAudio(pcm) {
  const frame = SAMPLE_RATE / 50; // 20 ms
  const n = Math.floor(pcm.length / frame);
  const rms = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * frame; j < (i + 1) * frame; j++) s += pcm[j] * pcm[j];
    rms[i] = Math.sqrt(s / frame);
  }
  const sorted = Array.from(rms).sort((a, b) => a - b);
  const noise = sorted[Math.floor(n * 0.1)] || 0;
  const peak = sorted[Math.floor(n * 0.95)] || 0;
  const thresh = Math.max(0.008, noise + (peak - noise) * 0.15);
  const voiced = Array.from(rms, (r) => r > thresh);
  const first = voiced.indexOf(true);
  const last = voiced.lastIndexOf(true);
  if (first < 0) return { leadSilenceSec: pcm.length / SAMPLE_RATE, speechSec: 0, longPauses: 0, longestPauseSec: 0 };
  let pauses = 0, longest = 0, run = 0;
  for (let i = first; i <= last; i++) {
    if (!voiced[i]) run++;
    else {
      const sec = run / 50;
      if (sec >= 1.2) pauses++;
      longest = Math.max(longest, sec);
      run = 0;
    }
  }
  return {
    leadSilenceSec: first / 50,
    speechSec: (last - first + 1) / 50,
    longPauses: pauses,
    longestPauseSec: longest,
  };
}

export function textMetrics(text) {
  const words = (text.match(/[A-Za-z0-9'’-]+/g) || []).length;
  const fillers = (text.match(FILLERS) || []).length;
  return { words, fillers };
}

/** @param {Float32Array} pcm 16 kHz mono */
export async function transcribe(pcm) {
  const pipe = await loadWhisper();
  const started = Date.now();
  const out = await pipe(pcm, { chunk_length_s: 30, stride_length_s: 5 });
  const text = (Array.isArray(out) ? out.map((o) => o.text).join(" ") : out.text)
    .replace(/\s+/g, " ")
    .replace(/\[(BLANK_AUDIO|MUSIC|NOISE)\]/gi, "")
    .trim();
  const audio = analyseAudio(pcm);
  const t = textMetrics(text);
  return {
    text,
    ms: Date.now() - started,
    metrics: {
      words: t.words,
      fillers: t.fillers,
      durationSec: audio.speechSec,
      wpm: audio.speechSec > 1 ? Math.round((t.words / audio.speechSec) * 60) : null,
      leadSilenceSec: audio.leadSilenceSec,
      longPauses: audio.longPauses,
      longestPauseSec: audio.longestPauseSec,
    },
  };
}
