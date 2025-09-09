const port = 8080;

function rand(min, max) { return Math.random() * (max - min) + min; }

let trains = Array.from({ length: 5 }).map((_, i) => ({
  id: `train-${i + 1}`,
  lat: 20.5937 + rand(-5, 5),
  lng: 78.9629 + rand(-5, 5),
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
  trains = trains.map(t => ({
    ...t,
    lat: t.lat + rand(-0.2, 0.2),
    lng: t.lng + rand(-0.2, 0.2),
    popup: `🚆 ${t.id}`,
  }));
  const payload = JSON.stringify(trains);
  for (const ws of conns) ws.send(payload);
}, 1000);

console.log("WS listening on ws://localhost:8080");