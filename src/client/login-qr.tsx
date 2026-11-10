/** Render login challenges locally with a four-module white quiet zone. */
import { useMemo } from 'react'
import qrcode from 'qrcode-generator'

export function LoginQr({ value, label, failure }: { value: string; label: string; failure: string }) {
  const matrix = useMemo(() => {
    try {
      if (value.length > 4096) return undefined
      const code = qrcode(0, 'M')
      code.addData(value, 'Byte'); code.make()
      const count = code.getModuleCount()
      const path: string[] = []
      for (let row = 0; row < count; row += 1) for (let col = 0; col < count; col += 1) {
        if (code.isDark(row, col)) path.push(`M${col + 4},${row + 4}h1v1h-1z`)
      }
      return { size: count + 8, path: path.join('') }
    } catch { return undefined }
  }, [value])
  if (!matrix) return <p className="dt-error" role="alert">{failure}</p>
  return <svg className="dt-login-qr" role="img" aria-label={label} viewBox={`0 0 ${matrix.size} ${matrix.size}`} shapeRendering="crispEdges">
    <rect width={matrix.size} height={matrix.size} fill="#fff" /><path d={matrix.path} fill="#000" />
  </svg>
}
