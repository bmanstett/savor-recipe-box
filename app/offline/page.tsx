import Link from 'next/link';

export default function OfflinePage() {
  return (
    <main className="fatal-error">
      <span aria-hidden="true">S</span>
      <p className="eyebrow">Offline</p>
      <h1>Your kitchen is still here.</h1>
      <p>Reopen the main app to use the latest recipes cached on this device. Internet imports and private sync will resume when you reconnect.</p>
      <Link className="button button-primary" href="/">Open Savor</Link>
    </main>
  );
}
