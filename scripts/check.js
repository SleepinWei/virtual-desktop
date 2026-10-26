import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

async function files(directory) {
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isDirectory()) result.push(...await files(`${directory}/${item.name}`));
    else if (item.name.endsWith('.js')) result.push(`${directory}/${item.name}`);
  }
  return result;
}
const sources = [...await files('src'), ...await files('public'), ...await files('scripts'), ...await files('test')];
for (const file of sources) {
  const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.equal(check.status, 0, `${file}: ${check.stderr}`);
}
const forbidden = /(?:from\s+['"](?:playwright|puppeteer|canvas|sharp|skia-canvas)|captureScreenshot|startScreencast|toDataURL|createCanvas)/;
for (const file of await files('src')) assert.doesNotMatch(await readFile(file, 'utf8'), forbidden, `Server pixel-generation dependency in ${file}`);
console.log(`Syntax checked ${sources.length} JS files. Server source has no listed browser/pixel-generation imports or calls.`);
console.log('This source guard checks this limited PoC, not the runtime behavior of a future Chromium integration.');
