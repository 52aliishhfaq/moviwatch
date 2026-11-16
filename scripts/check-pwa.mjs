import assert from 'node:assert/strict';
import fs from 'node:fs';
const manifest=JSON.parse(fs.readFileSync('public/manifest.webmanifest','utf8'));
assert.equal(manifest.name,'Moviwatch');
assert.equal(manifest.start_url,'/');
assert.equal(manifest.display,'standalone');
for(const icon of manifest.icons){assert.ok(fs.existsSync('public'+icon.src),`Missing PWA icon ${icon.src}`)}
const logoSvg=fs.readFileSync('public/assets/moviwatch-logo-4k.svg','utf8');
assert.match(logoSvg,/width="3840" height="2160"/);
for(const size of [180,192]) {
  const png=fs.readFileSync(`public/assets/moviwatch-app-icon-${size}.png`);
  assert.equal(png.toString('hex',0,8),'89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16),size);
  assert.equal(png.readUInt32BE(20),size);
}
const home=fs.readFileSync('public/index.html','utf8');
const watch=fs.readFileSync('public/watch.html','utf8');
for(const [name,html] of [['home',home],['watch',watch]]){assert.ok(html.includes('/manifest.webmanifest'),`${name} manifest missing`);assert.ok(html.includes('/pwa-install.js'),`${name} install script missing`);assert.ok(html.includes('/pwa-install.css'),`${name} install styles missing`)}
const sw=fs.readFileSync('public/sw.js','utf8');
assert.ok(sw.includes("u.pathname.startsWith('/api/')"));assert.ok(sw.includes("req.headers.has('Range')"));
assert.ok(sw.includes("u.pathname.startsWith('/watch/')"));
const install=fs.readFileSync('public/pwa-install.js','utf8');
assert.ok(install.includes("beforeinstallprompt"));assert.ok(install.includes("appinstalled"));assert¶»§q«^