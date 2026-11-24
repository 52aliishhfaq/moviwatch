import assert from 'node:assert/strict';
import { parseArchiveSourceUrl, verifyArchiveSources } from '../src/archive-source.js';

const movie = parseArchiveSourceUrl(
  'https://archive.org/download/1-2001_202611/1%202001.mpeg4'
);
assert.deepEqual(movie, {
  identifier: '1-2001_202611',
  file: '1 2001.mpeg4',
  search: '',
  original: 'https://archive.org/download/1-2001_202611/1%202001.mpeg4'
});

const nested = parseArchiveSourceUrl(
  'https://ia801500.us.archive.org/0/items/feature-film-2026/video%20masters/part%201.mpeg4'
);
assert.equal(nested.identifier, 'feature-film-2026');
assert.equal(nested.file, 'video masters/part 1.mpeg4');

for (const url of [
  'http://archive.org/download/item/file.mp4',
  'https://archive.org:444/download/item/file.mp4',
  'https://user:pass@archive.org/download/item/file.mp4',
  'https://archive.org/download/item/file.mp4?token=private',
  'https://archive.org/download/item/file.mp4#fragment',
  'https://evilarchive.org/download/item/file.mp4',
  'https://archive.org/download/item/a%2Fb.mp4',
  'https://archive.org/download/item/%2e%2e/secret.mp4',
  'https://archive.org/download/item/',
  'not a URL'
]) assert.equal(parseArchiveSourceUrl(url), null, 'Expected unsafe or non-canonical URL to be rejected: '+url);

console.log('Archive.org canonical source parsing, encoded filenames, nested paths and unsafe URL rejection passed.');

const probeCalls = [];
const verified = await verifyArchiveSources([
  { label: '2001 master', provider: 'archive.org',
    url: 'https://archive.org/download/1-2001_202611/1%202001.mpeg4' },
  { label: 'Mirror copy', provider: 'archive.org',
    url: 'https://archive.org/download/feature-film-2026/video%20masters/part%201.mpeg4' }
], async (identifier, filename) => {
  probeCalls.push({ identifier, filename });
  return {
    status: 206, size: 2048,
    url: 'https://archive.org/download/'+encodeURIComponent(identifier)+'/'+filename.split('/').map(encodeURIComponent).join('/')
  };
}, () => new Date('2026-11-24T10:00:00.000Z'));

assert.deepEqual(probeCalls, [
  { identifier: '1-2001_202611', filename: '1 2001.mpeg4' },
  { identifier: 'feature-film-2026', filename: 'video masters/part 1.mpeg4' }
]);
assert.equal(verified.length, 2);
assert.equal(verified[0].verified_at, '2026-11-24T10:00:00.000Z');
assert.equal(verified[0].verified_size, 2048);
assert.equal(verified[0].provider, 'archive.org');

await assert.rejects(
  () => verifyArchiveSources([{ label: 'Drive', provider: 'google-drive', url: 'https://drive.google.com/file/d/abcdefghij/view' }],
    async () => ({ status: 206, size: 100 })),
  /Only Archive.org/
);
await assert.rejects(
  () => verifyArchiveSources([{ label: 'Unavailable', provider: 'archive.org', url: 'https://archive.org/download/item/movie.mp4' }],
    async () => ({ status: 200, size: 1024 })),
  /valid HTTP 206/
);
await assert.rejects(
  () => verifyArchiveSources([{ label: 'Missing length', provider: 'archive.org', url: 'https://archive.org/download/item/movie.mp4' }],
    async () => ({ status: 206, size: 0 })),
  /valid HTTP 206/
);
await assert.rejects(
  () => verifyArchiveSources([], async () => ({ status: 206, size: 1 })),
  /between 1 and 8/
);

console.log('Archive.org batch verification requires HTTP 206 and records server-side verification metadata.');

