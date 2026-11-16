import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';

const files = ['public/watch.html'];
let checked = 0;

for (const file of files) {
  const html = readFileSync(file, 'utf8');
  const scripts = [...html.matchAll(/<script(?:\\s[^>]*)?>([\\s\\S]*?)<\\/script>/gi)];
  if (!scripts.length) throw new Error(`No inline script blocks found in ${file}`);

  for (let index = 0; index < scripts.length; index++) {
    const source = scripts[index][1].trim();
    if (!source) continue;
    new Script(source, { filename: `${file}#inline-script-${index + 1}` });
    checked++;
  }
}

console.log(`Validated ${checked} inline browser script(s).`);
