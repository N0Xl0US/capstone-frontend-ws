"use client"

import { useEffect, useMemo, useRef, useState } from "react"


/**
 * @typedef {{ id: string, lat: number, lng: number, popup?: string }} TrainUpdate
 */

const INDIA_CENTER = [20.5937, 78.9629]
const INDIA_BOUNDS = [
  [6.465, 68.1097],   // SW
  [35.5133, 97.3956], // NE
]
const LEAFLET_CSS_ID = "leaflet-css"
const LEAFLET_JS_ID = "leaflet-js"
const LEAFLET_VERSION = "1.9.4"
const LEAFLET_CSS = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.css`
const LEAFLET_JS = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.js`
const ICON_BASE = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/images/`


function easeInOutQuad(t) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
}

export default function RealTimeLeafletMap() {
  const center = useMemo(() => INDIA_CENTER, [])
  const [status, setStatus] = useState("disconnected")
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const markersRef = useRef(new Map()) 
  const animationsRef = useRef(new Map())
  const pathsRef = useRef(new Map()) // id -> { polyline, coords: L.LatLng[] }
  const MAX_PATH_POINTS = 500
  const MIN_SEGMENT_METERS = 5
  const isZoomingRef = useRef(false)
  const FOLLOW_PADDING_PX = 100
  const canvasRendererRef = useRef(null)
  const wsRef = useRef(null)
  const [selectedTrainId, setSelectedTrainId] = useState(null)
  const selectedTrainIdRef = useRef(null)
  useEffect(() => { selectedTrainIdRef.current = selectedTrainId }, [selectedTrainId])

  useEffect(() => {
    if (!document.getElementById(LEAFLET_CSS_ID)) {
      const link = document.createElement("link")
      link.id = LEAFLET_CSS_ID
      link.rel = "stylesheet"
      link.href = LEAFLET_CSS
      document.head.appendChild(link)
    }

    if (typeof window !== "undefined" && window.L) {
      initMap()
    } else if (!document.getElementById(LEAFLET_JS_ID)) {
      const script = document.createElement("script")
      script.id = LEAFLET_JS_ID
      script.src = LEAFLET_JS
      script.async = true
      script.defer = true
      script.onload = () => initMap()
      script.onerror = () => {
        // eslint-disable-next-line no-console
        console.error("Failed to load Leaflet from CDN")
      }
      document.body.appendChild(script)
    } else {
      const script = document.getElementById(LEAFLET_JS_ID)
      script?.addEventListener("load", initMap)
      return () => script?.removeEventListener("load", initMap)
    }

    function initMap() {
      if (!containerRef.current || mapRef.current || !window.L) return
      const L = window.L

      if (L?.Icon?.Default) {
        L.Icon.Default.mergeOptions({
          iconRetinaUrl: `${ICON_BASE}marker-icon-2x.png`,
          iconUrl: `${ICON_BASE}marker-icon.png`,
          shadowUrl: `${ICON_BASE}marker-shadow.png`,
        })
      }

      const map = L.map(containerRef.current, {
        center,
        zoom: 5,
        zoomAnimation: false,
        fadeAnimation: false,
        preferCanvas: true,
        minZoom: 3,
        maxZoom: 20,
        scrollWheelZoom: true,
        doubleClickZoom: true,
        zoomSnap: 0.25,
        wheelDebounceTime: 20,
        wheelPxPerZoomLevel: 80,
      })
      mapRef.current = map

      // Shared Canvas renderer to keep paths stable during view changes
      try {
        canvasRendererRef.current = L.canvas({ padding: 0.5 })
      } catch {}

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 20,
      }).addTo(map)

      // Fit to India on first load
      try {
        const bounds = L.latLngBounds(INDIA_BOUNDS)
        map.fitBounds(bounds, { padding: [20, 20], maxZoom: 6, animate: false })
      } catch {}

      map.on("zoomstart", () => {
        isZoomingRef.current = true
        animationsRef.current.forEach((cancel) => {
          if (typeof cancel === "function") {
            try { cancel() } catch {}
          }
        })
        animationsRef.current.clear()
      })

      map.on("zoomend", () => {
        isZoomingRef.current = false
        // If a train is selected, ensure it's centered after zoom
        try {
          const selId = selectedTrainIdRef.current
          if (selId) {
            const m = markersRef.current.get(selId)
            if (m) {
              const target = m.getLatLng()
              ensureWithinViewport(map, target, FOLLOW_PADDING_PX)
            }
          }
          // Apply a tiny nudge to force reprojection and eliminate residual artifacts
          nudgeMap(map)
        } catch {}
      })
    }

    return () => {
      if (mapRef.current) {
        try {
          mapRef.current.remove()
        } catch {}
        mapRef.current = null
      }
      markersRef.current.forEach((m) => {
        try {
          m.remove()
        } catch {}
      })
      markersRef.current.clear()
      pathsRef.current.forEach(({ polyline }) => {
        try {
          polyline.remove()
        } catch {}
      })
      pathsRef.current.clear()
    }
  }, [center])

  useEffect(() => {
    const wsUrl = "ws://localhost:8080"
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.addEventListener("open", () => setStatus("connected"))
    ws.addEventListener("close", () => setStatus("disconnected"))
    ws.addEventListener("error", () => setStatus("disconnected"))

    ws.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data)
        /** @type {TrainUpdate[]} */
        const updates = Array.isArray(data) ? data : [data]
        applyUpdates(updates)
      } catch (e) {
        console.warn("Invalid WS message:", e)
      }
    })

    return () => {
      try {
        ws.close()
      } catch {}
      wsRef.current = null
    }
  }, [])

  function applyUpdates(updates) {
    const L = window.L
    if (!L || !mapRef.current) return

    for (const u of updates) {
      if (!u || typeof u !== "object" || !u.id) continue
      const { id, lat, lng, popup } = u
      if (typeof lat !== "number" || typeof lng !== "number" || Number.isNaN(lat) || Number.isNaN(lng)) continue

      const existing = markersRef.current.get(id)
      if (!existing) {
        const m = L.circleMarker([lat, lng], {
          radius: 5,
          color: "#16a34a",
          weight: 2,
          fill: true,
          fillColor: "#16a34a",
          fillOpacity: 1,
          updateWhenZooming: true,
          updateWhenDragging: true,
          renderer: canvasRendererRef.current || undefined,
        }).addTo(mapRef.current)
        // Click to select and center
        try {
          m.on("click", () => {
            setSelectedTrainId(id)
          })
        } catch {}
        if (popup) m.bindPopup(popup)
        markersRef.current.set(id, m)
        ensurePathInitialized(id, [lat, lng])
      } else {
        const cancel = animationsRef.current.get(id)
        if (typeof cancel === "function") {
          try { cancel() } catch {}
        }
        const current = existing.getLatLng()
        const dLat = Math.abs(current.lat - lat)
        const dLng = Math.abs(current.lng - lng)
        const tinyMove = dLat < 0.00005 && dLng < 0.00005
        if (tinyMove || isZoomingRef.current) {
          existing.setLatLng([lat, lng])
        } else {
          const cancelNew = animateMarker(existing, [lat, lng])
          animationsRef.current.set(id, cancelNew)
        }
        if (popup) existing.bindPopup(popup)
        appendToPath(id, [lat, lng])

        // If this is the selected train, only pan when it leaves a padded viewport box
        if (selectedTrainIdRef.current === id && !isZoomingRef.current) {
          try {
            const map = mapRef.current
            if (map) {
              const target = window.L.latLng(lat, lng)
              const needsPan = !isPointWithinViewport(map, target, FOLLOW_PADDING_PX)
              if (needsPan) {
                map.panTo(target, { animate: true, duration: 0.25, easeLinearity: 0.2, noMoveStart: true })
              }
            }
          } catch {}
        }
      }
    }
  }

  function animateMarker(marker, targetLatLng) {
    const L = window.L
    const startLatLng = marker.getLatLng()
    const endLatLng = L.latLng(targetLatLng[0], targetLatLng[1])
    const deltaLat = Math.abs(endLatLng.lat - startLatLng.lat)
    const deltaLng = Math.abs(endLatLng.lng - startLatLng.lng)
    const distance = Math.sqrt(deltaLat * deltaLat + deltaLng * deltaLng)
    const duration = Math.min(1000, Math.max(200, distance * 6000))
    const start = performance.now()

    let rafId = null
    const step = (now) => {
      const elapsed = now - start
      const t = Math.min(1, elapsed / duration)
      const k = easeInOutQuad(t)
      const lat = startLatLng.lat + (endLatLng.lat - startLatLng.lat) * k
      const lng = startLatLng.lng + (endLatLng.lng - startLatLng.lng) * k
      marker.setLatLng([lat, lng])
      if (t < 1) {
        rafId = requestAnimationFrame(step)
      }
    }
    rafId = requestAnimationFrame(step)
    return () => rafId && cancelAnimationFrame(rafId)
  }

  // Center when a train is selected (clicked or programmatically)
  useEffect(() => {
    if (!selectedTrainId || !mapRef.current) return
    const marker = markersRef.current.get(selectedTrainId)
    if (!marker) return
    const target = marker.getLatLng()
    const map = mapRef.current
    const desiredZoom = Math.min(map.getMaxZoom(), Math.max(7, map.getZoom() + 2))
    try {
      map.setView(target, desiredZoom, { animate: false })
    } catch {}
  }, [selectedTrainId])

  // Expose a simple programmatic API for selecting a train by id
  useEffect(() => {
    if (typeof window === "undefined") return
    window.selectTrain = (id) => setSelectedTrainId(id)
    return () => { try { delete window.selectTrain } catch {} }
  }, [])

  // Press Escape to reset view to India and clear selection
  useEffect(() => {
    function resetToIndia() {
      const map = mapRef.current
      if (!map || !window.L) return
      try {
        const bounds = window.L.latLngBounds(INDIA_BOUNDS)
        map.fitBounds(bounds, { padding: [20, 20], maxZoom: 6, animate: false })
        setSelectedTrainId(null)
      } catch {}
    }
    function onKey(e) {
      const key = e.key || e.code
      if (key === "Escape" || key === "Esc") {
        e.preventDefault?.()
        resetToIndia()
      }
    }
    const node = containerRef.current
    window.addEventListener("keydown", onKey, true)
    document.addEventListener("keydown", onKey, true)
    node?.addEventListener?.("keydown", onKey, true)
    return () => {
      window.removeEventListener("keydown", onKey, true)
      document.removeEventListener("keydown", onKey, true)
      node?.removeEventListener?.("keydown", onKey, true)
    }
  }, [])

  function ensurePathInitialized(id, latLngArray) {
    const L = window.L
    if (!mapRef.current) return
    if (pathsRef.current.has(id)) return
    const coords = latLngArray.map((p) => L.latLng(p[0], p[1]))
    const polyline = L.polyline(coords, {
      color: "#16a34a",
      weight: 2,
      opacity: 0.8,
      updateWhenZooming: true,
      updateWhenDragging: true,
      renderer: canvasRendererRef.current || undefined,
    }).addTo(mapRef.current)
    pathsRef.current.set(id, { polyline, coords })
  }

  function appendToPath(id, latLng) {
    const L = window.L
    const map = mapRef.current
    if (!map) return
    if (!pathsRef.current.has(id)) {
      ensurePathInitialized(id, [latLng])
      return
    }
    const entry = pathsRef.current.get(id)
    const nextPoint = L.latLng(latLng[0], latLng[1])
    const prevPoint = entry.coords[entry.coords.length - 1]
    const distance = map.distance(prevPoint, nextPoint)
    if (distance < MIN_SEGMENT_METERS) return
    entry.coords.push(nextPoint)
    if (entry.coords.length > MAX_PATH_POINTS) {
      entry.coords.splice(0, entry.coords.length - MAX_PATH_POINTS)
      entry.polyline.setLatLngs(entry.coords)
    } else {
      // Incremental add to avoid full reprojection each frame
      try { entry.polyline.addLatLng(nextPoint) } catch { entry.polyline.setLatLngs(entry.coords) }
    }
  }

  function isPointWithinViewport(map, latlng, paddingPx) {
    try {
      const size = map.getSize()
      const p = map.latLngToContainerPoint(latlng)
      const left = paddingPx
      const top = paddingPx
      const right = size.x - paddingPx
      const bottom = size.y - paddingPx
      return p.x >= left && p.x <= right && p.y >= top && p.y <= bottom
    } catch {
      return true
    }
  }

  function ensureWithinViewport(map, latlng, paddingPx) {
    if (!isPointWithinViewport(map, latlng, paddingPx)) {
      try { map.panTo(latlng, { animate: false }) } catch {}
    }
  }

  function nudgeMap(map) {
    try {
      map.panBy([1, 1], { animate: false })
      map.panBy([-1, -1], { animate: false })
    } catch {}
  }

  // Using circle markers, no custom icon needed

  const statusDotClass = status === "connected" ? "bg-green-500" : "bg-red-500"

  return (
    <section className="rounded-lg border border-gray-700 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Live Map</h2>
        <div className="flex items-center gap-2">
          <span
            className={`inline-block h-2.5 w-2.5 rounded-full ${statusDotClass}`}
            aria-label={status}
            title={status}
          />
          <span className="text-sm text-gray-400 capitalize">{status}</span>
        </div>
      </div>

      <div ref={containerRef} className="h-[80vh] w-full rounded-md" role="region" aria-label="Real-time train map" />

      <p className="mt-2 text-xs text-gray-500">
        Connect a WebSocket server at ws://localhost:8080 to stream train updates.
      </p>
    </section>
  )
}
