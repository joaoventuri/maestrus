import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { installBrowserFallback } from './lib/browser-fallback';
import { ThemeProvider } from './lib/theme';
import { I18nProvider } from './lib/i18n';
import './styles/maestrus.css';
import './styles/jarvis.css';

if (!(window as any).__maestrus_electron) {
  installBrowserFallback();
}

// Captura erros globais que escapam do React (ex.: promises, áudio) só pra log.
window.addEventListener('error', (e) => console.error('[maestrus] window error:', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => console.error('[maestrus] unhandled rejection:', (e as PromiseRejectionEvent).reason));

const root = createRoot(document.getElementById('root')!);
root.render(
  <ErrorBoundary>
    <I18nProvider>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </I18nProvider>
  </ErrorBoundary>
);
