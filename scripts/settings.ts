import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Fill in the settings probes need from the env files the app reads, and say so
 * when the environment disagrees with `.env.local`.
 *
 * Neither tsx nor Next overrides a variable that is already in the environment,
 * so a shell that happens to export `MINIMAX_API_KEY` — an agent runtime, a CI
 * image, a habit — silently wins over the file the repo documents. The result is
 * a 401 that looks like a stale key and is not. Filling only what is missing,
 * and warning about the conflict, keeps a probe from quietly measuring the wrong
 * thing while still letting a deliberate override work.
 *
 * `.env.local` takes precedence over `.env`, and existing environment variables
 * take precedence over both.
 */
export function loadSettings() {
  for (const name of [".env.local", ".env"]) {
    let text: string;
    try {
      text = readFileSync(path.join(process.cwd(), name), "utf8");
    } catch {
      continue;
    }

    for (const line of text.split("\n")) {
      const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      const key = match[1]!;
      const value = (match[2] ?? "").replace(/^["']|["']$/g, "");
      const existing = process.env[key];
      if (existing === undefined) process.env[key] = value;
      else if (existing !== value && name === ".env.local") {
        console.log(
          `warning: ${key} is set in the environment and differs from ${name} — using the ` +
            `environment's. Unset it to probe with the file's value.`,
        );
      }
    }
  }
}
