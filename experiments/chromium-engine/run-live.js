import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { verifyLive } from './verify-live.js';
import { startLoadGuard } from './load-guard.js';

const { values } = parseArgs({ options: { root: { type: 'string', default: process.env.CHROMIUM_BUILD_ROOT },
  canvaskit: { type: 'string', default: process.env.CANVASKIT_DIRECTORY },
  output: { type: 'string', default: 'test-results/chromium-live' }, 'single-session': { type: 'boolean', default: false },
  guard: { type: 'boolean', default: false } } });
const guard = values.guard ? await startLoadGuard() : null;
let report;
try {
  report = await verifyLive({ root: values.root, canvasKitDirectory: values.canvaskit, outputDir: resolve(values.output),
    maxNativeSessions: values['single-session'] ? 1 : 2, onOwnedProcess: pid => guard?.add(pid) });
  if (guard) {
    report.safety = { stopped: guard.stopped, baseline: guard.baseline, samples: guard.samples };
    if (guard.stopped) report.status = 'safety-stopped';
    await writeFile(resolve(values.output, 'live-report.json'), JSON.stringify(report, null, 2));
  }
} finally { await guard?.close(); }
console.log(JSON.stringify({ status: report.status, steps: report.steps, visuals: report.visuals.map(visual => ({ name: visual.name, passed: visual.passed })),
  errors: report.errors, raster: report.engine?.raster.eventCount, pixelDraw: report.engine?.pixelDraw.eventCount,
  output: resolve(values.output) }, null, 2));
process.exitCode = report.status === 'live-native-session-candidate' ? 0 : 1;
