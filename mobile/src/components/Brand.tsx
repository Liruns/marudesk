import logoMarkUrl from '../assets/logo-mark.png';

export function Brand({ size = 40 }: { size?: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <BrandGlyph size={size} />
      <div style={{ lineHeight: 1.1 }}>
        <div style={{ fontSize: size * 0.46, fontWeight: 600, letterSpacing: 0 }}>marudesk</div>
        <div style={{ fontSize: size * 0.26, color: 'var(--text-tertiary)', fontWeight: 400 }}>mobile bridge</div>
      </div>
    </div>
  );
}

export function BrandGlyph({ size = 40 }: { size?: number }) {
  return (
    <img
      src={logoMarkUrl}
      alt=""
      aria-hidden="true"
      draggable={false}
      style={{
        width: size,
        height: size,
        objectFit: 'contain',
        flexShrink: 0,
      }}
    />
  );
}
