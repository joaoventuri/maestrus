import { createRoot } from 'react-dom/client';
import { installMaestrusWeb } from './lib/maestrus-web';
import { I18nProvider } from './lib/i18n';
import MobileApp from './mobile/MobileApp';
import './styles/mobile.css';
import './styles/jarvis.css';

installMaestrusWeb();
createRoot(document.getElementById('root')!).render(
  <I18nProvider><MobileApp /></I18nProvider>
);
