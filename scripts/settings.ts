import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Fill in the settings a probe needs from `.env.local`, and say so when the
 * environment disagrees with the file.
 *
 * Neither tsx nor Next overrides a variable that is already in the environment,
 * so a shell that happens to export `MINIMAX_API_KEY` — an agent runtime, a CI
 * image, a habit — silently wins over the file the repo documents. The result is
 * a 401 that looks like a stale key and is not. Filling only what is missing,
 * and warning about the conflict, keeps a probe from quietly measuring the wrong
 * thing while still letting a deliberate override work.
 *
 * This lives on its own because both probes have to call it before anything
 * reads `process.env`, and two copies of a precedence rule is one copy too many.
 */
export function loadSettings() {
  const file = path.join(process.cwd(), ".env.local");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    console.log(`no .env.local — using whatever is in the environment`);
    return;
  }

  for (const line of text.split("\n")) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    const value = (match[2] ?? "").replace(/^["']|["']$/g, "");
    const existing = process.env[key];
    if (existing === undefined) process.env[key] = value;
    else if (existing !== value) {
      console.log(
        `warning: ${key} is set in the environment and differs from .env.local — using the ` +
          `environment's. Unset it to probe with the file's value.`,
      );
    }
  }
}
