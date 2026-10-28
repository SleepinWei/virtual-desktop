import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { verifyLive } from './verify-live.js';

const { values } = parseArgs({ options: { root: { type: 'string', default: process.env.CHROMIUM_BUILD_ROOT },
  canvaskit: { type: 'string', default: process.env.CANVASKIT_DIRECTORY },
  output: { type: 'string', default: 'test-results/chromium-live' } } });
const report = await verifyLive({ root: values.root, canvasKitDirectory: values.canvaskit, outputDir: resolve(values.output) });
console.log(JSON.stringify({ status: report.status, steps: report.steps, visuals: report.visuals.map(visual => ({ name: visual.name, passed: visual.passed })),
  errors: report.errors, raster: report.engine?.raster.eventCount, pixelDraw: report.engine?.pixelDraw.eventCount,
  output: resolve(values.output) }, null, 2));
process.exitCode = report.status === 'live-native-session-candidate' ? 0 : 1;
