import { useEffect, useState } from 'react';

// Barra de título custom estilo macOS — usada no Windows/Linux (onde a janela
// é frameless). Os "semáforos" ficam à esquerda: fechar (vermelho), minimizar
// (amarelo), maximizar (verde). A barra inteira é região de arraste.
export default function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  const win = window.maestrus?.win;

  useEffect(() => {
    if (!win) return;
    win.isMaximized().then(setMaximized).catch(() => {});
    const off = win.onMaximizeChange(setMaximized);
    return off;
  }, []);

  // mac usa os controles nativos; browser/demo não tem janela.
  if (!win || window.maestrus?.platform === 'darwin') return null;

  return (
    <div className="titlebar" onDoubleClick={() => win.maximize()}>
      <div className="traffic-lights" onDoubleClick={(e) => e.stopPropagation()}>
        <button className="tl tl-close" onClick={() => win.close()} aria-label="Close" />
        <button className="tl tl-min" onClick={() => win.minimize()} aria-label="Minimize" />
        <button className="tl tl-max" onClick={() => win.maximize()} aria-label={maximized ? 'Restore' : 'Maximize'} />
      </div>
      <div className="titlebar-title">Maestrus</div>
    </div>
  );
}
