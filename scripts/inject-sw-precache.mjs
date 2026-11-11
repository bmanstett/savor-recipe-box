import { readdir, readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const distRoot = resolve(projectRoot, 'dist');
const assetsRoot = resolve(distRoot, 'assets');
const workerPath = resolve(distRoot, 'sw.js');
const marker = '/* __SAVOR_BUILD_ASSETS__ */';
const recipeMarker = '/* __SAVOR_RECIPE_ASSETS__ */';

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  }));
  return files.flat();
}

const buildAssets = (await listFiles(assetsRoot))
  .filter((path) => !path.endsWith('.map'))
  .map((path) => relative(distRoot, path).replaceAll('\\', '/'))
  .sort();

if (!buildAssets.length) throw new Error('No production assets were found to precache.');

const worker = await readFile(workerPath, 'utf8');
if (!worker.includes(marker)) throw new Error('The service-worker precache marker is missing.');
if (!worker.includes(recipeMarker)) throw new Error('The recipe-photo precache marker is missing.');

const recipeAssets = (await listFiles(resolve(distRoot, 'recipes')))
  .filter((path) => /\.(?:jpg|jpeg|png|webp|html|json)$/.test(path))
  .map((path) => relative(distRoot, path).replaceAll('\\', '/'))
  .sort();

const injected = buildAssets.map((path) => JSON.stringify(path)).join(',\n  ');
await writeFile(workerPath, worker.replace(marker, injected)
  .replace(recipeMarker, recipeAssets.map((path) => JSON.stringify(path)).join(',\n  ')), 'utf8');

