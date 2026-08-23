import { NextResponse } from 'next/server';
import { env } from 'cloudflare:workers';
import { makeId } from '../../../lib/domain';
import { HOUSEHOLD_ID, saveAttachmentMetadata } from '../../../lib/server/database';
import { apiError, cleanText, requireApiUser } from '../../../lib/server/http';

const MAX_UPLOAD = 10 * 1024 * 1024;
const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

function matchesMagic(bytes: Uint8Array, mime: string): boolean {
  if (mime === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === 'image/png') return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (mime === 'image/webp') return String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  if (mime === 'image/heic' || mime === 'image/heif') {
    const signature = String.fromCharCode(...bytes.slice(4, 16));
    return signature.startsWith('ftyp') && /(heic|heix|hevc|hevx|heif|mif1)/i.test(signature);
  }
  return false;
}

export async function POST(request: Request) {
  const user = await requireApiUser();
  if (!user) return apiError('Sign in before uploading a recipe image.', 401);
  if (!env.FILES) return apiError('Image storage is not configured.', 503, ['Continue without a photo']);
  try {
    const contentLength = Number(request.headers.get('content-length') ?? 0);
    if (contentLength > MAX_UPLOAD + 512 * 1024) return apiError('Images must be smaller than 10 MB.', 413);
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return apiError('Choose an image to upload.', 400);
    if (!MIME_EXTENSIONS[file.type]) return apiError('Use a JPEG, PNG, WebP, HEIC, or HEIF image.', 415);
    if (!file.size || file.size > MAX_UPLOAD) return apiError('Images must be smaller than 10 MB.', 413);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!matchesMagic(bytes, file.type)) return apiError('This file does not appear to be a valid image.', 415);
    const id = makeId('attachment');
    const key = `uploads/${HOUSEHOLD_ID}/${crypto.randomUUID()}.${MIME_EXTENSIONS[file.type]}`;
    await env.FILES.put(key, bytes, {
      httpMetadata: { contentType: file.type, cacheControl: 'private, max-age=3600' },
      customMetadata: { household: HOUSEHOLD_ID, attachmentId: id },
    });
    const originalFilename = cleanText(file.name, 240) || 'recipe-image';
    try {
      await saveAttachmentMetadata({
        id, householdId: HOUSEHOLD_ID, recipeId: null, storageKey: key,
        mimeType: file.type, originalFilename, byteSize: file.size, createdAt: new Date().toISOString(),
      });
    } catch (error) {
      await env.FILES.delete(key).catch(() => undefined);
      throw error;
    }
    return NextResponse.json({
      attachment: {
        id, type: 'original-photo', url: `/api/files/${key}`, mimeType: file.type,
        originalFilename, captureDate: new Date().toISOString(),
      },
      message: 'Photo attached. Review and transcribe the recipe before saving.',
    }, { status: 201 });
  } catch {
    return apiError('The image could not be uploaded.', 500, ['Try a smaller image', 'Continue without a photo']);
  }
}
