import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VIDEO_CHUNK_SIZE, VIDEO_STARTUP_CHUNK_SIZE, VIDEO_FRAGMENT_START_CHUNK_SIZE,
  parseByteRange, parseContentRange, videoChunkStartForOffset, videoChunkSizeAt,
  mp4MoovEnd, mp4HasMvex
} from '../src/video-range.js';

function box(type, ...parts) {
  const bodyLength = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(8 + bodyLength);
  const view = new DataView(result.buffer);
  view.setUint32(0, result.length);
  for (let i = 0; i < 4; i++) result[4 + i] = type.charCodeAt(i);
  let offset = 8;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function concat(...parts) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

test('parseByteRange accepts closed, open-ended and suffix ranges', () => {
  assert.deepEqual(parseByteRange('bytes=0-99'), { start: 0, end: 99 });
  assert.deepEqual(parseByteRange('bytes=4096-'), { start: 4096, end: null });
  assert.deepEqual(parseByteRange('bytes=-500'), { suffix: 500 });
  assert.deepEqual(parseByteRange('bytes= 0-1 '), { start: 0, end: 1 });
});
test('parseByteRange rejects malformed, multi-range and unsafe values', () => {
  for (const value of [null, 'items=0-1', 'bytes=', 'bytes=-0', 'bytes=4-3',
    'bytes=0-1,3-4', 'bytes=9007199254740992-', 'bytes=0-9007199254740992']) {
    assert.ok(parseByteRange(value) === null || parseByteRange(value)?.invalid, String(value));
  }
});
test('parseContentRange validates byte positions and total length', () => {
  assert.deepEqual(parseContentRange('bytes 10-19/100'), { start: 10, end: 19, total: 100 });
  for (const value of ['', 'bytes */100', 'bytes 10-9/100', 'bytes 10-100/100',
    'bytes 0-1/*', 'bytes 0-1/9007199254740992']) {
    assert.equal(parseContentRange(value), null, value);
  }
});
test('videoChunkStartForOffset maps startup and continuation boundaries', () => {
  assert.equal(videoChunkStartForOffset(0, false), 0);
  assert.equal(videoChunkStartForOffset(VIDEO_STARTUP_CHUNK_SIZE - 1, false), 0);
  assert.equal(videoChunkStartForOffset(VIDEO_STARTUP_CHUNK_SIZE, false), VIDEO_STARTUP_CHUNK_SIZE);
  assert.equal(videoChunkStartForOffset(VIDEO_STARTUP_CHUNK_SIZE + VIDEO_CHUNK_SIZE - 1, false), VIDEO_STARTUP_CHUNK_SIZE);
  assert.equal(videoChunkStartForOffset(VIDEO_STARTUP_CHUNK_SIZE + VIDEO_CHUNK_SIZE, false), VIDEO_STARTUP_CHUNK_SIZE + VIDEO_CHUNK_SIZE);
  assert.equal(videoChunkStartForOffset(VIDEO_FRAGMENT_START_CHUNK_SIZE - 1, true), 0);
  assert.equal(videoChunkStartForOffset(VIDEO_FRAGMENT_START_CHUNK_SIZE, true), VIDEO_FRAGMENT_START_CHUNK_SIZE);
  assert.equal(videoChunkStartForOffset(VIDEO_FRAGMENT_START_CHUNK_SIZE + VIDEO_CHUNK_SIZE, true), VIDEO_FRAGMENT_START_CHUNK_SIZE + VIDEO_CHUNK_SIZE);
});
test('videoChunkSizeAt uses the smaller format-specific startup segment', () => {
  assert.equal(videoChunkSizeAt(0, false), VIDEO_STARTUP_CHUNK_SIZE);
  assert.equal(videoChunkSizeAt(0, true), VIDEO_FRAGMENT_START_CHUNK_SIZE);
  assert.equal(videoChunkSizeAt(VIDEO_STARTUP_CHUNK_SIZE, false), VIDEO_CHUNK_SIZE);
  assert.equal(videoChunkSizeAt(VIDEO_FRAGMENT_START_CHUNK_SIZE, true), VIDEO_CHUNK_SIZE);
});
test('mp4MoovEnd locates a valid top-level moov atom', () => {
  const file = concat(box('ftyp', new Uint8Array([0, 0, 0, 0])), box('moov', box('trak')));
  assert.equal(mp4MoovEnd(file), file.length);
  assert.equal(mp4MoovEnd(new Uint8Array([0, 0, 0, 8, 102, 116, 121, 112])), null);
  assert.equal(mp4MoovEnd(new Uint8Array([0, 0, 0, 1, 109, 111, 111, 118])), null);
});
test('mp4HasMvex detects only a direct mvex child inside moov', () => {
  const fragmented = concat(box('ftyp'), box('moov', box('mvex')));
  const conventional = concat(box('ftyp'), box('moov', box('trak')));
  assert.equal(mp4HasMvex(fragmented), true);
  assert.equal(mp4HasMvex(conventional), false);
  assert.equal(mp4HasMvex(fragmented.subarray(0, fragmented.length - 3)), false);
});
