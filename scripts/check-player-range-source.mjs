import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const CHUNK_SIZE = 1024 * 1024;
const totalSize = 6 * CHUNK_SIZE + 123;
const requests = [];
let headCalls = 0;

const fakeFetch = async (_url, options = {}) => {
  if (options.method === 'HEAD') {
    headCalls++;
    return {
      ok: true,
      status: 200,
      headers: { get: name => name.toLowerCase() === 'content-length' ? String(totalSize) : null }
    };
  }

  const value = options.headers?.Range || options.headers?.range || '';
  const match = /^bytes=([0-9]+)-([0-9]+)$/.exec(value);
  assert.ok(match, 'Every player GET must be an explicit byte range');
  const start = Number(match[1]);
  const requestedEnd = Number(match[2]);
  assert.ok(start < totalSize, 'The source must not request bytes past EOF');
  const end = Math.min(requestedEnd, totalSize - 1);
  requests.push({ start, end });

  const bytes = new Uint8Array(end - start + 1);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (start + i) % 251;
  return {
    ok: true,
    status: 206,
    headers: {
      get: name => name.toLowerCase() === 'content-range'
        ? 'bytes ' + start + '-' + end + '/' + totalSize
        : null
    },
    arrayBuffer: async () => bytes.buffer
  };
};

const sourceCode = readFileSync('public/player-range-source.js', 'utf8');
const sandbox = {
  window: {},
  fetch: fakeFetch,
  AbortController,
  console: { debug() {}, warn() {} }
};
runInNewContext(sourceCode, sandbox);

const RangeSource = sandbox.window.MoviwatchRangeSource;
assert.equal(typeof RangeSource, 'function', 'Range source adapter must be exported to the page');

const adapter = new RangeSource('/api/watch/test/0', {
  chunkSize: CHUNK_SIZE,
  maxCacheBytes: 32 * CHUNK_SIZE,
  prefetchAhead: 2
});

assert.equal(await adapter.getSize(), totalSize);
assert.equal(headCalls, 1, 'File size should be discovered only once');

const first = new Uint8Array(await adapter.read(CHUNK_SIZE / 2, CHUNK_SIZE * 1.5));
assert.equal(first.byteLength, CHUNK_SIZE * 1.5);
assert.equal(first[0], (CHUNK_SIZE / 2) % 251);
assert.equal(first[first.length - 1], (2 * CHUNK_SIZE - 1) % 251);
assert.equal(requests.length, 2, 'A cross-segment read should fetch two 1 MiB pieces');

const afterColdRead = requests.length;
await adapter.read(CHUNK_SIZE / 2, CHUNK_SIZE * 1.5);
assert.equal(requests.length, afterColdRead, 'Repeated reads should be served from browser memory');

adapter.setPlaybackActive(true);
await adapter.read(2 * CHUNK_SIZE, 64);
await Promise.all([...adapter.pending.values()].map(entry => entry.promise.catch(() => {})));
for (const start of [2 * CHUNK_SIZE, 3 * CHUNK_SIZE, 4 * CHUNK_SIZE]) {
  assert.ok(requests.some(request => request.start === start),
    'Playback should fetch the current 1 MiB segment and prefetch two segments ahead');
}

assert.ok(requests.every(request => request.end - request.start + 1 <= CHUNK_SIZE),
  'No player HTTP range request may exceed 1 MiB');

const beforePausedRead = requests.length;
adapter.setPlaybackActive(false);
await adapter.read(5 * CHUNK_SIZE, 64);
assert.equal(requests.length, beforePausedRead + 1,
  'Paused playback must fetch demanded data but must not schedule speculative ranges');
assert.equal(requests[requests.length - 1].start, 5 * CHUNK_SIZE);

const tail = await adapter.read(totalSize - 10, 100);
assert.equal(tail.byteLength, 10, 'Reads beyond EOF must return truncated data');
adapter.close();
await assert.rejects(adapter.read(0, 1), /closed/i);

console.log('Validated 1 MiB Range requests, LRU reuse, two-ahead prefetch, pause behavior and EOF truncation.');
