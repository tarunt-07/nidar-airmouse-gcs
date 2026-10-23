// Bridge that lets non-map components request a PNG of the final map.
// MapPanel registers its exporter on mount.

export type MapExporter = () => string | null

let exporter: MapExporter | null = null

export function setMapExporter(fn: MapExporter | null): void {
  exporter = fn
}

export function exportFinalMap(): string | null {
  try {
    return exporter ? exporter() : null
  } catch {
    return null
  }
}
