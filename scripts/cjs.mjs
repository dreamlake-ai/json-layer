// tsc writes CommonJS as .js; inside a "type": "module" package those files
// must be .cjs (and their declarations .d.cts) to load as CommonJS.
import { readdirSync, renameSync } from 'node:fs';
const dir = 'dist/cjs';
for (const f of readdirSync(dir)) {
  if (f.endsWith('.d.ts')) renameSync(`${dir}/${f}`, `${dir}/${f.slice(0, -5)}.d.cts`);
  else if (f.endsWith('.js')) renameSync(`${dir}/${f}`, `${dir}/${f.slice(0, -3)}.cjs`);
}
