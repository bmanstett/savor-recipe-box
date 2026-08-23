import { NextResponse } from 'next/server';
import { getChatGPTUser } from '../../app/chatgpt-auth';

export async function requireApiUser() {
  return getChatGPTUser();
}

export function apiError(message: string, status = 400, recovery?: string[]) {
  return NextResponse.json({ error: message, recovery: recovery ?? [] }, { status });
}

export function cleanText(value: unknown, maxLength = 1_000): string {
  return typeof value === 'string'
    ? value.normalize('NFKC').replace(/\0/g, '').slice(0, maxLength).trim()
    : '';
}

export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    if (url.port && !((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80'))) return null;
    if (isPrivateHostname(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.home')) return true;
  // Direct IP literals are unnecessary for recipe imports and are rejected in
  // every representation, including IPv4-mapped IPv6 and numeric shorthand.
  if (host.includes(':') || /^\d+(?:\.\d+){3}$/.test(host)) return true;
  if (/^(0|10|127)\./.test(host) || /^169\.254\./.test(host) || /^192\.168\./.test(host)) return true;
  const match172 = host.match(/^172\.(\d+)\./);
  if (match172 && Number(match172[1]) >= 16 && Number(match172[1]) <= 31) return true;
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return true;
  if (/^\d+$/.test(host) || /^0x/i.test(host)) return true;
  return false;
}
