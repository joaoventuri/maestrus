'use strict';
// afterPack (electron-builder): assina o .app em AD-HOC no macOS.
//
// Por quê: um app arm64 (Apple Silicon) sem NENHUMA assinatura é morto pelo
// Gatekeeper com "o app está corrompido, mande pro Lixo". O `identity: null`
// que estava no build desligava até a assinatura ad-hoc automática do
// electron-builder — por isso o .dmg vinha "corrompido". Aqui forçamos a
// assinatura ad-hoc (codesign --sign -) pra garantir, mesmo sem certificado.
//
// Ad-hoc NÃO é notarização: na 1ª abertura o usuário ainda faz clique-direito →
// Abrir (ou `xattr -cr` no .app). Mas remove a parede do "corrompido". A
// solução definitiva (abrir sem nenhum aviso) é Apple Developer ID + notarize,
// que exige conta paga e secrets no CI.

const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
    console.log('[after-pack-mac] ad-hoc signed:', appPath);
  } catch (e) {
    console.warn('[after-pack-mac] ad-hoc sign falhou (segue o build):', e && (e.message || e));
  }
};
