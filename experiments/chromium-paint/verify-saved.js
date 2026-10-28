import { readFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createPaintLab } from './server.js';
import { verifyReplay } from './verify.js';

const { values } = parseArgs({ options: {
  input: { type: 'string' }, output: { type: 'string', default: 'test-results/chromium-replay' },
  canvaskit: { type: 'string' },
} });
if (!values.input) throw new Error('Pass --input pointing to an existing native capture directory');
const input = resolve(values.input), outputDir = resolve(values.output);
await mkdir(outputDir, { recursive: true });
const manifest = JSON.parse(await readFile(join(input, 'capture.json'), 'utf8'));
const lab = createPaintLab({ outputDir: input, canvasKitDirectory: values.canvaskit });
try {
  const baseUrl = await lab.listen();
  const result = await verifyReplay({ baseUrl, outputDir, manifest,
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || manifest.browser.executablePath });
  console.log(JSON.stringify({ outputDir, runtime: result.replayRuntime,
    clientReplayRendered: result.clientReplayRendered, fixtureReplayPassed: result.fixtureReplayPassed,
    stages: result.stages.map(stage => ({ name: stage.name, passed: stage.passed,
      visual: stage.visual, regions: stage.regions })), errors: result.errors }, null, 2));
  if (!result.fixtureReplayPassed) process.exitCode = 1;
} finally { await lab.close(); }
