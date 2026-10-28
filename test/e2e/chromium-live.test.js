import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { verifyLive } from '../../experiments/chromium-engine/verify-live.js';

const root = process.env.CHROMIUM_LIVE_BUILD_ROOT;
test('a persistent native worker streams real actions and autonomous updates across viewer reconnects', {
  skip: root ? false : 'Set CHROMIUM_LIVE_BUILD_ROOT and CANVASKIT_DIRECTORY for the verified native integration', timeout: 120000,
}, async () => {
  assert.ok(process.env.CANVASKIT_DIRECTORY, 'Matching CanvasKit build required');
  const report = await verifyLive({ root, canvasKitDirectory: process.env.CANVASKIT_DIRECTORY,
    outputDir: resolve('test-results/chromium-live-e2e'), executablePath: process.env.CHROMIUM_EXECUTABLE_PATH });
  assert.equal(report.status, 'live-native-session-candidate', JSON.stringify(report.errors));
});
