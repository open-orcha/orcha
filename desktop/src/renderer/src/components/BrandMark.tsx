/** Embodent "Halo E" mark geometry, in the mark units of resources/logo-mark.svg (centred on
 *  -57,0): a solid E (CORE) inside an outer halo arc (HALO) drawn at 50% — one colour. */
const HALO = 'M390 -504 L0 -504 A504 504 0 0 0 0 504 L390 504 M0 0 L330 0'
const CORE = 'M390 -354 L0 -354 A354 354 0 0 0 0 354 L390 354 M0 0 L330 0'
export const MARK_LIGHT = '#ECEDF1'
export const MARK_TILE = '#121314'

/** The tile is a square centred on the mark (1098×1212 units, centre -57,0) with margin. */
const TILE = { x: -1017, y: -960, side: 1920, rx: 432 }

/** The Embodent product mark, always on its own dark rounded tile (#121314) so it reads on both
 *  the light and the dark canvas. Square: `size` is the side. Decorative (aria-hidden) — the
 *  product name next to it is the accessible text. */
export function BrandMark({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox={`${TILE.x} ${TILE.y} ${TILE.side} ${TILE.side}`}
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
      data-testid="brand-mark"
    >
      <rect x={TILE.x} y={TILE.y} width={TILE.side} height={TILE.side} rx={TILE.rx} fill={MARK_TILE} />
      <g fill="none" stroke={MARK_LIGHT} strokeWidth={204} strokeLinecap="round" strokeLinejoin="round">
        <path d={HALO} strokeOpacity={0.5} />
        <path d={CORE} />
      </g>
    </svg>
  )
}
