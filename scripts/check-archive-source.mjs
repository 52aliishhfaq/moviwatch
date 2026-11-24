import assert from 'node:assert/strict';
import { parseArchiveSourceUrl } from '../src/archive-source.js';

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
