import { brandIcon, fallbackMono } from '../lib/brand-icons';

/**
 * Logomarca de um conector. Usa o SVG oficial quando existe (simple-icons) e
 * cai num monograma colorido quando não — assim nenhum conector fica com o
 * mesmo ícone genérico do vizinho, que era o que deixava a lista de MCPs
 * indistinguível.
 *
 * `tint` desliga a cor da marca e usa currentColor: útil onde o colorido
 * brigaria com o layout (listas densas, estados desabilitados).
 */
export default function BrandLogo({ id, label, size = 22, tint = false }: {
  id: string;
  label?: string;
  size?: number;
  tint?: boolean;
}) {
  const icon = brandIcon(id) || fallbackMono(label || id);
  const color = tint ? 'currentColor' : icon.hex;

  if (icon.path) {
    return (
      <svg
        role="img" aria-label={icon.title} width={size} height={size}
        viewBox="0 0 24 24" fill={color} style={{ flex: 'none' }}
      >
        <path d={icon.path} />
      </svg>
    );
  }

  return (
    <span
      aria-label={icon.title} title={icon.title}
      style={{
        flex: 'none', width: size, height: size, borderRadius: size * 0.26,
        background: tint ? 'transparent' : icon.hex,
        border: tint ? '1px solid currentColor' : 'none',
        color: tint ? 'currentColor' : '#fff',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: size * (icon.mono && icon.mono.length > 1 ? 0.38 : 0.5),
        fontWeight: 700, letterSpacing: '-.02em', lineHeight: 1,
      }}
    >
      {icon.mono}
    </span>
  );
}
