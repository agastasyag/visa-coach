// Visa Coach front end. Plain JS, no build step.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function api(method, path, body, raw) {
  const r = await fetch(path, {
    method,
    headers: raw ? raw.headers : body ? { "content-type": "application/json" } : {},
    body: raw ? raw.body : body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

const store = {
  get(k, d) { try { const v = localStorage.getItem(`vc.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`vc.${k}`, JSON.stringify(v)); } catch { /* private mode */ } },
};

const DECISIONS = {
  approved: "Approved",
  refused: "Refused",
  administrative_processing: "Administrative processing",
  incomplete: "No decision (ended early)",
};

let meta, session = null, timerId = null, officerDoneAt = 0;

// ---------------- views ----------------

function show(view) {
  $$("nav button").forEach((b) => (b.dataset.view === view ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
  $$(".view").forEach((v) => (v.hidden = v.id !== `view-${view}`));
  if (view === "history") renderHistory();
  window.scrollTo({ top: 0 });
}
$$("nav button").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));

// ---------------- case file ----------------

const form = $("#profile");
let saveTimer;

let autoFilled = {};
function fillProfile(p) {
  autoFilled = p.autoFilled || {};
  for (const [k, v] of Object.entries(p)) {
    const el = form.elements[k] || document.querySelector(`[name="${k}"]`);
    if (el && typeof v === "string") el.value = v;
  }
  markAuto();
  renderInsights(p.docInsights);
}
// Tag fields whose value still matches what Claude read from the documents.
function markAuto() {
  for (const el of form.elements) {
    const label = el.name && el.closest("label");
    if (!label) continue;
    const isAuto = !!autoFilled[el.name] && el.value.trim() === autoFilled[el.name];
    let chip = label.querySelector(".auto-chip");
    if (isAuto && !chip) {
      chip = document.createElement("span");
      chip.className = "auto-chip";
      chip.textContent = "from your documents";
      label.insertBefore(chip, el);
    } else if (!isAuto && chip) chip.remove();
  }
}
form.addEventListener("input", markAuto);
form.addEventListener("change", markAuto);
function readProfile() {
  const out = {};
  for (const el of [...form.elements, document.querySelector('[name="docFacts"]')]) {
    if (el?.name) out[el.name] = el.value;
  }
  return out;
}
function queueSave() {
  clearTimeout(saveTimer);
  $("#savedNote").textContent = "Saving…";
  saveTimer = setTimeout(saveProfile, 500);
}
async function saveProfile() {
  clearTimeout(saveTimer);
  await api("PUT", "/api/profile", readProfile());
  $("#savedNote").textContent = "Saved on this computer.";
}
form.addEventListener("input", queueSave);
$('[name="docFacts"]').addEventListener("input", queueSave);

// documents: CV and SOP slots (one file each) plus any other documents
const FIELD_LABELS = {
  visaId: "Visa", consulate: "Consulate", name: "Name", nationality: "Nationality", purpose: "Purpose",
  funding: "Funding", ties: "Ties at home", background: "Background", travel: "Travel history", refusals: "Previous refusals",
};
let docs = [], reading = false;

const kb = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);
const fileRow = (d) => `<li><span>${esc(d.name)} <span class="muted small">${kb(d.size)}</span></span>
  <button type="button" data-del="${esc(d.kind)}/${esc(d.name)}" aria-label="Remove ${esc(d.name)}">✕</button></li>`;

async function refreshDocs() {
  docs = await api("GET", "/api/docs");
  for (const slot of $$(".slot")) {
    const kind = slot.dataset.kind;
    const mine = docs.filter((d) => d.kind === kind);
    if (kind === "other") {
      $(".doclist", slot).innerHTML = mine.map(fileRow).join("");
      continue;
    }
    const box = $(".slot-file", slot);
    box.hidden = !mine.length;
    $(".drop", slot).classList.toggle("has-file", !!mine.length);
    $(".drop-empty", slot).innerHTML = mine.length ? "Drop a new file to <u>replace it</u>" : `Drop your ${kind === "cv" ? "CV" : "SOP"} here or <u>choose a file</u>`;
    box.innerHTML = mine.length ? `<ul class="doclist">${mine.map(fileRow).join("")}</ul>` : "";
  }
  $("#extractBtn").disabled = reading || !docs.length;
  if (!docs.length && !reading) $("#extractStatus").textContent = "Nothing uploaded yet.";
  else if (!reading && !$("#extractStatus").dataset.keep) $("#extractStatus").textContent = "";
}

$(".uploads").addEventListener("click", async (e) => {
  const key = e.target.closest("[data-del]")?.dataset.del;
  if (!key) return;
  e.preventDefault();
  const [kind, ...rest] = key.split("/");
  await api("DELETE", `/api/docs/${kind}/${encodeURIComponent(rest.join("/"))}`);
  refreshDocs();
});

async function uploadFiles(kind, files) {
  let ok = 0;
  for (const f of [...files].slice(0, kind === "other" ? 20 : 1)) {
    try {
      await api("POST", `/api/docs/${kind}`, null, {
        headers: { "x-filename": encodeURIComponent(f.name), "content-type": "application/octet-stream" },
        body: f,
      });
      ok++;
    } catch (e) {
      $("#extractStatus").textContent = `${f.name}: ${e.message}`;
      $("#extractStatus").dataset.keep = "1";
    }
  }
  await refreshDocs();
  delete $("#extractStatus").dataset.keep;
  // A new CV or SOP changes the whole case file, so read it straight away.
  if (ok && kind !== "other") readDocuments();
  else if (ok) $("#extractStatus").textContent = "Added. Press “Fill my case file” to read it.";
}

for (const slot of $$(".slot")) {
  const kind = slot.dataset.kind, drop = $(".drop", slot), input = $("input[type=file]", slot);
  input.addEventListener("change", () => { uploadFiles(kind, input.files); input.value = ""; });
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); uploadFiles(kind, e.dataTransfer.files); });
}

let readAgain = false;
async function readDocuments() {
  // A file added mid-read gets its own read once this one finishes.
  if (reading) { readAgain = true; return; }
  reading = true;
  readAgain = false;
  const btn = $("#extractBtn"), status = $("#extractStatus");
  btn.disabled = true;
  btn.textContent = "Reading…";
  const t0 = Date.now();
  const tick = setInterval(() => {
    status.textContent = `Claude is reading your documents… ${Math.round((Date.now() - t0) / 1000)}s (usually under a minute)`;
  }, 1000);
  try {
    await saveProfile();
    const before = readProfile();
    const p = await api("POST", "/api/docs/extract");
    // Apply only what Claude filled, and only where nothing was typed during the read.
    const now = readProfile();
    for (const k of [...p.docInsights.filled, "docFacts"]) {
      const el = form.elements[k];
      if (el && now[k] === before[k]) el.value = p[k];
    }
    autoFilled = p.autoFilled || {};
    markAuto();
    renderInsights(p.docInsights);
    await saveProfile();
    const n = p.docInsights?.filled.length || 0;
    status.textContent = n ? `Filled in ${n} field${n === 1 ? "" : "s"}. Check them below.` : "Read. Nothing new to fill in.";
  } catch (e) {
    status.textContent = `Couldn't read the documents: ${e.message}`;
  } finally {
    clearInterval(tick);
    reading = false;
    btn.textContent = "Fill my case file";
    btn.disabled = !docs.length;
  }
  if (readAgain) readDocuments();
}
$("#extractBtn").addEventListener("click", readDocuments);

function renderInsights(ins) {
  const box = $("#insights");
  if (!ins || !(ins.missing?.length || ins.watchOut?.length || ins.kept?.length)) { box.hidden = true; return; }
  const list = (items) => `<ul class="tight">${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
  box.hidden = false;
  box.innerHTML = `<div class="cols">
    ${ins.missing?.length ? `<div class="note warn"><h3>Your documents don't say</h3>
      <p class="muted small">The officer will ask anyway. Add these to the case file below.</p>${list(ins.missing)}</div>` : ""}
    ${ins.watchOut?.length ? `<div class="note"><h3>What the officer may push on</h3>${list(ins.watchOut)}</div>` : ""}
  </div>
  ${ins.kept?.length ? `<p class="muted small">Kept what you typed for ${ins.kept.map((k) => FIELD_LABELS[k] || k).join(", ")}, though your documents say something different. Clear a field to let Claude fill it.</p>` : ""}`;
}

// settings
const settings = ["persona", "drill", "inputMode", "voiceSelect", "reviewTranscript"];
function loadSettings() {
  for (const id of settings) {
    const el = $(`#${id}`), v = store.get(id, null);
    if (v == null) continue;
    if (el.type === "checkbox") el.checked = v; else el.value = v;
  }
}
for (const id of settings) {
  $(`#${id}`).addEventListener("change", (e) => {
    store.set(id, e.target.type === "checkbox" ? e.target.checked : e.target.value);
    if (id === "inputMode") updateSttStatus();
  });
}

// officer voice (browser speech synthesis; Windows voices run locally)
function loadVoices() {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
  const sel = $("#voiceSelect");
  const keep = store.get("voiceSelect", null);
  sel.innerHTML = `<option value="">Off (text only)</option>` + voices
    .map((v) => `<option value="${esc(v.voiceURI)}">${esc(v.name)}${v.localService ? "" : " (online)"}</option>`)
    .join("");
  if (keep != null && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
  else {
    const local = voices.find((v) => v.localService && /en-US/.test(v.lang)) || voices.find((v) => v.localService);
    if (local) sel.value = local.voiceURI;
  }
}
if ("speechSynthesis" in window) {
  loadVoices();
  speechSynthesis.addEventListener("voiceschanged", loadVoices);
}

function speak(text) {
  const uri = $("#voiceSelect").value;
  const badge = $("#officerBadge");
  if (!uri || !("speechSynthesis" in window)) { officerDoneAt = performance.now(); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.voice = speechSynthesis.getVoices().find((v) => v.voiceURI === uri) || null;
  u.rate = 1.02;
  badge.classList.add("speaking");
  u.onend = u.onerror = () => { badge.classList.remove("speaking"); officerDoneAt = performance.now(); };
  officerDoneAt = performance.now() + 60_000; // until it finishes
  speechSynthesis.speak(u);
}

// ---------------- interview ----------------

$("#startBtn").addEventListener("click", startInterview);

async function startInterview() {
  const btn = $("#startBtn");
  $("#startError").textContent = "";
  btn.disabled = true;
  btn.textContent = "The officer is reading your file…";
  try {
    await saveProfile();
    session = await api("POST", "/api/sessions", {
      persona: $("#persona").value,
      drillArea: $("#drill").value || null,
      inputMode: $("#inputMode").value,
    });
    show("interview");
    setupAnswerControls();
    renderInterview();
    startTimer();
    speak(lastOfficer().text);
  } catch (e) {
    $("#startError").textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Step up to the window";
  }
}

const lastOfficer = () => [...session.turns].reverse().find((t) => t.role === "officer");

function startTimer() {
  clearInterval(timerId);
  const t0 = session.createdAt;
  timerId = setInterval(() => {
    const end = session.endedAt || Date.now();
    const s = Math.max(0, Math.floor((end - t0) / 1000));
    $("#timer").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }, 500);
}

function setupAnswerControls() {
  const voice = session.options.inputMode === "voice";
  $("#voiceControls").hidden = !voice;
  $("#answerText").placeholder = voice
    ? "Your transcribed answer appears here"
    : "Type your answer and press Enter";
  $("#heardNote").textContent = "";
  $("#interviewError").textContent = "";
}

function metaLine(m) {
  if (!m) return "";
  const bits = [`${m.words} words`];
  if (m.durationSec) bits.push(`${m.durationSec.toFixed(0)}s`);
  if (m.wpm) bits.push(`${m.wpm} wpm`);
  if (m.startDelaySec != null) bits.push(`started after ${m.startDelaySec.toFixed(1)}s`);
  if (m.longPauses) bits.push(`${m.longPauses} long pause${m.longPauses > 1 ? "s" : ""}`);
  return bits.join(" · ");
}

function renderInterview() {
  const over = session.status !== "active";
  $("#officerLine").textContent = lastOfficer()?.text || "";
  $("#transcript").innerHTML = session.turns
    .map((t) => t.role === "officer"
      ? `<li class="officer"><span class="who">Officer</span>${esc(t.text)}</li>`
      : `<li><span class="who">You</span>${esc(t.text)}<div class="meta">${esc(metaLine(t.metrics))}</div></li>`)
    .join("");
  $("#answerText").disabled = over;
  $("#sendBtn").disabled = over;
  $("#micBtn").disabled = over;
  $("#endBtn").textContent = over ? "See the debrief" : "Walk away & get report";
  $("#endBtn").className = over ? "primary" : "ghost";
  if (over) clearInterval(timerId);
}

$("#textForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("#answerText").value.trim();
  if (text) sendAnswer(text, pendingMetrics);
});
$("#answerText").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#textForm").requestSubmit(); }
});
let typingStartedAt = null;
$("#answerText").addEventListener("input", () => { typingStartedAt ??= performance.now(); });

let pendingMetrics = null;

async function sendAnswer(text, metrics) {
  if (!session || session.status !== "active") return;
  // Start delay only means something for spoken answers.
  const startDelaySec = metrics?.startDelaySec;
  $("#interviewError").textContent = "";
  // Show the answer immediately while the officer reads it.
  session.turns.push({ role: "applicant", text, metrics: { words: text.split(/\s+/).length, ...(metrics || {}) } });
  renderInterview();
  $("#thinking").hidden = false;
  $("#sendBtn").disabled = true;
  $("#micBtn").disabled = true;
  try {
    session = await api("POST", `/api/sessions/${session.id}/answer`, { text, metrics, startDelaySec });
    $("#answerText").value = "";
    $("#heardNote").textContent = "";
    pendingMetrics = null;
    typingStartedAt = null;
    renderInterview();
    speak(lastOfficer().text);
  } catch (e) {
    session.turns.pop();
    renderInterview();
    $("#answerText").value = text;
    $("#interviewError").textContent = e.message;
  } finally {
    $("#thinking").hidden = true;
    if (session.status === "active") { $("#sendBtn").disabled = false; $("#micBtn").disabled = false; }
  }
}

$("#endBtn").addEventListener("click", async () => {
  if (!session) return;
  const answered = session.turns.some((t) => t.role === "applicant");
  if (!answered) { show("setup"); return; }
  const btn = $("#endBtn");
  btn.disabled = true;
  btn.textContent = "Writing your debrief (about a minute)…";
  speechSynthesis?.cancel();
  try {
    session = await api("POST", `/api/sessions/${session.id}/report`);
    renderInterview();
    renderReport(session);
    show("report");
  } catch (e) {
    $("#interviewError").textContent = e.message;
  } finally {
    btn.disabled = false;
    renderInterview();
  }
});

// ---------------- microphone ----------------

const rec = { ctx: null, stream: null, node: null, chunks: [], on: false, startedAt: 0, raf: 0, analyser: null };

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
}
registerProcessor("tap", Tap);`;

async function ensureMic() {
  if (rec.ctx) return;
  rec.stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  rec.ctx = new AudioContext();
  await rec.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" })));
  const src = rec.ctx.createMediaStreamSource(rec.stream);
  rec.node = new AudioWorkletNode(rec.ctx, "tap");
  rec.node.port.onmessage = (e) => { if (rec.on) rec.chunks.push(e.data); };
  rec.analyser = rec.ctx.createAnalyser();
  rec.analyser.fftSize = 512;
  src.connect(rec.analyser);
  src.connect(rec.node);
}

async function startRecording() {
  if (rec.on || !session || session.status !== "active" || $("#micBtn").disabled) return;
  try {
    await ensureMic();
  } catch (e) {
    $("#interviewError").textContent = `Microphone unavailable: ${e.message}. You can switch to typing in the case file settings.`;
    return;
  }
  speechSynthesis?.cancel();
  if (rec.ctx.state === "suspended") await rec.ctx.resume();
  rec.chunks = [];
  rec.on = true;
  rec.startedAt = performance.now();
  $("#micBtn").setAttribute("aria-pressed", "true");
  $("#micLabel").textContent = "Listening… click or release Space to finish";
  drawLevel();
}

async function stopRecording() {
  if (!rec.on) return;
  rec.on = false;
  cancelAnimationFrame(rec.raf);
  clearLevel();
  $("#micBtn").setAttribute("aria-pressed", "false");
  const pressDelay = officerDoneAt ? Math.max(0, (rec.startedAt - officerDoneAt) / 1000) : 0;
  const len = rec.chunks.reduce((n, c) => n + c.length, 0);
  if (len < rec.ctx.sampleRate * 0.4) {
    $("#micLabel").textContent = "Too short. Click or hold Space to answer";
    return;
  }
  const pcm = new Float32Array(len);
  let off = 0;
  for (const c of rec.chunks) { pcm.set(c, off); off += c.length; }
  $("#micLabel").textContent = "Transcribing on this computer…";
  $("#micBtn").disabled = true;
  try {
    const pcm16 = await resample(pcm, rec.ctx.sampleRate, 16000);
    const tr = await api("POST", "/api/transcribe", null, {
      headers: { "content-type": "application/octet-stream" },
      body: pcm16.buffer,
    });
    if (!tr.text) throw new Error("Didn't catch that. Try again, a little closer to the mic.");
    const metrics = { ...tr.metrics, startDelaySec: pressDelay + (tr.metrics.leadSilenceSec || 0) };
    $("#heardNote").textContent = "What the officer heard:";
    if ($("#reviewTranscript").checked) {
      $("#answerText").value = tr.text;
      pendingMetrics = metrics;
      $("#answerText").focus();
    } else {
      await sendAnswer(tr.text, metrics);
    }
  } catch (e) {
    $("#interviewError").textContent = e.message;
  } finally {
    if (session.status === "active") $("#micBtn").disabled = false;
    $("#micLabel").textContent = "Click or hold Space to answer";
  }
}

async function resample(pcm, from, to) {
  if (from === to) return pcm;
  const frames = Math.ceil((pcm.length * to) / from);
  const off = new OfflineAudioContext(1, frames, to);
  const buf = off.createBuffer(1, pcm.length, from);
  buf.copyToChannel(pcm, 0);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0);
}

const canvas = $("#level");
const g = canvas.getContext("2d");
function drawLevel() {
  const data = new Uint8Array(rec.analyser.fftSize);
  const color = getComputedStyle(document.documentElement).getPropertyValue("--bad").trim() || "red";
  const tick = () => {
    rec.analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128);
    const w = canvas.width, h = canvas.height;
    g.clearRect(0, 0, w, h);
    g.fillStyle = color;
    g.fillRect(0, h / 2 - 2, Math.max(4, w * Math.min(1, peak * 2.2)), 4);
    const secs = (performance.now() - rec.startedAt) / 1000;
    $("#micLabel").textContent = `Listening… ${secs.toFixed(0)}s · click or release Space to finish`;
    rec.raf = requestAnimationFrame(tick);
  };
  tick();
}
function clearLevel() { g.clearRect(0, 0, canvas.width, canvas.height); }

$("#micBtn").addEventListener("click", () => (rec.on ? stopRecording() : startRecording()));
const typingTarget = (el) => el.closest("input, textarea, select, [contenteditable]");
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || e.repeat || typingTarget(e.target) || $("#view-interview").hidden) return;
  if (session?.options.inputMode !== "voice") return;
  e.preventDefault();
  startRecording();
});
document.addEventListener("keyup", (e) => {
  if (e.code !== "Space" || typingTarget(e.target) || !rec.on) return;
  e.preventDefault();
  stopRecording();
});

// ---------------- report ----------------

const areaLabel = (k) => meta.areas.find((a) => a.key === k)?.label || k;

function renderReport(s) {
  const r = s.report;
  if (!r) { $("#reportBody").innerHTML = `<div class="card empty">No report for this interview yet.</div>`; return; }
  const answersGiven = s.turns.filter((t) => t.role === "applicant");
  const level = (n) => (n <= 4 ? "low" : n <= 6 ? "mid" : "high");
  const visa = meta.visas.find((v) => v.id === s.profile.visaId);

  $("#reportBody").innerHTML = `
    <div class="card verdict ${esc(r.decision)}">
      <div class="score">${r.overall_score}<small>/100</small></div>
      <div>
        <div class="decision">${esc(DECISIONS[r.decision] || r.decision)}</div>
        <div class="muted small">${esc(visa ? `${visa.country} · ${visa.name}` : "")} · ${new Date(s.createdAt).toLocaleString()}</div>
      </div>
      <p class="basis">${esc(r.decision_basis)}</p>
    </div>

    <div class="cols">
      <div class="card">
        <h2>Readiness by area</h2>
        <div class="areas">${r.areas.map((a) => `
          <div class="area-row">
            <span>${esc(areaLabel(a.key))}</span>
            <div class="bar ${level(a.score)}"><span style="width:${a.score * 10}%"></span></div>
            <b>${a.score}/10</b>
            <p class="area-note">${esc(a.verdict)} <span class="read">“${esc(a.evidence)}”</span></p>
          </div>`).join("")}
        </div>
      </div>
      <div class="card">
        <h2>Fix these first</h2>
        <ol class="tight">${r.top_fixes.map((f) => `<li>${esc(f)}</li>`).join("")}</ol>
        <h3 style="margin-top:1rem">Delivery</h3>
        <p>${esc(r.delivery.summary)}</p>
        <ul class="tight">${r.delivery.tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
        ${r.document_conflicts.length ? `<h3 style="margin-top:1rem">Doesn't match your documents</h3>
          <ul class="tight">${r.document_conflicts.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}
        <div class="actions" style="margin-top:1rem">
          <button class="primary" id="drillBtn">Drill: ${esc(areaLabel(r.next_drill.area))}</button>
          <button class="ghost" id="againBtn">Full interview again</button>
        </div>
        <p class="muted small">${esc(r.next_drill.why)}</p>
      </div>
    </div>

    <div class="card">
      <h2>Answer by answer <span class="muted small">with what the officer was thinking</span></h2>
      ${r.answers.map((a, i) => {
        const given = answersGiven[i];
        return `<div class="qa">
          <div class="q">${esc(a.question)} <span class="pill ${esc(a.effect)}">${esc(a.effect)}</span></div>
          ${given ? `<div class="a">${esc(given.text)}<div class="meta">${esc(metaLine(given.metrics))}</div></div>` : ""}
          ${given?.officerRead ? `<div class="read">Officer, privately: ${esc(given.officerRead)}</div>` : ""}
          <div>${esc(a.why)}</div>
          ${a.better_shape ? `<div class="better"><b>Stronger shape:</b> ${esc(a.better_shape)}</div>` : ""}
        </div>`;
      }).join("")}
    </div>`;

  $("#drillBtn").addEventListener("click", () => { $("#drill").value = r.next_drill.area; startInterview(); });
  $("#againBtn").addEventListener("click", () => { $("#drill").value = ""; startInterview(); });
}

// ---------------- history ----------------

async function renderHistory() {
  const list = await api("GET", "/api/sessions");
  const scored = list.filter((s) => s.score != null).reverse(); // oldest first
  $("#trend").innerHTML = scored.length
    ? `<div class="trend">${[{ key: "overall", label: "Overall" }, ...meta.areas].map((a) => {
        const vals = scored.map((s) => (a.key === "overall" ? s.score / 10 : s.areas?.[a.key] ?? 0));
        const last = vals.at(-1);
        return `<div class="trend-item"><div class="muted small">${esc(a.label)}</div>
          <b>${a.key === "overall" ? Math.round(last * 10) : last}</b><span class="muted small">${a.key === "overall" ? "/100" : "/10"}</span>
          <div class="spark">${vals.slice(-12).map((v) => `<i style="height:${Math.max(4, v * 10)}%"></i>`).join("")}</div></div>`;
      }).join("")}</div>`
    : `<p class="muted">Scores appear here after your first debrief.</p>`;

  $("#historyList").innerHTML = list.length
    ? `<table><thead><tr><th>When</th><th>Visa</th><th>Officer</th><th>Answers</th><th>Decision</th><th>Score</th><th></th></tr></thead><tbody>
      ${list.map((s) => `<tr>
        <td>${new Date(s.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</td>
        <td>${esc(s.visa)}${s.drillArea ? ` <span class="muted small">(drill: ${esc(areaLabel(s.drillArea))})</span>` : ""}</td>
        <td>${esc(s.persona)}</td>
        <td>${s.answers}</td>
        <td>${esc(DECISIONS[s.decision] || (s.status === "active" ? "In progress" : "—"))}</td>
        <td>${s.score ?? "—"}</td>
        <td><button data-open="${s.id}">${s.score != null ? "Report" : s.answers ? "Get report" : ""}</button>
            <button data-delete="${s.id}" aria-label="Delete">Delete</button></td>
      </tr>`).join("")}</tbody></table>`
    : `<p class="muted">No interviews yet.</p>`;
}

$("#historyList").addEventListener("click", async (e) => {
  const open = e.target.closest("[data-open]")?.dataset.open;
  const del = e.target.closest("[data-delete]")?.dataset.delete;
  if (del && confirm("Delete this interview and its report?")) {
    await api("DELETE", `/api/sessions/${del}`);
    return renderHistory();
  }
  if (!open) return;
  let s = await api("GET", `/api/sessions/${open}`);
  if (!s.report) {
    e.target.textContent = "Writing…";
    try { s = await api("POST", `/api/sessions/${open}/report`); }
    catch (err) { alert(err.message); return renderHistory(); }
  }
  renderReport(s);
  show("report");
});

// ---------------- speech recognition status ----------------

async function updateSttStatus() {
  const el = $("#status");
  if ($("#inputMode").value !== "voice") { el.textContent = `Officer: ${meta.claude.model}`; return; }
  const st = await api("GET", "/api/stt").catch(() => ({ status: "error", error: "server unreachable" }));
  const text = { idle: "Speech recognition: not loaded", loading: "Speech recognition: loading (first run downloads ~100 MB)…",
    ready: "Speech recognition: ready, on this computer", error: `Speech recognition failed: ${st.error}` }[st.status];
  el.textContent = text;
  // Not loaded, or failed at server start: ask the server to (re)load it, once per page.
  if (st.status === "idle" || (st.status === "error" && !updateSttStatus.retried)) {
    updateSttStatus.retried = st.status === "error";
    await api("POST", "/api/stt/load").catch(() => {});
    return setTimeout(updateSttStatus, 1000);
  }
  if (st.status === "idle" || st.status === "loading") setTimeout(updateSttStatus, 2000);
}

// ---------------- boot ----------------

(async function boot() {
  meta = await api("GET", "/api/meta");
  const byCountry = Object.groupBy
    ? Object.groupBy(meta.visas, (v) => v.country)
    : meta.visas.reduce((m, v) => ((m[v.country] ||= []).push(v), m), {});
  $("#visaSelect").innerHTML = Object.entries(byCountry)
    .map(([c, vs]) => `<optgroup label="${esc(c)}">${vs.map((v) => `<option value="${v.id}">${esc(v.name)}</option>`).join("")}</optgroup>`)
    .join("");
  $("#drill").innerHTML = `<option value="">Full interview</option>` +
    meta.areas.map((a) => `<option value="${a.key}">Drill: ${esc(a.label)}</option>`).join("");
  fillProfile(await api("GET", "/api/profile"));
  loadSettings();
  refreshDocs();
  updateSttStatus();

  // Resume an unfinished interview, or show the latest report.
  const list = await api("GET", "/api/sessions");
  const active = list.find((s) => s.status === "active");
  if (active) {
    session = await api("GET", `/api/sessions/${active.id}`);
    setupAnswerControls();
    renderInterview();
    startTimer();
  }
  const latest = list.find((s) => s.score != null);
  if (latest) renderReport(await api("GET", `/api/sessions/${latest.id}`));
})().catch((e) => {
  $("#status").textContent = `Could not reach the local server: ${e.message}`;
});
