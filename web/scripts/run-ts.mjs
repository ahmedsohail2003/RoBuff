// Runs one TypeScript script through Vite's module runner, so scripts need no extra
// dependency such as tsx. Usage (from web/): node scripts/run-ts.mjs <script.ts> [args...]
// The script sees its own arguments from process.argv[2] on, as if run directly.

import { resolve } from 'node:path';
import { runnerImport } from 'vite';

const [script, ...args] = process.argv.slice(2);
if (!script) {
  console.error('usage: node scripts/run-ts.mjs <script.ts> [args...]');
  process.exit(2);
}
process.argv = [process.argv[0], resolve(script), ...args];
await runnerImport(resolve(script), { configFile: false, logLevel: 'warn' });
