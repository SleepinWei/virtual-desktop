import { parseArgs } from 'node:util';
import { createService } from '../../src/server.js';
import { AppError } from '../../src/errors.js';
import { startLoadGuard } from './load-guard.js';

const { values } = parseArgs({ options: { root: { type: 'string', default: process.env.CHROMIUM_BUILD_ROOT },
  canvaskit: { type: 'string', default: process.env.CANVASKIT_DIRECTORY }, port: { type: 'string', default: '8081' },
  'external-sites': { type: 'boolean', default: false }, 'max-active': { type: 'string', default: '1' } } });
const port = Number(values.port);
const maxActive = Number(values['max-active']);
if (!values.root || !values.canvaskit || !Number.isInteger(port) || port < 0 || port > 65535 || ![1, 2].includes(maxActive)) throw new Error('Pass --root, --canvaskit, a valid --port and --max-active 1 or 2');
const guard = await startLoadGuard({ persistent: true, onStop({ reason, sample }) {
  console.error(JSON.stringify({ nativeResourceStop: reason, freePercent: sample?.freePercent,
    treeRssMiB: sample ? sample.treeRssBytes / 1048576 : null }));
} });
const service = createService({ dataDir: process.env.DATA_DIR || '.data/native', adminToken: process.env.ADMIN_TOKEN || 'dev-local', maxActive, maxStarting: 1,
  onWorker(worker) {
    if (guard.stopped) throw new AppError(503, 'HOST_RESOURCE_LIMIT', 'Host safety budget reached; restart the native service after reducing load');
    guard.add(worker.child.pid); worker.exited.then(() => guard.remove(worker.child.pid));
  },
  chromium: { root: values.root, canvasKitDirectory: values.canvaskit, maxSessions: maxActive, externalSites: values['external-sites'],
    resourceStatus: () => ({ stop: guard.stopped, lastSample: guard.samples.at(-1) ? {
      freePercent: guard.samples.at(-1).freePercent, treeRssBytes: guard.samples.at(-1).treeRssBytes } : null }) } });
let address;
try { address = await service.listen(port); }
catch (error) { await service.close(); await guard.close(); throw error; }
console.log(`virtual-desktop live native candidate: ${address}/native`);
console.log('Trusted local fixtures; native pixel-path and general website gate remain unverified.');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await service.close(); await guard.close(); process.exit(0); });
