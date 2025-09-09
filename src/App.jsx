"use client"
import RealTimeLeafletMap from "./components/RealTimeLeafletMap.jsx"

export default function App() {
  return (
    <main className="min-h-screen bg-gray-900 text-white">
      <div className="mx-auto max-w-6xl px-4 py-8">
        <header className="flex items-center justify-between">
          <h1 className="text-pretty text-4xl font-bold text-white text-center w-full">{" Train Tracker"}</h1>
        </header>

        <div className="mt-6">
          <RealTimeLeafletMap />
        </div>
      </div>
    </main>
  )
}
