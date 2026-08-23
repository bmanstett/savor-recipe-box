import { NextResponse } from 'next/server';
import { getBootstrapData } from '../../../lib/server/database';
import { apiError, requireApiUser } from '../../../lib/server/http';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await requireApiUser();
  if (!user) return apiError('Sign in to open your household cookbook.', 401);
  try {
    const data = await getBootstrapData({ displayName: user.displayName, email: user.email });
    return NextResponse.json(data, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch {
    return apiError('Your cookbook could not be opened right now.', 503, ['Try again', 'Check your connection']);
  }
}
