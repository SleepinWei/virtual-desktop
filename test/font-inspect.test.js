import test from 'node:test';
import assert from 'node:assert/strict';
import { embeddedFonts } from '../experiments/chromium-engine/font-inspect.js';

function sfnt() {
  const tags = ['cmap', 'head', 'maxp', 'name'], data = Buffer.alloc(160);
  data.writeUInt32BE(0x00010000, 0); data.writeUInt16BE(4, 4); data.writeUInt16BE(64, 6); data.writeUInt16BE(2, 8);
  const entries = [[76, 4], [80, 16], [96, 8], [104, 40]];
  for (let i = 0; i < tags.length; i++) {
    data.write(tags[i], 12 + i * 16, 4, 'ascii'); data.writeUInt32BE(entries[i][0], 20 + i * 16); data.writeUInt32BE(entries[i][1], 24 + i * 16);
  }
  data.writeUInt32BE(0x5f0f3cf5, 92); data.writeUInt16BE(7, 100);
  data.writeUInt16BE(1, 106); data.writeUInt16BE(18, 108); // one name record
  data.writeUInt16BE(3, 110); data.writeUInt16BE(1, 112); data.writeUInt16BE(0x0409, 114); data.writeUInt16BE(6, 116); data.writeUInt16BE(8, 118);
  Buffer.from('Probe', 'utf16le').swap16().copy(data, 122); data.writeUInt16BE(10, 118);
  return data.subarray(0, 144);
}
test('embedded font inspection finds an unaligned SFNT and never changes its bytes', () => {
  const data = Buffer.concat([Buffer.from('prefix!'), sfnt(), Buffer.from('suffix')]), before = Buffer.from(data);
  const fonts = embeddedFonts(data);
  assert.equal(fonts.length, 1); assert.equal(fonts[0].offset, 7); assert.equal(fonts[0].bytes, 144);
  assert.equal(fonts[0].glyphs, 7); assert.equal(fonts[0].postScriptName, 'Probe'); assert.equal(fonts[0].format, 'TrueType');
  assert.deepEqual(data, before);
});
test('truncated or fake SFNT directories cannot produce a font size claim', () => {
  const truncated = sfnt().subarray(0, 120), fake = sfnt(), badMagic = sfnt();
  fake.writeUInt32BE(0xffffffff, 24); badMagic.writeUInt32BE(0, 92);
  for (const bytes of [truncated, fake, badMagic, Buffer.alloc(30)]) assert.deepEqual(embeddedFonts(bytes), []);
});
