// Gera o ícone do app: quadrado preto arredondado + maestro branco centralizado.
// Saídas: renderer/assets/icon.png (512, pra mac/linux/electron-builder) e
// renderer/assets/icon.ico (multi-resolução 16..256, pra Windows).
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'renderer', 'src', 'assets', 'maestrus-icon.png');
const OUT = path.join(__dirname, '..', 'renderer', 'assets');

async function badge(size) {
  const radius = Math.round(size * 0.22);
  const pad = Math.round(size * 0.12);
  const inner = size - pad * 2;
  const bg = Buffer.from(
    `<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="#0a0a0a"/></svg>`
  );
  const white = await sharp(SRC)
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .negate({ alpha: false })
    .toBuffer();
  return sharp(bg).composite([{ input: white, top: pad, left: pad }]).png().toBuffer();
}

(async () => {
  // PNG principal (512)
  fs.writeFileSync(path.join(OUT, 'icon.png'), await badge(512));
  console.log('icon.png gerado');

  // ICO multi-resolução pro Windows (png-to-ico é ESM → import dinâmico)
  const { default: pngToIco } = await import('png-to-ico');
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = [];
  for (const s of sizes) pngs.push(await badge(s));
  const ico = await pngToIco(pngs);
  fs.writeFileSync(path.join(OUT, 'icon.ico'), ico);
  console.log('icon.ico gerado (', sizes.join(','), ')');
})().catch((e) => { console.error(e); process.exit(1); });
