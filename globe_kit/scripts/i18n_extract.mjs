// Extract the `en` and `it` dictionaries from globe_kit/src/app/i18n.ts as JSON (stdout).
// Usage: node scripts/i18n_extract.mjs src/app/i18n.ts <out.json>  (Node 22+ for type stripping)
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [, , src, out] = process.argv;
let code = readFileSync(src, 'utf8');
// keep only the dictionaries: from "const en = {" up to the loader of the machine-translated ones
const a = code.indexOf('const en = {');
const b = code.indexOf('// Machine-translated dictionaries');
code = 'type Key = string;\n' + code.slice(a, b).replace(/export type [^\n]*\n/g, '').replace(/^type [^\n]*\n/gm, '') + '\nexport { en, it };\n';
const tmp = pathToFileURL(join(tmpdir(), `fireglobe_dict_${process.pid}.ts`));
writeFileSync(tmp, code);
const mod = await import(tmp.href + '?' + Date.now());
writeFileSync(out, JSON.stringify({ en: mod.en, it: mod.it }, null, 1));
console.log(Object.keys(mod.en).length, 'en keys,', Object.keys(mod.it).length, 'it keys');
