import { readFileSync } from 'node:fs';

const worker = readFileSync('src/index.js', 'utf8');
const watch = readFileSync('public/watch.html', 'utf8');
const admin = readFileSync('public/admin.html', 'utf8');
const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
const readme = readFileSync('README.md', 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(worker.includes("url.hostname.toLowerCase() !== 'voe.sx'"),
  'The API must restrict embeds to the exact VOE hostname');
assert(worker.includes("/^\\/e\\/([A-Za-z0-9_-]{3,100})\\/?$/"),
  'The API must accept only VOE /e/ embed paths');
assert(worker.includes("provider: 'voe.sx'"),
  'New movie sources must be stored as VOE sources');
assert(worker.includes("WHERE item.value->>'provider'='voe.sx'"),
  'The public catalogue must filter out every non-VOE source');
assert(worker.includes("source?.provider !== 'voe.sx'"),
  'The admin editor response must not expose legacy provider records');
assert(worker.includes("Video playback and any available download are provided on the official VOE page."),
  'Legacy byte-stream and download proxy routes must be retired');
assert(!/doodstream|playmogo|archive\\.org|google-drive|drive\\.google\\.com/i.test(worker),
  'The worker must not contain legacy video-provider integrations');
assert(watch.includes('id="voePlayer"') && watch.includes('https://voe.sx'),
  'The watch page must embed the VOE-hosted player');
assert(watch.includes('rel="preconnect" href="https://voe.sx"'),
  'The watch page must preconnect to the VOE origin');
assert(watch.includes('download_url') && watch.includes('Open VOE download options'),
  'The download action must link to the official VOE page');
assert(!/movi-player|doodstream|playmogo|archive\\.org|google-drive/i.test(watch),
  'The watch page must not include legacy players or providers');
assert(admin.includes('id="voeUrl"') && admin.includes('https://voe.sx/e/af7mpped9rwa'),
  'The admin form must be VOE-only and show the supplied example link');
assert(!/doodstream|playmogo|archive\\.org|google-drive/i.test(admin),
  'The admin form must not mention legacy video providers');
assert(config.exports?.PublicCatalogue?.type === 'worker' &&
  config.exports?.PublicCatalogue?.cache?.enabled === true &&
  Object.keys(config.exports).length === 2,
  'Only the cached public-catalogue entrypoint should remain');
assert(!/VideoChunk|VideoHeader|MovieMetadata/.test(JSON.stringify(config.exports)),
  'Legacy media-cache entrypoints must be removed');
assert(readme.includes('VOE-only') && readme.includes('Pakistan/mobile playback guidance'),
  'The README must document the VOE-only and regional playback setup');

console.log('VOE-only streaming checks passed.');
