import { env } from 'cloudflare:workers';
import { HOUSEHOLD_ID } from '../../../../lib/server/database';
import { apiError, requireApiUser } from '../../../../lib/server/http';

type Context = { params: Promise<{ key: string[] }> };

export async function GET(_request: Request, context: Context) {
  const user = await requireApiUser();
  if (!user) return apiError('Sign in to view this recipe image.', 401);
  if (!env.FILES) return apiError('Image storage is unavailable.', 503);
  const { key: parts } = await context.params;
  const key = parts.join('/');
  if (!new RegExp(`^uploads/${HOUSEHOLD_ID}/[0-9a-f-]{36}\\.(?:jpg|png|webp|heic|heif)$`, 'i').test(key)) {
    return apiError('Image not found.', 404);
  }
  const object = await env.FILES.get(key);
  if (!object?.body) return apiError('Image not found.', 404);
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; sandbox",
    },
  });
}
