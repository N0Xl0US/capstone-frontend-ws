"use client"

import { useEffect, useMemo, useRef, useState } from "react"


/**
 * @typedef {{ id: string, lat: number, lng: number, popup?: string }} TrainUpdate
 */

const INDIA_CENTER = [20.5937, 78.9629]
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
  const wsRef = useRef(null)

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
      })
      mapRef.current = map

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(map)
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
        const m = L.marker([lat, lng]).addTo(mapRef.current)
        if (popup) m.bindPopup(popup)
        markersRef.current.set(id, m)
      } else {  
        animateMarker(existing, [lat, lng])
        if (popup) existing.bindPopup(popup)
      }
    }
  }

  function animateMarker(marker, targetLatLng) {
    const L = window.L
    const startLatLng = marker.getLatLng()
    const endLatLng = L.latLng(targetLatLng[0], targetLatLng[1])
    const duration = 1000
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
