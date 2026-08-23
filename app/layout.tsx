import type { Metadata, Viewport } from 'next';
import './globals.css';

const title = 'Savor — Your household cookbook';
const description = 'Save recipes from anywhere, plan the week, and shop from one beautifully organized list.';
const siteUrl = new URL('https://savor-recipe-box.bret-anstett.chatgpt.site');

export const metadata: Metadata = {
  metadataBase: siteUrl,
  title: { default: title, template: '%s — Savor' },
  description,
  applicationName: 'Savor',
  manifest: '/manifest.webmanifest',
  formatDetection: { telephone: false },
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'Savor' },
  icons: {
    icon: [
      { url: '/icons/icon-192.png', type: 'image/png', sizes: '192x192' },
      { url: '/icons/icon-512.png', type: 'image/png', sizes: '512x512' },
    ],
    apple: [{ url: '/icons/icon-192.png', type: 'image/png', sizes: '192x192' }],
  },
  openGraph: {
    title, description, type: 'website', siteName: 'Savor', url: '/',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Savor — Your recipes. One place.' }],
  },
  twitter: { card: 'summary_large_image', title, description, images: ['/og.png'] },
};

export const viewport: Viewport = {
  width: 'device-width', initialScale: 1, viewportFit: 'cover',
  themeColor: '#f7f3e9', colorScheme: 'light',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
