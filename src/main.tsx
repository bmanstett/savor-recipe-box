import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../app/globals.css';
import { trackKeyboardInset } from '../lib/keyboard-inset';
import { AppRoot } from './AppRoot';
import { ErrorBoundary } from './ErrorBoundary';

trackKeyboardInset();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <AppRoot />
    </ErrorBoundary>
  </StrictMode>,
);
