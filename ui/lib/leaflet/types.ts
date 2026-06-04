// Общие типы Leaflet для проекта ЗПР. Используется на /plots/map и в
// components/ObjectPlotsTab.tsx. Без @types/leaflet (Leaflet подгружается через
// CDN-скрипт), но с минимально необходимым покрытием.
//
// Если двум потребителям нужны разные расширенные типы — расширяем здесь,
// а не дублируем `declare global`.

export type LeafletGlobal = {
  map: (el: HTMLElement, opts?: object) => LeafletMap
  tileLayer: (url: string, opts?: object) => LeafletLayer
  geoJSON: (data: object, opts?: object) => LeafletGeoJSON
}

export type LeafletMap = {
  setView: (latlng: [number, number], zoom: number) => LeafletMap
  fitBounds: (bounds: unknown, opts?: object) => LeafletMap
  remove: () => void
  removeLayer: (layer: LeafletLayer) => LeafletMap
  invalidateSize: () => void
}

export type LeafletLayer = { addTo: (map: LeafletMap) => LeafletLayer }

export type LeafletGeoJSON = LeafletLayer & {
  getBounds: () => unknown
  eachLayer: (fn: (l: unknown) => void) => void
  resetStyle: (l?: unknown) => void
  bringToBack: () => LeafletGeoJSON
  bringToFront: () => LeafletGeoJSON
}

declare global {
  interface Window {
    L?: LeafletGlobal
  }
}
