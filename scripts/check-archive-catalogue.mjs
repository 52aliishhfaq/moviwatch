import assert from 'node:assert/strict';
import {
  buildArchiveSearchUrl,
  searchArchiveItems,
  getArchiveItem,
  probeArchiveFile
} from '../src/archive-catalogue.js';

const searchUrl = buildArchiveSearchUrl({ query: 'star wars', year: '1977', page: 2 });
assert.equal(searchUrl.hostname, 'archive.org');
assert.equal(searchUrl.pathname, '/advancedsearch.php');
assert.match(searchUrl.searchParams.get('q'), /mediatype:movies/);
assert.match(searchUrl.searchParams.get('q'), /year:1977/);
const grouped = buildArchiveSearchUrl({ query: 'star wars' }).searchParams.get('q');
assert.ok(grouped.includes('(title:(star) OR description:(star) OR creator:(star)) AND (title:(wars)'));
assert.throws(() => buildArchiveSearchUrl({ query: 'x'.repeat(161) }), /160 characters/);
assert.equal(searchUrl.searchParams.get('rows'), '24');
assert.equal(searchUrl.searchParams.get('page'), '2');
assert.throws(() => buildArchiveSearchUrl({ year: '20x6' }), /four digits/);
assert.throws(() => buildArchiveSearchUrl({ page: 0 }), /page/);
assert.throws(() => buildArchiveSearchUrl({ rows: 100 }), /between 1 and 50/);
assert.throws(() => buildArchiveSearchUrl({ sort: 'random desc' }), /sort order/);

let requested;
const search = await searchArchiveItems({ query: 'metropolis' }, async (url) => {
  requested = new URL(url);
  return new Response(JSON.stringify({
    response: { start: 0, rows: 24, numFound: 2, docs: [
      { identifier: 'metropolis1927', title: 'Metropolis', year: '1927', mediatype: 'movies' },
      { identifier: '../bad', title: 'Bad identifier' }
    ] }
  }), { status: 200, headers: { 'content-type': 'application/json' } });
});
assert.equal(requested.hostname, 'archive.org');
assert.equal(search.total, 2);
assert.equal(search.items.length, 1);
assert.equal(search.items[0].identifier, 'metropolis1927');

const item = await getArchiveItem('sample_movie', async (url) => {
  assert.match(String(url), /extended_err=1/);
  return new Response(JSON.stringify({
    metadata: {
      title: 'Sample Movie', year: '1950', mediatype: 'movies',
      collection: ['feature_films'], licenseurl: 'https://creativecommons.org/publicdomain/mark/1.0/'
    },
    server: 'ia600000.us.archive.org',
    d1: 'ia800000.us.archive.org',
    files: [
      { name: 'movie.mp4', format: 'MPEG4', size: '1000', md5: 'a'.repeat(32) },
      { name: 'private.mp4', format: 'MPEG4', size: '2000', private: 'true' },
      { name: 'cover.jpg', format: 'JPEG', size: '100' },
      { name: 'movie.webm', format: 'WebM', size: '500' }
    ]
  }), { status: 200 });
});
assert.equal(item.title, 'Sample Movie');
assert.equal(item.availability, 'available');
assert.deepEqual(item.files.map((file) => file.name), ['movie.mp4', 'movie.webm']);
assert.equal(item.files[0].md5, 'a'.repeat(32));
assert.equal(item.storage.server, 'ia600000.us.archive.org');
assert.equal(item.files.some((file) => file.name.endsWith('.mkv')), false);
assert.equal(item.files.some((file) => file.name.endsWith('.avi')), false);

await assert.rejects(() => getArchiveItem('../invalid', async () => {
  throw new Error('fetch must not be called');
}), /identifier/);

const probe = await probeArchiveFile('sample_movie', 'folder/movie.mp4', async (url, init) => {
  assert.equal(init.method, 'GET');
  assert.equal(init.headers.range, 'bytes=0-0');
  assert.match(String(url), /folder\/movie\.mp4$/);
  return new Response(new Uint8Array([0]), {
    status: 206,
    headers: { 'content-range': 'bytes 0-0/12345', 'content-type': 'video/mp4' }
  });
});
assert.equal(probe.size, 12345);
assert.equal(probe.status, 206);

await assert.rejects(() => probeArchiveFile('sample_movie', '../movie.mp4', async () => {
  throw new Error('fetch must not be called');
}), /filename/);
await assert.rejects(() => probeArchiveFile('sample_movie', 'movie.mp4', async () => new Response(null, { status: 200 })), /byte-range/);


for (const [code, expected] of [[101,'creation_pending'],[102,'temporarily_offline'],[103,'unbacked_item'],[104,'deleted']]) {
  const result = await getArchiveItem('status_item', async () => new Response(JSON.stringify({
    metadata: { title: 'Status item' }, error: code, files: []
  }), { status: 200 }));
  assert.equal(result.availability, expected);
}
const missing = await getArchiveItem('missing_item', async () => new Response(JSON.stringify({
  metadata: { title: 'Missing item' }, error: 'Item not found', files: []
}), { status: 200 }));
assert.equal(missing.availability, 'unavailable');
const emptyItem = await getArchiveItem('empty_item', async () => new Response(JSON.stringify({}), { status: 200 }));
assert.equal(emptyItem.availability, 'unavailable');

await assert.rejects(() => probeArchiveFile('sample_movie', 'movie.mp4', async () =>
  new Response(null, { status: 302, headers: { location: 'https://evil.invalid/movie.mp4' } })
), /untrusted host/);

console.log('Archive.org search validation, metadata/file filtering, identifier safety and range-probe checks passed.');
