import type { Metadata, Viewport } from 'next';
import './globals.css';

const title = 'Savor — Your household cookbook';
const description = 'Save recipes from anywhere, plan the week, and shop from one beautifully organized list.';

export const metadata: Metadata = {
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
  openGraph: { title, description, type: 'website', siteName: 'Savor' },
  twitter: { card: 'summary_large_image', title, description },
};

export const viewport: Viewport = {
  width: 'device-width', initialScale: 1, viewportFit: 'cover',
  themeColor: '#f7f3e9', colorScheme: 'light',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
