/** The marudesk wordmark + glyph used on the auth/connect screens. */
export function Brand({ size = 40 }: { size?: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <BrandGlyph size={size} />
      <div style={{ lineHeight: 1.1 }}>
        <div style={{ fontSize: size * 0.5, fontWeight: 700, letterSpacing: '-0.02em' }}>marudesk</div>
        <div style={{ fontSize: size * 0.28, color: 'var(--fg-faint)', fontWeight: 500 }}>mobile bridge</div>
      </div>
    </div>
  );
}

/** A simple rounded-square monogram in the brand accent. */
export function BrandGlyph({ size = 40 }: { size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.28,
        background: 'linear-gradient(150deg, var(--accent), var(--accent-strong))',
        display: 'grid',
        placeItems: 'center',
        color: 'var(--on-accent)',
        fontWeight: 800,
        fontSize: size * 0.5,
        boxShadow: '0 6px 18px rgba(109,139,255,0.4)',
        flexShrink: 0,
      }}
    >
      m
    </div>
  );
}
