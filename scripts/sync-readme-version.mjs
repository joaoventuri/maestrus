// Mantém os links de download do README na versão do package.json.
// Sem isto, cada release exige editar 5 lugares na mão e um deles fica para trás.
import fs from 'fs';
const v = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const p = 'README.md';
let s = fs.readFileSync(p, 'utf8');
const before = s;
s = s.replace(/maestrus-win-\d+\.\d+\.\d+\.exe/g, `maestrus-win-${v}.exe`)
     .replace(/maestrus-mac-\d+\.\d+\.\d+\.dmg/g, `maestrus-mac-${v}.dmg`)
     .replace(/Latest release \*\*v\d+\.\d+\.\d+\*\*/g, `Latest release **v${v}**`);
if (s !== before) { fs.writeFileSync(p, s); console.log(`README atualizado para v${v}`); }
else console.log(`README já está em v${v}`);
