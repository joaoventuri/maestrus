import { createRoot } from 'react-dom/client';
import { installMaestrusWeb } from './lib/maestrus-web';
import { I18nProvider } from './lib/i18n';
import MobileApp from './mobile/MobileApp';
import './styles/mobile.css';
import './styles/jarvis.css';

// Altura REAL da área visível via VisualViewport API — a única coisa que
// acompanha a barra do Safari (que aparece/some) e o teclado com precisão. O
// 100dvh/100vh/position:fixed erram nesse device (input subia + faixa preta).
// A .m-screen usa var(--app-height); isso mantém o input SEMPRE colado no fundo
// visível, sem sobra preta, e acima do teclado quando ele abre.
// Diagnóstico OPT-IN (?debug): mostra as medidas reais do viewport NO APARELHO —
// pra achar de vez o que quebra o layout no Safari, sem chute. Some sem o ?debug.
const DEBUG = typeof location !== 'undefined' && /[?&]debug/.test(location.search);
let dbg: HTMLDivElement | null = null;
if (DEBUG) {
  dbg = document.createElement('div');
  dbg.style.cssText = 'position:fixed;top:env(safe-area-inset-top);left:0;right:0;z-index:99999;background:#ff8a3d;color:#000;font:600 11px/1.35 monospace;padding:6px 8px;white-space:pre;pointer-events:none;opacity:.92';
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(dbg!));
  setTimeout(() => { try { document.body.appendChild(dbg!); } catch {} }, 0);
}

function syncAppHeight() {
  const h = Math.round((window.visualViewport?.height ?? window.innerHeight));
  document.documentElement.style.setProperty('--app-height', h + 'px');
  if (dbg) {
    const vv = window.visualViewport;
    const sc = document.querySelector('.m-screen') as HTMLElement | null;
    const inp = document.querySelector('.m-inputwrap') as HTMLElement | null;
    const scr = sc?.getBoundingClientRect();
    const inr = inp?.getBoundingClientRect();
    dbg.textContent =
      `vv.h=${Math.round(vv?.height || 0)} inner=${window.innerHeight} docEl=${document.documentElement.clientHeight}\n` +
      `--app-height=${h}  screen.h=${scr ? Math.round(scr.height) : '?'} pos=${sc ? getComputedStyle(sc).position : '?'}\n` +
      `input.bottom=${inr ? Math.round(inr.bottom) : '?'}  blankBelow=${inr ? Math.round((vv?.height || window.innerHeight) - inr.bottom) : '?'}  bodyScroll=${document.body.scrollHeight > window.innerHeight + 2}`;
  }
}
syncAppHeight();
if (DEBUG) setInterval(syncAppHeight, 500);
window.visualViewport?.addEventListener('resize', syncAppHeight);
window.visualViewport?.addEventListener('scroll', syncAppHeight);
window.addEventListener('resize', syncAppHeight);
window.addEventListener('orientationchange', () => setTimeout(syncAppHeight, 250));

installMaestrusWeb();
createRoot(document.getElementById('root')!).render(
  <I18nProvider><MobileApp /></I18nProvider>
);
