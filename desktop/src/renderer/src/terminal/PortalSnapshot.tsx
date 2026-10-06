import { useEffect, useRef } from 'react'

/** A still of the portal view, painted inside the host panel while a host overlay (the
 *  command menu) has the native view hidden — so the panel looks unchanged under the menu
 *  instead of flashing to the projects list. Drawn on a canvas from JPEG bytes (no data: URL,
 *  so the renderer's CSP stays `default-src 'self'`). */
export default function PortalSnapshot({ image }: { image: ImageBitmap }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    canvas.width = image.width
    canvas.height = image.height
    canvas.getContext('2d')?.drawImage(image, 0, 0)
  }, [image])
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-20 bg-card">
      <canvas ref={ref} className="h-full w-full" />
      <div className="absolute inset-0 bg-[var(--scrim-soft)]" />
    </div>
  )
}

/** Decode the bridge's JPEG bytes (null when no view is showing or the decode fails). */
export async function decodeSnapshot(bytes: Uint8Array | null | undefined): Promise<ImageBitmap | null> {
  if (!bytes || bytes.byteLength === 0 || typeof createImageBitmap !== 'function') return null
  try {
    return await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/jpeg' }))
  } catch {
    return null
  }
}
