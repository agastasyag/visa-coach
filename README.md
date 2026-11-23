# Visa Coach

Local visa interview practice. Claude plays the consular officer through the
Claude Code login you already have (no API key), speech recognition runs
on your own CPU, and all your case data, recordings and reports stay in `data/`.

## Run

Double-click `start.cmd`, or:

```powershell
npm install
npm start
```

Then open http://localhost:5178. The first voice answer downloads the Whisper
model (~100 MB) to `%LOCALAPPDATA%\visa-coach\models`. After that it works offline.

## Your CV and statement of purpose

The top of the Case file page has a slot for your CV, one for your SOP, and one
for other documents (I-20 / CAS, bank or loan letters). Drop a file in (PDF, Word
.docx, text or a photo) and Claude reads it and fills in the case file: visa
type, name, nationality, purpose, background, ties and plans, plus a list of
facts your answers must match. It also lists what your documents don't say
(usually funding) and what an officer may push on, e.g. an SOP line about
working in the US.

- Fields Claude filled are marked **from your documents**. Edit any of them;
  anything you typed yourself is never overwritten, even when you upload again.
- A new CV or SOP replaces the old one and the case file is re-read automatically.
  For other documents, press **Fill my case file**.
- Old `.doc` files can't be read: save as `.docx` or PDF first.

## What's sent where

| Data | Where it goes |
|---|---|
| Your voice | Nowhere. Whisper transcribes it on this computer; audio is never saved. |
| Officer's voice | Your browser's built-in voices (Windows voices are local; ones marked "online" are not). |
| Case file, transcript, documents you ask it to read | Claude, via `claude -p`, using your Claude subscription. |
| Profile, sessions, reports, documents | `data/` in this folder. |

The server listens on 127.0.0.1 only.

## Better than visainterview.ai

- **Documents become evidence.** Upload your I-20 / CAS / bank letters; the officer sees the facts and challenges answers that don't match.
- **The officer's private thoughts.** After each answer the officer notes what it really thought; you see them in the debrief.
- **Delivery from audio.** Speaking time, words per minute, delay before you start, long pauses, filler words. The officer reacts to rambling just like at the window.
- **Real decisions.** Approve / refuse (with the actual legal basis, e.g. INA 214(b)) / administrative processing, often after 2-4 minutes.
- **Officer types:** neutral, rushed, sceptical, friendly-but-probing.
- **Drills.** Each report picks your weakest area; one click runs an interview focused on it. History tracks your scores per area.
- Unlimited and free beyond your Claude plan's usage.

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `VISA_COACH_MODEL` | `claude-opus-5-5` | Model for the officer and debrief (`sonnet` is faster) |
| `VISA_COACH_WHISPER` | `onnx-community/whisper-base.en` | Speech model; `onnx-community/whisper-small.en` is more accurate but slower |
| `PORT` | `5178` | Local port |
| `CLAUDE_BIN` | auto | Path to `claude.exe` if it isn't found |

## Test

`npm test` runs a real interview end to end (one answer spoken through Windows'
built-in voice and transcribed by Whisper, the rest typed) in a throwaway data folder.
`npm run test:docs` uploads a sample Word CV and PDF SOP for a made-up applicant and
checks the case file Claude fills in.

The practice is for explaining your real situation clearly; the debrief never
suggests inventing or hiding facts.
