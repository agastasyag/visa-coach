// The officer: prompts and output schemas for each Claude call.
import { askClaude } from "./claude.js";
import { visaById, PERSONAS, AREAS } from "./visas.js";

export const MAX_TURNS = 14; // applicant answers before the officer must decide

const AREA_KEYS = AREAS.map((a) => a.key);

// ---------- case file ----------

export function caseFileText(profile) {
  const v = visaById(profile.visaId);
  const lines = [
    `Visa: ${v.country}, ${v.name}`,
    profile.consulate && `Consulate / place of interview: ${profile.consulate}`,
    profile.name && `Applicant name: ${profile.name}`,
    profile.nationality && `Nationality / home country: ${profile.nationality}`,
    profile.purpose && `Purpose (school, program, trip, job): ${profile.purpose}`,
    profile.funding && `Funding and sponsor: ${profile.funding}`,
    profile.ties && `Ties at home (family, job, property, plans): ${profile.ties}`,
    profile.background && `Education and work background: ${profile.background}`,
    profile.travel && `Travel history: ${profile.travel}`,
    profile.refusals && `Previous refusals: ${profile.refusals}`,
    profile.worries && `What the applicant is worried about: ${profile.worries}`,
    profile.docFacts && `Facts from the applicant's own documents (CV, statement of purpose, official papers). Official papers are what the officer sees on screen; the CV and SOP are what the applicant has already claimed, so spoken answers that contradict them are a credibility problem:\n${profile.docFacts}`,
  ].filter(Boolean);
  return lines.join("\n");
}

// ---------- officer turn ----------

const TURN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    say: { type: "string", description: "Exactly what the officer says out loud next." },
    private_read: { type: "string", description: "The officer's private, unspoken read of the applicant's LAST answer (1-2 sentences). Empty on the opening line." },
    last_answer_effect: { type: "string", enum: ["helped", "neutral", "hurt", "none"] },
    probing: { type: "string", enum: [...AREA_KEYS, "other"] },
    interview_over: { type: "boolean" },
    decision: { type: "string", enum: ["none", "approved", "refused", "administrative_processing"] },
  },
  required: ["say", "private_read", "last_answer_effect", "probing", "interview_over", "decision"],
};

function officerSystem(profile, opts) {
  const v = visaById(profile.visaId);
  const persona = PERSONAS[opts.persona] || PERSONAS.neutral;
  const drill = opts.drillArea
    ? `\nDRILL MODE: this is a practice drill. Spend most questions on "${AREAS.find((a) => a.key === opts.drillArea)?.label || opts.drillArea}", from several angles, with hard follow-ups. Do not end before 6 questions.`
    : "";
  return `You are a visa officer conducting a real ${v.country} ${v.name} interview. This is a practice simulation for the applicant, so it must feel exactly like the real thing.

Persona: ${persona}

What officers for this visa usually probe: ${v.focus}.
Refusal basis when you refuse: ${v.law}.

How you behave:
- Speak like a real officer at the window: short, plain, one question at a time, usually under 20 words. No coaching, no feedback, no praise, no explanations of the rules.
- Open the way a real interview opens (greeting or a document request plus the first question), not with small talk.
- Listen to the actual answers. Follow up on anything vague, rehearsed-sounding, inconsistent with earlier answers, or inconsistent with the case file. If an answer is long or rambling (each answer comes with its length and duration), cut in: "Okay. Just tell me..." and ask for the short version.
- If the applicant contradicts the case file or a document, ask about it directly, the way an officer reading the screen would.
- You may decide early when the case is clearly strong or clearly weak; real interviews are often 2-4 minutes. Otherwise decide after roughly 6-12 questions. You must decide by question ${MAX_TURNS}.
- When you decide, set interview_over to true and set decision. Say the decision the way an officer would: approval ("Your visa is approved. You'll get your passport back in a few days.") or refusal (hand over the refusal sheet citing ${v.law}, one sentence on the reason, without lecturing). Use administrative_processing only when something genuinely needs checking.
- Judge only on what was said and what is in the case file. Never invent facts about the applicant.

private_read is your honest internal thought about the last answer, as an officer, e.g. "Can't name a single course in the program. Sounds like the agent picked the school." It is shown to the applicant only after the interview.
${drill}

CASE FILE (what you see on your screen):
${caseFileText(profile)}`;
}

export function transcriptText(turns) {
  return turns
    .map((t) => {
      if (t.role === "officer") return `OFFICER: ${t.text}`;
      const m = t.metrics;
      const meta = m
        ? ` [${[
            `${m.words} words`,
            m.durationSec ? `${m.durationSec.toFixed(0)}s spoken` : "typed",
            m.wpm ? `${m.wpm} wpm` : null,
            m.startDelaySec != null ? `started after ${m.startDelaySec.toFixed(1)}s` : null,
            m.longPauses ? `${m.longPauses} long pauses` : null,
            m.fillers ? `${m.fillers} filler words` : null,
          ].filter(Boolean).join(", ")}]`
        : "";
      return `APPLICANT${meta}: ${t.text}`;
    })
    .join("\n");
}

export async function officerTurn(session) {
  const answers = session.turns.filter((t) => t.role === "applicant").length;
  const mustDecide = answers >= MAX_TURNS;
  const prompt = session.turns.length
    ? `Transcript so far:\n${transcriptText(session.turns)}\n\n${mustDecide ? "This is the last answer you will take. Decide now." : "Your next line."}`
    : "The applicant has just stepped up to the window. Your opening line.";
  const { data, ms } = await askClaude({
    system: officerSystem(session.profile, session.options),
    prompt,
    schema: TURN_SCHEMA,
    effort: "low",
  });
  if (mustDecide && !data.interview_over) {
    data.interview_over = true;
    if (data.decision === "none") data.decision = "administrative_processing";
  }
  return { ...data, ms };
}

// ---------- report ----------

const REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: { type: "string", enum: ["approved", "refused", "administrative_processing", "incomplete"] },
    decision_basis: { type: "string", description: "The real reason behind the decision, in 2-3 sentences, as the officer would note it." },
    overall_score: { type: "integer", minimum: 0, maximum: 100 },
    areas: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: { type: "string", enum: AREA_KEYS },
          score: { type: "integer", minimum: 0, maximum: 10 },
          verdict: { type: "string", description: "One sentence." },
          evidence: { type: "string", description: "A short quote or paraphrase from the transcript that shows it." },
        },
        required: ["key", "score", "verdict", "evidence"],
      },
    },
    answers: {
      type: "array",
      description: "One entry per applicant answer, in order.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          question: { type: "string" },
          effect: { type: "string", enum: ["helped", "neutral", "hurt"] },
          why: { type: "string", description: "What the officer heard, in one or two sentences." },
          better_shape: { type: "string", description: "How a stronger answer would be built, using only facts the applicant actually has. Empty if the answer was already good." },
        },
        required: ["question", "effect", "why", "better_shape"],
      },
    },
    document_conflicts: { type: "array", items: { type: "string" } },
    delivery: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: { type: "string" },
        tips: { type: "array", items: { type: "string" } },
      },
      required: ["summary", "tips"],
    },
    top_fixes: { type: "array", items: { type: "string" }, description: "The 3 changes that would most improve the next interview." },
    next_drill: {
      type: "object",
      additionalProperties: false,
      properties: {
        area: { type: "string", enum: AREA_KEYS },
        why: { type: "string" },
      },
      required: ["area", "why"],
    },
  },
  required: ["decision", "decision_basis", "overall_score", "areas", "answers", "document_conflicts", "delivery", "top_fixes", "next_drill"],
};

export async function buildReport(session) {
  const v = visaById(session.profile.visaId);
  const system = `You are a former senior ${v.country} visa officer now coaching applicants for a ${v.name} interview. You review a practice interview transcript and write a candid debrief.

Rules:
- Score each of these areas 0-10: ${AREAS.map((a) => `${a.key} (${a.label})`).join(", ")}. If an area never came up, score it from what little was shown and say it was not tested.
- overall_score 0-100 is how likely this exact performance is to be approved, not effort.
- For each applicant answer, say whether it helped, was neutral or hurt, and why, from the officer's side of the window.
- better_shape describes how to build a stronger answer: order, length, what to lead with, which real fact to mention. Use only facts in the case file or the applicant's own answers. Never suggest inventing, exaggerating or hiding facts; if a real weakness exists, show how to explain it honestly and briefly.
- Delivery: use the answer lengths, durations, start delays and pause counts given with each answer. Officers react badly to long, rehearsed or hesitant answers.
- document_conflicts lists any place where an answer contradicts the case file or documents. Empty if none.
- If the interview ended before a decision, use decision "incomplete" and judge what is there.

CASE FILE:
${caseFileText(session.profile)}`;

  const privateReads = session.turns
    .filter((t) => t.role === "applicant")
    .map((t, i) => `Answer ${i + 1}: ${t.officerRead || "(no note)"} [${t.officerEffect || "?"}]`)
    .join("\n");

  const prompt = `Interview transcript:\n${transcriptText(session.turns)}\n\nOfficer's private notes during the interview:\n${privateReads || "(none)"}\n\nOfficer's decision at the window: ${session.decision || "none"}\n\nWrite the debrief.`;
  const { data, ms } = await askClaude({ system, prompt, schema: REPORT_SCHEMA, effort: "medium", timeoutMs: 300_000 });
  return { ...data, ms };
}

// ---------- document extraction ----------

// ---------- reading the applicant's documents ----------

const FIELD_HELP = {
  visaId: "Which visa this is for, from the list of ids. Infer it from the destination country and what they will do there (e.g. a master's in the US -> us-f1). Empty if unclear.",
  consulate: "Consulate or city of interview, only if a document states it. Empty otherwise.",
  name: "Full name as written.",
  nationality: "Country of citizenship or home country.",
  purpose: "School, program, start term and duration (or trip / job), in one or two lines.",
  funding: "Who pays, how much, from where (sponsor, loan, scholarship, assistantship, savings) with exact figures and currency.",
  ties: "Family, job, property, and their stated plans after the program, especially what the SOP says about returning home or the career they want and where.",
  background: "Education (degree, institution, year, grades) and work (role, employer, dates), plus notable projects or publications, in a few compact lines.",
  travel: "Countries visited and when, only if stated.",
  refusals: "Previous visa refusals, only if stated. Empty otherwise; never write 'none' unless a document says so.",
};
const PROFILE_KEYS = Object.keys(FIELD_HELP);

const DOCS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    facts: {
      type: "string",
      description: "Bullet list, one fact per line starting with '- [CV] ', '- [SOP] ' or '- [<document type>] '. Include the claims the applicant will be held to: program, school, dates, grades, jobs and dates, figures, why this program/school, career goals and where they want to work. Quote figures exactly.",
    },
    fields: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(PROFILE_KEYS.map((k) => [k, { type: "string", description: FIELD_HELP[k] }])),
      required: PROFILE_KEYS,
    },
    missing: {
      type: "array",
      items: { type: "string" },
      description: "Things the officer will certainly ask about that none of the documents answer, phrased as short prompts for the applicant (e.g. 'Who pays for the program and how much?'). At most 6.",
    },
    watch_out: {
      type: "array",
      items: { type: "string" },
      description: "Specific things in these documents an officer could push on, each with the line it comes from: gaps in dates, a switch of field, an SOP that talks about building a career abroad (immigrant intent), claims that don't match between CV and SOP, vague funding. At most 6. Empty if none.",
    },
  },
  required: ["facts", "fields", "missing", "watch_out"],
};

/**
 * Read the CV, statement of purpose and other documents and deduce the case file.
 * @param {string} dataDir  folder Claude may read (files are given relative to it)
 * @param {{cv:string[], sop:string[], other:string[]}} files
 * @param {{id:string,country:string,name:string}[]} visas
 * @param {Record<string,string>} typed  fields the applicant already typed in themselves
 */
export async function extractCase(dataDir, files, visas, typed = {}) {
  const system = `You prepare a visa applicant's case file from their own documents: a CV / resume, a statement of purpose (SOP), and possibly official documents (I-20, DS-2019, CAS, admission letters, bank or loan letters, sponsor letters, employment letters, itineraries).
Read every file listed with the Read tool, then fill the case file.
Rules:
- Use only what the documents say. Never invent figures, names, dates or plans. Leave a field empty when no document supports it.
- Write fields in the applicant's own plain terms, short enough to read at a glance: notes without pronouns (never "she"/"he"/"they"), and no remarks about what is missing (that goes in missing).
- Write missing and watch_out to the applicant, as "you".
- The SOP is what the applicant has told the school; an officer expects spoken answers to match it. Pull out its reasons for the program and school, its career goals, and anything about where they plan to live and work afterwards.
- If a file can't be read, say so in facts.
Visa ids: ${visas.map((v) => `${v.id} (${v.country}, ${v.name})`).join("; ")}.`;
  const group = (label, list) =>
    list.length ? `${label}:\n${list.map((f) => `- ${f}`).join("\n")}` : `${label}: (none uploaded)`;
  const prompt = [
    "Files, relative to the current directory:",
    group("CV / resume", files.cv),
    group("Statement of purpose", files.sop),
    group("Other documents", files.other),
    Object.keys(typed).length
      ? `Already in the case file, typed by the applicant. Fields must still come only from the documents: leave a field empty if no document supports it, and never copy these values into fields. Don't list them as missing, and flag anything the documents contradict:\n${Object.entries(typed).map(([k, v]) => `- ${k}: ${v}`).join("\n")}`
      : "",
  ].filter(Boolean).join("\n\n");
  const { data } = await askClaude({
    system,
    prompt,
    schema: DOCS_SCHEMA,
    effort: "medium",
    tools: ["Read"],
    cwd: dataDir,
    timeoutMs: 300_000,
  });
  if (!visas.some((v) => v.id === data.fields.visaId)) data.fields.visaId = "";
  return data;
}
