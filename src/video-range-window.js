/**
 * Bound one HTTP 206 response to the cache chunk containing the requested
 * offset. An open-ended Range (bytes=N-) must not turn into a stream to EOF.
 * The browser can request the following byte window when it needs it.
 */
export function getVideoRangeWindow({
  start,
  requestedEnd,
  total,
  fragmented,
  continuationChunkSize,
  startupChunkSize,
  fragmentStartupChunkSize
}) {
  const integers = [
    start, requestedEnd, total, continuationChunkSize,
    startupChunkSize, fragmentStartupChunkSize
  ];
  if (!integers.every(Number.isSafeInteger) ||
      start < 0 || requestedEnd < start || total <= requestedEnd ||
      continuationChunkSize < 1 || startupChunkSize < 1 ||
      fragmentStartupChunkSize < 1) {
    throw new RangeError('Invalid video byte-range window');
  }

  const startupSize = fragmented ? fragmentStartupChunkSize : startupChunkSize;
  const chunkStart = start < startupSize
    ? 0
    : startupSize + Math.floor((start - startupSize) / continuationChunkSize) * continuationChunkSize;
  const chunkSize = chunkStart === 0 ? startupSize : continuationChunkSize;
  const chunkEnd = Math.min(total - 1, chunkStart + chunkSize - 1);

  return {
    chunkStart,
    chunkEnd,
    end: Math.min(requestedEnd, chunkEnd)
  };
}
