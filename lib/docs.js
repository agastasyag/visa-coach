// Uploaded documents: storage by kind (CV, SOP, other) and Word (.docx) text extraction.
import { writeFile, readdir, mkdir, rm, stat, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import path from "node:path";

export const KINDS = {
  cv: { label: "CV / résumé", single: true },
  sop: { label: "Statement of purpose", single: true },
  other: { label: "Other documents", single: false },
};
export const DOC_TYPES = new Set([".pdf", ".docx", ".png", ".jpg", ".jpeg", ".txt", ".md"]);

export const docName = (n) => path.basename(String(n || "")).replace(/[^\w.\- ()]/g, "_").slice(0, 120);

export function createDocStore(dataDir) {
  const root = path.join(dataDir, "docs");
  const textRoot = path.join(dataDir, "docs-text"); // plain-text copies of .docx files, for Claude
  const dir = (kind) => path.join(root, kind);

  async function init() {
    for (const k of Object.keys(KINDS)) {
      await mkdir(dir(k), { recursive: true });
      await mkdir(path.join(textRoot, k), { recursive: true });
    }
    // Files from older versions sat directly in docs/: treat them as "other".
    for (const f of await readdir(root, { withFileTypes: true })) {
      if (f.isFile()) await rename(path.join(root, f.name), path.join(dir("other"), f.name));
    }
  }

  async function list() {
    const out = [];
    for (const kind of Object.keys(KINDS)) {
      for (const name of await readdir(dir(kind))) {
        const s = await stat(path.join(dir(kind), name));
        out.push({ kind, name, size: s.size, at: s.mtimeMs });
      }
    }
    return out;
  }

  async function remove(kind, name) {
    await rm(path.join(dir(kind), docName(name)), { force: true });
    await rm(path.join(textRoot, kind, `${docName(name)}.txt`), { force: true });
  }

  async function add(kind, rawName, buf) {
    const name = docName(rawName);
    const ext = path.extname(name).toLowerCase();
    if (!name || !DOC_TYPES.has(ext)) {
      throw new Error(ext === ".doc"
        ? "Old Word files (.doc) can't be read. In Word, use Save As → .docx or PDF and upload that."
        : "Upload a PDF, Word (.docx), image (PNG/JPG) or text file.");
    }
    let text = null;
    if (ext === ".docx") {
      text = docxText(buf);
      if (!text.trim()) throw new Error(`${name}: no text found in this Word file.`);
    }
    if (KINDS[kind].single) for (const old of await readdir(dir(kind))) await remove(kind, old);
    await writeFile(path.join(dir(kind), name), buf);
    if (text != null) await writeFile(path.join(textRoot, kind, `${name}.txt`), text, "utf8");
    return { kind, name };
  }

  // Paths relative to dataDir for Claude to Read, grouped by kind.
  async function readable() {
    const out = { cv: [], sop: [], other: [] };
    for (const d of await list()) {
      const txt = path.join("docs-text", d.kind, `${d.name}.txt`);
      out[d.kind].push(existsSync(path.join(dataDir, txt)) ? txt : path.join("docs", d.kind, d.name));
    }
    return out;
  }

  return { init, list, add, remove, readable, dataDir };
}

// ---------- .docx → text (zip + XML, no dependencies) ----------

function unzipEntry(buf, wanted) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("This doesn't look like a Word (.docx) file.");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (name === wanted) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      throw new Error("Unsupported compression in Word file.");
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

export function docxText(buf) {
  const xml = unzipEntry(buf, "word/document.xml");
  if (!xml) throw new Error("This doesn't look like a Word (.docx) file.");
  return xml.toString("utf8")
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
      const named = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }[e.toLowerCase()];
      if (named) return named;
      return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

