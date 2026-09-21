import { readFileSync } from 'node:fs';

/**
 * Minimal `.env` loader.
 *
 * Node 20.6 has `--env-file`, but it throws when the file is absent and the
 * tolerant `--env-file-if-exists` only arrived in 20.12. Baking either into the
 * npm scripts would mean a reviewer without a `.env` cannot start the project,
 * so this reads the file when it exists and does nothing when it does not.
 *
 * Real environment variables always win, so `PROVIDER=groq npm run serve`
 * overrides whatever the file says.
 */
export function loadEnvFile(path = '.env'): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return; // No .env is the normal case; the project runs without one.
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key !== '' && process.env[key] === undefined) process.env[key] = value;
  }
}
