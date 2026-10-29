import { constants, openSync, fstatSync, readSync, closeSync, createReadStream } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

// Keep a verified open inode, rather than trusting a path again at HTTP time.
// Only a fixed-size scratch buffer enters the gateway; font programs never
// cross worker IPC or JSON, and each HTTP stream uses positioned reads.
export function openNativeFont(filePath, descriptor) {
  if (typeof filePath !== 'string' || !isAbsolute(filePath) || basename(filePath) !== descriptor.id + '.font') throw new Error('Invalid native font path');
  const fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== descriptor.bytes) throw new Error('Native font length mismatch');
    const scratch = Buffer.alloc(Math.min(65536, stat.size)), hash = createHash('sha256');
    let position = 0;
    while (position < stat.size) {
      const count = readSync(fd, scratch, 0, Math.min(scratch.length, stat.size - position), position);
      if (!count) throw new Error('Truncated native font asset');
      hash.update(scratch.subarray(0, count)); position += count;
    }
    if (hash.digest('hex') !== descriptor.id) throw new Error('Native font SHA-256 mismatch');
    let closed = false;
    return { length: stat.size,
      stream() {
        if (closed) throw new Error('Native font asset is closed');
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
