const port = 8080;

function rand(min, max) { return Math.random() * (max - min) + min; }

// Keep trains within India bounds
const BOUNDS = { latMin: 6.465, latMax: 35.5133, lngMin: 68.1097, lngMax: 97.3956 };


const MAX_SPEED = 10; 
const NOISE = 0.003;    

let trains = Array.from({ length: 5 }).map((_, i) => ({
  id: `train-${i + 1}`,
  lat: 20.5937 + rand(-3, 3),
  lng: 78.9629 + rand(-3, 3),
  vx: rand(-0.00015, 0.00015),
  vy: rand(-0.00015, 0.00015),
}));

const conns = new Set();

Bun.serve({
  port,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response("WebSocket live at /", { status: 200 });
  },
  websocket: {
    open(ws) {
      conns.add(ws);
      ws.send(JSON.stringify(trains));
    },
    close(ws) { conns.delete(ws); },
  },
});

setInterval(() => {
  trains = trains.map(t => {
    let vx = t.vx + rand(-NOISE, NOISE);
    let vy = t.vy + rand(-NOISE, NOISE);
    // Clamp speeds
    vx = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, vx));
    vy = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, vy));

    let lat = t.lat + vy;
    let lng = t.lng + vx;

    if (lat < BOUNDS.latMin) { lat = BOUNDS.latMin + (BOUNDS.latMin - lat); vy = Math.abs(vy); }
    if (lat > BOUNDS.latMax) { lat = BOUNDS.latMax - (lat - BOUNDS.latMax); vy = -Math.abs(vy); }
    if (lng < BOUNDS.lngMin) { lng = BOUNDS.lngMin + (BOUNDS.lngMin - lng); vx = Math.abs(vx); }
    if (lng > BOUNDS.lngMax) { lng = BOUNDS.lngMax - (lng - BOUNDS.lngMax); vx = -Math.abs(vx); }

    return { ...t, lat, lng, vx, vy, popup: `🚆 ${t.id}` };
  });
  const payload = JSON.stringify(trains);
  for (const ws of conns) ws.send(payload);
}, 1000);

console.log("WS listening on ws://localhost:8080");