import iconUrl from '../assets/maestrus-icon.png';

interface Props {
  size?: number;
  textSize?: number;
  showText?: boolean;
  className?: string;
}

export default function Logo({ size = 22, textSize, showText = true, className }: Props) {
  const style = {
    '--maestrus-icon': `url(${iconUrl})`,
    '--maestrus-icon-size': `${size}px`,
    ...(textSize ? { '--maestrus-logo-text': `${textSize}px` } : {}),
  } as React.CSSProperties;
  return (
    <span className={`logo-wrap ${className || ''}`} style={style}>
      <span className="logo-icon" aria-hidden="true" />
      {showText && <span className="logo-text">maestrus</span>}
    </span>
  );
}
