import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from 'react';
import en from '../i18n/en.json';
import pt from '../i18n/pt.json';
import es from '../i18n/es.json';

export type Lang = 'en' | 'pt' | 'es';

export const LANGS: { id: Lang; label: string; flag: string }[] = [
  { id: 'en', label: 'English', flag: '🇺🇸' },
  { id: 'pt', label: 'Português', flag: '🇧🇷' },
  { id: 'es', label: 'Español', flag: '🇪🇸' },
];

const DICTS: Record<Lang, any> = { en, pt, es };
const KEY = 'maestrus_lang';

function readInitial(): Lang {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === 'en' || stored === 'pt' || stored === 'es') return stored;
  } catch {}
  return 'en';
}

function lookup(dict: any, path: string): string | undefined {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), dict);
}

function interpolate(str: string, vars?: Record<string, string | number>): string {
  if (!vars) return str;
  return str.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : `{${k}}`));
}

interface I18nCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const Ctx = createContext<I18nCtx>({ lang: 'en', setLang: () => {}, t: (k) => k });

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readInitial);

  useEffect(() => {
    document.documentElement.lang = lang;
    try { localStorage.setItem(KEY, lang); } catch {}
  }, [lang]);

  // Idioma cloud-backed (user_settings): no boot puxa a preferência do usuário;
  // ao trocar, grava no DB → o idioma segue o usuário em web/desktop/pwa.
  useEffect(() => {
    (async () => {
      try {
        const r = await (window as any).maestrus?.app?.getCloudSettings?.();
        const l = r?.settings?.lang;
        if (l === 'en' || l === 'pt' || l === 'es') setLangState(l);
      } catch {}
    })();
  }, []);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try { (window as any).maestrus?.app?.setCloudSetting?.('lang', l); } catch {}
  }, []);

  const t = useCallback((key: string, vars?: Record<string, string | number>): string => {
    const val = lookup(DICTS[lang], key) ?? lookup(DICTS.en, key) ?? key;
    return typeof val === 'string' ? interpolate(val, vars) : key;
  }, [lang]);

  return (
    <Ctx.Provider value={{ lang, setLang, t }}>
      {children}
    </Ctx.Provider>
  );
}

export function useT() {
  return useContext(Ctx);
}
