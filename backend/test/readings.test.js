const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { parseReadingFilters, listReadings } = require('../src/services/readings');
const { createReadingsRouter } = require('../src/routes/readings');
const { limaDayRange } = require('../../frontend/js/time');

test('valida límite, dispositivo, fechas y parámetros repetidos', () => {
  assert.deepEqual(parseReadingFilters({}), { limit: 200 });
  assert.equal(parseReadingFilters({ limit: '1000' }).limit, 1000);
  assert.equal(parseReadingFilters({ from: '2026-11-16T00:00:00-05:00' }).from, '2026-11-16T05:00:00.000Z');
  for (const query of [
    { limit: '0' }, { limit: '-1' }, { limit: '1001' }, { limit: '1.5' }, { limit: '1e2' },
    { limit: '' }, { limit: ['1', '2'] }, { device_id: ' ' }, { device_id: 'a'.repeat(129) },
    { from: '2026-02-30T00:00:00Z' }, { from: '2026-11-16' }, { from: '2026-11-16T00:00:00' },
    { from: '2026-11-16T24:00:00Z' }, { unexpected: '1' },
    { from: '2026-11-17T00:00:00Z', to: '2026-11-16T00:00:00Z' },
    { from: '2026-11-16T00:00:00Z', before: '2026-11-16T00:00:00Z' },
    { to: '2026-11-16T00:00:00Z', before: '2026-11-17T00:00:00Z' }
  ]) assert.throws(() => parseReadingFilters(query));
});

test('consulta JSONB con filtros antes del límite y devuelve solo los campos públicos en UTC', async () => {
  let requested;
  const row = { id: '00000000-0000-4000-8000-000000000001', datos: { device_id: 'sensor/uno', temperatura: 0, humedad: 50, presion: 1013, privado: 'no devolver' }, created_at: '2026-11-16T21:00:00.123456-05:00' };
  const client = createClient('https://example.invalid', 'test-key', { global: { fetch: async (url, options) => {
    requested = new URL(url);
    assert.equal(options.method, 'GET');
    return new Response(JSON.stringify([row]), { headers: { 'Content-Type': 'application/json' } });
  } } });
  const range = limaDayRange('2026-11-16');
  const result = await listReadings({ limit: 10, device_id: 'sensor/uno', ...range }, () => client);
  assert.equal(requested.pathname, '/rest/v1/mediciones');
  assert.equal(requested.searchParams.get('select'), 'id,datos,created_at');
  assert.equal(requested.searchParams.get('order'), 'created_at.desc,id.desc');
  assert.equal(requested.searchParams.get('limit'), '10');
  assert.equal(requested.searchParams.get('datos->>device_id'), 'eq.sensor/uno');
  assert.deepEqual(requested.searchParams.getAll('created_at'), ['gte.2026-11-16T05:00:00.000Z', 'lt.2026-11-17T05:00:00.000Z']);
  assert.deepEqual(result, [{ id: row.id, device_id: 'sensor/uno', temperatura: 0, humedad: 50, presion: 1013, created_at: '2026-11-17T02:00:00.123456Z' }]);
});

test('tolera campos históricos ausentes y propaga errores sin detalles privados', async () => {
  const client = createClient('https://example.invalid', 'test-key', { global: { fetch: async () => new Response(JSON.stringify([{ id: 'test', datos: null, created_at: '2026-11-16T00:00:00Z' }])) } });
  const [row] = await listReadings({ limit: 1 }, () => client);
  assert.equal(row.temperatura, null);
  assert.equal(row.device_id, null);
  const failed = createClient('https://example.invalid', 'test-key', { global: { fetch: async () => new Response(JSON.stringify({ message: 'private-secret' }), { status: 403 }) } });
  await assert.rejects(listReadings({ limit: 1 }, () => failed), { message: 'No se pudieron consultar las mediciones' });
});

test('API HTTP devuelve 200, 400 y 503, sin caché ni errores privados', async (t) => {
  const app = express();
  let fail = false;
  let calls = 0;
  app.use('/api/readings', createReadingsRouter({ list: async (filters) => {
    calls++;
    if (fail) throw new Error('private-secret');
    assert.equal(filters.limit, 2);
    return [];
  }, logger: { error() {} } }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/readings`;
  let response = await fetch(`${url}?limit=2`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { readings: [], meta: { limit: 2, count: 0 } });
  for (const query of ['limit=0', 'limit=1&limit=2', 'device_id=a&device_id=b', 'from=2026-11-16']) {
    response = await fetch(`${url}?${query}`);
    assert.equal(response.status, 400);
  }
  assert.equal(calls, 1);
  fail = true;
  response = await fetch(`${url}?limit=2`);
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes('private-secret'));
});
