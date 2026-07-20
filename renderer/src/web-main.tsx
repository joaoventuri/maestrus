// Entry do WEB APP desktop-like (servido em https://maestrus.cloud/web/).
// Monta o MESMO App.tsx do Electron, mas com o shim web real (maestrus-web)
// no lugar do preload IPC — fala direto com maestrus.cloud (fetch) e com o
// relay (WebSocket). Modo cliente: opera os containers cloud do usuário e,
// opcionalmente, máquinas pareadas por código (remote control).
import { createRoot } from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { installMaestrusWeb } from './lib/maestrus-web';
import { ThemeProvider } from './lib/theme';
import { I18nProvider } from './lib/i18n';
import './styles/maestrus.css';
import './styles/jarvis.css';

// Celular acessando /web → manda pro /app (PWA, feito pra toque). O web app
// desktop-like não é usável em telas pequenas. `?desktop=1` força ficar.
(() => {
  try {
    const isPhone = /Android|iPhone|iPod|Windows Phone|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
      || (/iPad|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document && Math.min(screen.width, screen.height) < 820)
      || Math.min(window.innerWidth, window.innerHeight) < 640;
    const forced = new URLSearchParams(location.search).has('desktop');
    if (isPhone && !forced) { location.replace('/app' + location.search + location.hash); }
  } catch {}
})();

installMaestrusWeb();

window.addEventListener('error', (e) => console.error('[maestrus-web] window error:', (e as ErrorEvent).error || (e as ErrorEvent).message));
window.addEventListener('unhandledrejection', (e) => console.error('[maestrus-web] unhandled rejection:', (e as PromiseRejectionEvent).reason));

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
