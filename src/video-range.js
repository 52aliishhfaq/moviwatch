export const VIDEO_CHUNK_SIZE = 4 * 1024 * 1024;
export const VIDEO_STARTUP_CHUNK_SIZE = 1024 * 1024;
export const VIDEO_FRAGMENT_START_CHUNK_SIZE = 512 * 1024;

export function parseByteRange(value) {
  if (typeof value !== 'string' || !value.startsWith('bytes=')) return null;
  const spec = value.slice(6).trim();
  if (spec.includes(',')) return { invalid: true };
  const match = /^([0-9]*)-([0-9]*)$/.exec(spec);
  if (!match || (!match[1] && !match[2])) return { invalid: true };
  if (!match[1]) {
    const suffix = Number(match[2]);
    return Number.isSafeInteger(suffix) && suffix > 0 ? { suffix } : { invalid: true };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : null;
  if (!Number.isSafeInteger(start) || start < 0 ||
      (end !== null && (!Number.isSafeInteger(end) || end < start))) return { invalid: true };
  return { start, end };
}

export function parseContentRange(value) {
  const match = new RegExp('^bytes ([0-9]+)-([0-9]+)/([0-9]+)$').exec(value || '');
  if (!match) return null;
  const start = Number(match[1]), end = Number(match[2]), total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || end < start || total <= end) return null;
  return { start, end, total };
}

export function mp4MoovEnd(bytes) {
  // Parse top-level ISO-BMFF boxes from the small cached file-header probe.
  let offset = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let count = 0; count < 16 && offset + 8 <= bytes.byteLength; count++) {
    let size = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > bytes.byteLength) return null;
      const largeSize = view.getBigUint64(offset + 8);
      if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(largeSize);
      headerSize = 16;
    } else if (size === 0) {
      return null;
    }
    if (size < headerSize) return null;
    if (type === 'moov') {
      const end = offset + size;
      return Number.isSafeInteger(end) && end <= 64 * 1024 * 1024 ? end : null;
    }
    if (offset + size > bytes.byteLength) return null;
    offset += size;
  }
  return null;
}

export function mp4HasMvex(bytes) {
  // A fragmented MP4 has an mvex box as a direct child of its initial moov.
  // Return false when the complete moov is not present in the tiny probe.
  let offset = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let count = 0; count < 16 && offset + 8 <= bytes.byteLength; count++) {
    let size = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > bytes.byteLength) return false;
      const largeSize = view.getBigUint64(offset + 8);
      if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) return false;
      size = Number(largeSize);
      headerSize = 16;
    } else if (size === 0) return false;
    if (size < headerSize || offset + size > bytes.byteLength) return false;
    if (type === 'moov') {
      const moovEnd = offset + size;
      let child = offset + headerSize;
      while (child + 8 <= moovEnd) {
        let childSize = view.getUint32(child);
        const childType = String.fromCharCode(bytes[child + 4], bytes[child + 5], bytes[child + 6], bytes[child + 7]);
        let childHeader = 8;
        if (childSize === 1) {
          if (child + 16 > moovEnd) return false;
          const largeSize = view.getBigUint64(child + 8);
          if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) return false;
          childSize = Number(largeSize);
          childHeader = 16;
        } else if (childSize === 0) return false;
        if (childSize < childHeader || child + childSize > moovEnd) return false;
        if (childType === 'mvex') return true;
        child += childSize;
      }
      return false;
    }
    offset += size;
  }
  return false;
}

export function videoChunkStartForOffset(offset, fragmented) {
  const startupSize = fragmented ? VIDEO_FRAGMENT_START_CHUNK_SIZE : VIDEO_STARTUP_CHUNK_SIZE;
  if (offset < startupSize) return 0;
  return startupSize + Math.floor((offset - startupSize) / VIDEO_CHUNK_SIZE) * VIDEO_CHUNK_SIZE;
}

export function videoChunkSizeAt(chunkStart, fragmented) {
  if (chunkStart !== 0) return VIDEO_CHUNK_SIZE;
  return fragmented ? VIDEO_FRAGMENT_START_CHUNK_SIZE : VIDEO_STARTUP_CHUNK_SIZE;
}
