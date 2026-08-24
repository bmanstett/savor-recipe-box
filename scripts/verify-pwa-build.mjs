import { access, readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const distRoot = resolve(projectRoot, 'dist');
const assetsRoot = resolve(distRoot, 'assets');

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  }));
  return files.flat();
}

const [html, worker, manifest] = await Promise.all([
  readFile(resolve(distRoot, 'index.html'), 'utf8'),
  readFile(resolve(distRoot, 'sw.js'), 'utf8'),
  readFile(resolve(distRoot, 'manifest.webmanifest'), 'utf8').then(JSON.parse),
]);

if (worker.includes('__SAVOR_BUILD_ASSETS__')) throw new Error('The service-worker precache manifest was not injected.');

const emittedAssets = (await listFiles(assetsRoot))
  .filter((path) => !path.endsWith('.map'))
  .map((path) => relative(distRoot, path).replaceAll('\\', '/'));
const missingFromWorker = emittedAssets.filter((path) => !worker.includes(JSON.stringify(path)));
if (missingFromWorker.length) throw new Error(`Service worker does not precache: ${missingFromWorker.join(', ')}`);

const htmlAssets = [...html.matchAll(/(?:src|href)="\.\/(assets\/[^"?#]+)(?:[?#][^"]*)?"/g)].map((match) => match[1]);
if (!htmlAssets.length) throw new Error('Production HTML does not reference any built assets.');
const missingFromDisk = htmlAssets.filter((path) => !emittedAssets.includes(path));
if (missingFromDisk.length) throw new Error(`Production HTML references missing assets: ${missingFromDisk.join(', ')}`);

const viewportContent = html.match(/<meta[^>]+name="viewport"[^>]+content="([^"]+)"/i)?.[1] ?? '';
for (const requiredToken of ['width=device-width', 'initial-scale=1', 'viewport-fit=cover']) {
  if (!viewportContent.includes(requiredToken)) throw new Error(`Production viewport is missing ${requiredToken}.`);
}
if (/maximum-scale|user-scalable\s*=\s*no/i.test(viewportContent)) {
  throw new Error('Production viewport must preserve accessible pinch zoom.');
}

const cssAssets = htmlAssets.filter((path) => path.endsWith('.css'));
if (!cssAssets.length) throw new Error('Production HTML does not reference a built stylesheet.');
const productionCss = (await Promise.all(cssAssets.map((path) => readFile(resolve(distRoot, path), 'utf8')))).join('\n');
if (!productionCss.includes('--ios-form-control-font-size:16px')) {
  throw new Error('Production CSS is missing the iOS 16px form-control guard.');
}
if (!productionCss.includes('font-size:var(--ios-form-control-font-size)!important')) {
  throw new Error('Production CSS does not apply the iOS form-control guard.');
}

for (const icon of manifest.icons ?? []) {
  const path = String(icon.src ?? '').replace(/^\.\//, '');
  if (!path) throw new Error('The web app manifest contains an icon without a path.');
  await access(resolve(distRoot, path));
  if (!worker.includes(`scoped('${path}')`)) throw new Error(`Service worker does not precache manifest icon: ${path}`);
}

console.log(`PWA build verified: ${emittedAssets.length} emitted assets and ${(manifest.icons ?? []).length} install icons are precached.`);
