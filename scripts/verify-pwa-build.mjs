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

for (const icon of manifest.icons ?? []) {
  const path = String(icon.src ?? '').replace(/^\.\//, '');
  if (!path) throw new Error('The web app manifest contains an icon without a path.');
  await access(resolve(distRoot, path));
  if (!worker.includes(`scoped('${path}')`)) throw new Error(`Service worker does not precache manifest icon: ${path}`);
}

console.log(`PWA build verified: ${emittedAssets.length} emitted assets and ${(manifest.icons ?? []).length} install icons are precached.`);
