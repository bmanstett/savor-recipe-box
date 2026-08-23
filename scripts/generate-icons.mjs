import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const output = new URL('../public/icons/', import.meta.url);
await mkdir(output, { recursive: true });

function artwork(size, maskable = false) {
  const inset = maskable ? Math.round(size * 0.16) : Math.round(size * 0.08);
  const radius = maskable ? Math.round(size * 0.22) : Math.round(size * 0.2);
  const markSize = Math.round(size * 0.5);
  return Buffer.from(`
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${size}" height="${size}" fill="#f7f3e9"/>
      <rect x="${inset}" y="${inset}" width="${size - inset * 2}" height="${size - inset * 2}" rx="${radius}" fill="#345143"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${markSize / 2}" fill="#fffaf0"/>
      <text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-family="Georgia, serif" font-size="${Math.round(size * 0.33)}" font-weight="700" fill="#345143">S</text>
      <circle cx="${Math.round(size * 0.73)}" cy="${Math.round(size * 0.28)}" r="${Math.round(size * 0.045)}" fill="#b65f45"/>
    </svg>
  `);
}

await sharp(artwork(192)).png().toFile(fileURLToPath(new URL('icon-192.png', output)));
await sharp(artwork(512)).png().toFile(fileURLToPath(new URL('icon-512.png', output)));
await sharp(artwork(512, true)).png().toFile(fileURLToPath(new URL('icon-maskable-512.png', output)));
