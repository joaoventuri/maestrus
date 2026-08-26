// Toda chave usada em t('...') tem que existir nos 3 idiomas.
import fs from 'fs';
const langs = ['en','pt','es'].map(l => [l, JSON.parse(fs.readFileSync(`renderer/src/i18n/${l}.json`,'utf8'))]);
const get = (o,k) => k.split('.').reduce((a,p) => (a && typeof a==='object') ? a[p] : undefined, o);
const files = [];
(function walk(d){ for (const f of fs.readdirSync(d,{withFileTypes:true})) {
  const p = d+'/'+f.name;
  if (f.isDirectory()) walk(p); else if (/\.tsx?$/.test(f.name)) files.push(p);
}})('renderer/src');
const missing = [];
for (const f of files) {
  const src = fs.readFileSync(f,'utf8');
  for (const m of src.matchAll(/\bt\(\s*['"]([a-zA-Z0-9_.]+)['"]/g)) {
    if (m[1].endsWith('.')) continue; // prefixo montado em runtime (t('x.' + v))
    for (const [l,d] of langs) if (typeof get(d,m[1]) !== 'string') missing.push(`${l}: ${m[1]} (${f})`);
  }
}
if (missing.length) { console.log('CHAVES FALTANDO:'); console.log([...new Set(missing)].join('\n')); process.exit(1); }
console.log('i18n ok — todas as chaves existem nos 3 idiomas');
