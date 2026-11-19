import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { WebSocketServer } from 'ws';
import { config } from './config.ts';
import { catalog } from './routes/catalog.ts';
import { media } from './routes/media.ts';
import { personal } from './routes/personal.ts';
import { handleConnection, persistAll } from './rooms/roomManager.ts';
import { runHealthChecks } from './sources/registry.ts';
import { metadata } from './metadata/index.ts';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.get('/api/health', (_req, res) => res.json({ ok: true, time: Date.now(), metadata: metadata().id }));
app.use('/api', catalog, personal, media);
app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

const server = http.createServer(app);

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
wss.on('connection', (ws) => handleConnection(ws));
server.on('upgrade', (req, socket, head) => {
  if (req.url?.startsWith('/ws')) wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// Keep-alive so dead mobile connections are detected
setInterval(() => {
  for (const ws of wss.clients) {
    const w = ws as typeof ws & { alive?: boolean };
    if (w.alive === false) { ws.terminate(); continue; }
    w.alive = false;
    ws.ping();
  }
}, 20000).unref();
wss.on('connection', (ws) => { const w = ws as typeof ws & { alive?: boolean }; w.alive = true; ws.on('pong', () => { w.alive = true; }); });

async function start() {
  const dist = path.join(config.root, 'web', 'dist');
  if (config.production && fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '7d', setHeaders: (res, p) => p.endsWith('.html') && res.setHeader('Cache-Control', 'no-cache') }));
    app.get(/^(?!\/api|\/ws).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  } else {
    // Dev: Vite runs inside this server so the app, API and WebSocket share one port (easy LAN testing).
    const { createServer } = await import('vite');
    const vite = await createServer({ configFile: path.join(config.root, 'web', 'vite.config.ts'), server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
    app.use(vite.middlewares);
  }
  server.listen(config.port, config.host, () => {
    console.log(`\n  SyncRoom running → http://localhost:${config.port}  (${config.production ? 'production' : 'development'})`);
    console.log(`  Metadata: ${metadata().name}\n`);
  });
  runHealthChecks().catch(() => {});
  setInterval(() => runHealthChecks().catch(() => {}), 10 * 60_000).unref();
  // Warm the home catalogue (stale-while-revalidate keeps it fresh afterwards)
  metadata().home().catch((e) => console.warn('[warmup]', e.message));
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { persistAll(); process.exit(0); });

start();
