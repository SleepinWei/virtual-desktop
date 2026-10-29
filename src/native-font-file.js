import { constants, openSync, fstatSync, readSync, closeSync, createReadStream } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

// Keep a verified open inode, rather than trusting a path again at HTTP time.
// Only a fixed-size scratch buffer enters the gateway; font programs never
// cross worker IPC or JSON. Original images use the same pinned-inode path.
export function openNativeFont(filePath, descriptor) {
  return openNativeAsset(filePath, { ...descriptor, kind: 'font' });
}

export function openNativeAsset(filePath, descriptor) {
  const extension = descriptor.kind === 'image' ? '.img' : descriptor.kind === 'font' ? '.font' : null;
  if (!extension || typeof filePath !== 'string' || !isAbsolute(filePath) || basename(filePath) !== descriptor.id + extension) throw new Error('Invalid native asset path');
  const label = descriptor.kind === 'image' ? 'Native image' : 'Native font';
  const fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== descriptor.bytes) throw new Error(`${label} length mismatch`);
    const scratch = Buffer.alloc(Math.min(65536, stat.size)), hash = createHash('sha256');
    let position = 0;
    while (position < stat.size) {
      const count = readSync(fd, scratch, 0, Math.min(scratch.length, stat.size - position), position);
      if (!count) throw new Error(`Truncated ${label.toLowerCase()} asset`);
      hash.update(scratch.subarray(0, count)); position += count;
    }
    if (hash.digest('hex') !== descriptor.id) throw new Error(`${label} SHA-256 mismatch`);
    let closed = false;
    return { length: stat.size,
      stream() {
        if (closed) throw new Error(`${label} asset is closed`);
        // Explicit ReadStream.destroy() closes even an autoClose:false FD.
        // Give every response its own descriptor for the verified inode;
        // eviction/abort/completion can then close independently and safely.
        const duplicate = openSync(`${process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd'}/${fd}`, constants.O_RDONLY);
        try { return createReadStream('', { fd: duplicate, autoClose: true, start: 0, end: stat.size - 1 }); }
        catch (error) { closeSync(duplicate); throw error; }
      },
      close() { if (!closed) { closed = true; closeSync(fd); } },
    };
  } catch (error) { closeSync(fd); throw error; }
}
