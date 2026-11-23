// Document check: builds a sample Word CV and a PDF statement of purpose for a
// made-up applicant, uploads them to a throwaway server, and checks that Claude
// fills in the case file, flags what's missing, and never overwrites typed fields.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { crc32, deflateRawSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { docxText } from "../lib/docs.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = mkdtempSync(path.join(os.tmpdir(), "visa-coach-docs-"));
const PORT = 5198;
const base = `http://127.0.0.1:${PORT}`;

// ---------- fixtures ----------

function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, "utf8"), data = deflateRawSync(raw), n = Buffer.from(name);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function docx(paragraphs) {
  const x = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${x(p)}</w:t></w:r></w:p>`).join("");
  return zip({
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  });
}

function pdf(lines) {
  const esc = (s) => s.replace(/[\\()]/g, "\\$&");
  const stream = `BT /F1 10 Tf 50 780 Td 13 TL ${lines.map((l) => `(${esc(l)}) '`).join(" ")} ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offs = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const CV = docx([
  "MEERA KRISHNAN",
  "Chennai, Tamil Nadu, India | Indian citizen",
  "EDUCATION",
  "B.E. Electronics and Communication Engineering, Anna University (College of Engineering, Guindy), 2020-2024. CGPA 8.7/10",
  "EXPERIENCE",
  "Embedded Software Engineer, Zentrix Automotive Systems, Chennai. July 2024 - present",
  "Firmware for battery management systems in electric two-wheelers; cut BMS fault-detection latency by 30%.",
  "PROJECTS & PUBLICATIONS",
  "Low-power SoC power estimation tool (final-year project). Paper at IEEE VLSID 2024.",
  "TEST SCORES",
  "GRE 324 (Q 168, V 156). TOEFL iBT 111.",
]);
const SOP = pdf([
  "Statement of Purpose - Meera Krishnan",
  "Master of Science in Electrical and Computer Engineering, University of Michigan, Ann Arbor - Fall 2027",
  "",
  "Working on battery management firmware at Zentrix showed me that the hardest problems in",
  "electric vehicles are in power-efficient chip design, not software. Michigan's VLSI group,",
  "especially its work on low-power circuits, is the reason I am applying.",
  "",
  "After the MS I want to lead a power-electronics silicon team. India's semiconductor mission is",
  "creating these roles at home, and Zentrix has told me they plan to build a chip team in Chennai.",
  "I would like to gain experience at a leading US semiconductor company before that.",
]);

// ---------- run ----------

const server = spawn(process.execPath, ["server.js"], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), VISA_COACH_DATA: dataDir, VISA_COACH_NO_WARMUP: "1" },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((ok) => server.stdout.on("data", (d) => String(d).includes("running") && ok()));

const api = async (method, p, body, filename) => {
  const r = await fetch(base + p, {
    method,
    headers: filename ? { "x-filename": encodeURIComponent(filename) } : { "content-type": "application/json" },
    body: filename ? body : body && JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(`${method} ${p}: ${r.status} ${j.error}`), { status: r.status });
  return j;
};
const check = (ok, msg) => { if (!ok) throw new Error(msg); console.log("  ok:", msg); };
const t0 = Date.now();
const lap = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

try {
  check(docxText(CV).includes("Zentrix Automotive Systems"), "Word text extraction");

  // .doc is refused with a helpful message
  const bad = await api("POST", "/api/docs/cv", Buffer.from("x"), "old.doc").catch((e) => e);
  check(bad.status === 400 && /Save As/.test(bad.message), "old .doc files are refused with a fix");

  // The user typed funding before uploading anything: it must survive.
  await api("PUT", "/api/profile", { funding: "Parents' savings, INR 40 lakh" });

  await api("POST", "/api/docs/cv", CV, "Meera CV.docx");
  await api("POST", "/api/docs/sop", SOP, "SOP.pdf");
  await api("POST", "/api/docs/cv", CV, "Meera CV v2.docx"); // replaces the first CV
  const list = await api("GET", "/api/docs");
  check(list.length === 2 && list.some((d) => d.kind === "cv" && d.name === "Meera CV v2.docx"), "CV slot holds one file");

  console.log(lap(), "reading documents…");
  const p = await api("POST", "/api/docs/extract");
  console.log(lap(), "done");
  for (const k of ["visaId", "consulate", "name", "nationality", "purpose", "funding", "ties", "background", "travel", "refusals"]) {
    console.log(`  ${k.padEnd(11)} ${p.autoFilled[k] === p[k] ? "[auto]" : "      "} ${p[k]}`);
  }
  console.log("  facts:\n" + p.docFacts.split("\n").map((l) => "    " + l).join("\n"));
  console.log("  missing:", p.docInsights.missing);
  console.log("  watch out:", p.docInsights.watchOut);
  console.log("  kept:", p.docInsights.kept);

  check(p.visaId === "us-f1", "visa deduced as US F-1");
  check(/Meera/i.test(p.name) && /India/i.test(p.nationality), "name and nationality");
  check(/Michigan/i.test(p.purpose) && /Zentrix|Anna/i.test(p.background), "purpose and background");
  check(p.docInsights.kept.length === 0, `nothing reported as contradicting typed fields (${p.docInsights.kept})`);
  check(p.funding === "Parents' savings, INR 40 lakh", "typed funding was not overwritten");
  check(!p.refusals, "refusals left empty (not in documents)");
  check(!p.docInsights.missing.concat(p.docInsights.watchOut).some((m) => /who pays|no funding/i.test(m)), "typed funding not listed as missing");
  check(p.docInsights.watchOut.some((w) => /US|United States|semiconductor/i.test(w)), "flags the 'experience at a US company' line");

  // A typed field also survives a second read; an untouched auto field is refreshed.
  await api("PUT", "/api/profile", { ...p, name: "Meera K." });
  const p2 = await api("POST", "/api/docs/extract");
  check(p2.name === "Meera K.", "edited name kept on re-read");

  const s = await api("POST", "/api/sessions", { persona: "neutral" });
  check(!("autoFilled" in s.profile) && s.turns[0].text, `interview starts: "${s.turns[0].text}"`);
  console.log(lap(), "PASS");
} catch (e) {
  console.error("FAIL:", e.message);
  process.exitCode = 1;
} finally {
  server.kill();
  rmSync(dataDir, { recursive: true, force: true });
}
