'use client';

import { AlertCircle, RefreshCw } from 'lucide-react';

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="fatal-error">
      <span><AlertCircle size={25} /></span>
      <p className="eyebrow">Your data is safe</p>
      <h1>Savor couldn’t open the cookbook.</h1>
      <p>Nothing was deleted. Check your connection and try opening it again.</p>
      <button className="button button-primary" type="button" onClick={reset}><RefreshCw size={17} />Try again</button>
    </main>
  );
}
