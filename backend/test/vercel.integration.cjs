// Reproduce la transformación real de rewrites con el paquete oficial de Vercel.
// Herramienta de QA temporal; no requiere .env ni servicios externos.
const { getTransformedRoutes } = require(process.env.WHATER_ROUTING_UTILS || '@vercel/routing-utils');
const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const config = require('../../vercel.json');
const { createDailyRouter } = require('../src/routes/daily');
const { createReadingsRouter } = require('../src/routes/readings');

async function start(configuration) {
  const transformed = getTransformedRoutes(configuration);
  assert.equal(transformed.error, null);
  const routes = transformed.routes.filter((route) => route.src);
  const app = express();
  app.use((req, _res, next) => {
    const original = new URL(req.url, 'http://localhost');
    for (const route of routes) {
      const match = new RegExp(route.src).exec(original.pathname);
      if (!match) continue;
      const destination = new URL(route.dest.replace(/\$(\d+)/g, (_, i) => encodeURIComponent(match[Number(i)] || '')), 'http://localhost');
      // La plataforma conserva la URL pública que utiliza Express y combina
      // los parámetros generados por el rewrite con la consulta del usuario.
      for (const [key, value] of destination.searchParams) original.searchParams.append(key, value);
      req.url = original.pathname + original.search;
      break;
    }
    next();
  });
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.use('/api/readings', createReadingsRouter({ list: async () => [] }));
  app.use('/api', createDailyRouter({ sessions: async () => [], readings: async () => ({ readings: [] }), summary: async () => ({ total: 0 }) }));
  app.use(express.static(path.resolve(__dirname, '../../frontend')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}`, routes };
}

(async () => {
  let old, fixed;
  try {
    old = await start({ ...config, rewrites: [{ source: '/api/:path*', destination: '/api' }] });
    assert.equal(old.routes[0].dest, '/api?path=$1');
    const broken = await fetch(old.url + '/api/sesiones?fecha=2026-11-17');
    assert.equal(broken.status, 400);
    console.log('Reproducción: rewrite anterior añade path y produce HTTP 400');
    fixed = await start(config);
    assert.ok(fixed.routes.every((route) => !route.dest.includes('?')));
    for (const endpoint of ['/api/health', '/api/readings?limit=1', '/api/sesiones?fecha=2026-11-17', '/api/mediciones?fecha=2026-11-17', '/api/resumen?fecha=2026-11-17']) {
      assert.equal((await fetch(fixed.url + endpoint)).status, 200);
    }
    console.log('Corrección: cinco endpoints HTTP 200 sin parámetros de ruta adicionales');
    for (const endpoint of ['/api/sesiones?fecha=2026-11-17&foo=bar', '/api/sesiones?fecha=2026-11-17&fecha=2026-11-16', '/api/readings?limit=0']) {
      assert.equal((await fetch(fixed.url + endpoint)).status, 400);
    }
    const icon = await fetch(fixed.url + '/favicon.svg'); assert.equal(icon.status, 200); assert.match(icon.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(await (await fetch(fixed.url)).text(), /rel="icon"[^>]+href="\/favicon.svg"/);
    console.log('Validaciones HTTP 400 conservadas; favicon SVG y referencia HTML correctos');
  } finally {
    await Promise.all([old?.server, fixed?.server].filter(Boolean).map((server) => new Promise((resolve) => server.close(resolve))));
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
