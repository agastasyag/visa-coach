// Run by lib/stt.js in a separate process: open the Whisper model (downloading it if
// needed) and exit 0 if it loads, or print the error and exit 1.
import { openWhisper } from "./stt.js";

try {
  await openWhisper();
  process.exit(0);
} catch (e) {
  console.error(e.message.replace(/\s+/g, " "));
  process.exit(1);
}
