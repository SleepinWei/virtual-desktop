import { createHash } from 'node:crypto';

// Read-only inspection of SFNT streams embedded by SkPicture's default
// kDoIncludeData typeface serializer. No fonts or drawing records are changed.
export function embeddedFonts(bytes) {
  const fonts = [];
  for (let base = 0; base + 12 <= bytes.length; base++) {
    const version = bytes.readUInt32BE(base);
    if (![0x00010000, 0x4f54544f, 0x74727565].includes(version)) continue;
    const count = bytes.readUInt16BE(base + 4), power = Math.floor(Math.log2(count));
    if (count < 3 || count > 128 || base + 12 + count * 16 > bytes.length ||
      bytes.readUInt16BE(base + 6) !== 16 * 2 ** power || bytes.readUInt16BE(base + 8) !== power ||
      bytes.readUInt16BE(base + 10) !== count * 16 - 16 * 2 ** power) continue;
    const tables = new Map(); let valid = true, end = 12 + count * 16;
    for (let i = 0; i < count; i++) {
      const start = base + 12 + 16 * i, tag = bytes.toString('ascii', start, start + 4);
      const offset = bytes.readUInt32BE(start + 8), length = bytes.readUInt32BE(start + 12);
      if (!/^[ -~]{4}$/.test(tag) || tables.has(tag) || offset < 12 + count * 16 || base + offset + length > bytes.length) { valid = false; break; }
      tables.set(tag, { offset, length }); end = Math.max(end, offset + ((length + 3) & ~3));
    }
    const head = tables.get('head'), maxp = tables.get('maxp'), name = tables.get('name');
    if (!valid || !head || head.length < 16 || !maxp || maxp.length < 6 || !name || name.length < 6 || !tables.has('cmap') ||
      base + end > bytes.length || bytes.readUInt32BE(base + head.offset + 12) !== 0x5f0f3cf5) continue;
    const names = {};
    const nameBase = base + name.offset, records = bytes.readUInt16BE(nameBase + 2), strings = bytes.readUInt16BE(nameBase + 4);
    if (6 + records * 12 <= name.length) for (let i = 0; i < records; i++) {
      const at = nameBase + 6 + 12 * i, platform = bytes.readUInt16BE(at), id = bytes.readUInt16BE(at + 6);
      const length = bytes.readUInt16BE(at + 8), offset = strings + bytes.readUInt16BE(at + 10);
      if (![1, 4, 6].includes(id) || offset + length > name.length) continue;
      const raw = Buffer.from(bytes.subarray(nameBase + offset, nameBase + offset + length));
      const value = platform === 0 || platform === 3 ? length % 2 ? '' : raw.swap16().toString('utf16le') : raw.toString('latin1');
      if (value && (!names[id] || platform === 3)) names[id] = value;
    }
    fonts.push({ offset: base, bytes: end, family: names[1], fullName: names[4], postScriptName: names[6],
      glyphs: bytes.readUInt16BE(base + maxp.offset + 4), format: tables.has('CFF ') || tables.has('CFF2') ? 'CFF' : 'TrueType',
      tables: [...tables].map(([tag, value]) => ({ tag, bytes: value.length })),
      sha256: createHash('sha256').update(bytes.subarray(base, base + end)).digest('hex') });
    base += end - 1;
  }
  return fonts;
}
