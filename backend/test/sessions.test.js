const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { parseDailyFilters, listDayReadings, listDaySessions, daySummary, groupSessions, encodeCursor, decodeCursor } = require('../src/services/daily');
const { parseMqttPayload } = require('../src/services/sessions');
const { createClient } = require('@supabase/supabase-js');
const { saveReading } = require('../src/services/readings');
const { createDailyRouter } = require('../src/routes/daily');
const { loadAllPages, selectedRows, summarize } = require('../../frontend/js/dashboard-model');
const { chartModel, pointPath } = require('../../frontend/js/charts');
const { todayLima } = require('../../frontend/js/time');
const id = '00000000-0000-4000-8000-000000000001';
const bytes = (value) => Buffer.from(JSON.stringify(value));

test('día de Lima, selección múltiple y cursores se validan sin limitar el histórico', () => {
  const filters = parseDailyFilters({ fecha: '2026-11-16', session_ids: `${id},legacy`, page_size: '500' });
  assert.equal(filters.from, '2026-11-16T05:00:00.000Z');
  assert.equal(filters.before, '2026-11-17T05:00:00.000Z');
  assert.deepEqual(filters.sessions, [id, 'legacy']);
  assert.deepEqual(parseDailyFilters({ fecha: '2026-11-16', session_ids: '' }).sessions, []);
  assert.deepEqual(parseDailyFilters({ fecha: '2026-11-16', session_ids: 'sesion_historica_1' }).sessions, ['sesion_historica_1']);
  for (const query of [{}, { fecha: '2026-02-30' }, { fecha: '2026-11-16', session_ids: ' ' }, { fecha: '2026-11-16', after: '-1' }, { fecha: '2026-11-16', snapshot: '1', after: '2' }, { fecha: '2026-11-16', page_size: '501' }]) assert.throws(() => parseDailyFilters(query));
  assert.equal(todayLima(new Date('2026-11-17T02:00:00Z')), '2026-11-16');
});

test('eventos MQTT, secuencias y compatibilidad con mensajes sin sesión', () => {
  const reading = { device_id: 'test', temperatura: 20, humedad: 60, presion: 1013 };
  assert.deepEqual(parseMqttPayload(bytes(reading)), reading);
  for (const event of ['session_start', 'session_end']) assert.equal(parseMqttPayload(bytes({ event, device_id: 'test', session_id: id })).event, event);
  assert.equal(parseMqttPayload(bytes({ ...reading, session_id: id, seq: 0 })).seq, 0);
  assert.equal(parseMqttPayload(bytes({ ...reading, session_id: 'sesion_historica_1' })).session_id, 'sesion_historica_1');
  for (const extra of [{ session_id: '' }, { session_id: id, seq: -1 }, { session_id: {}, seq: 0 }, { event: 'unknown' }, { captured_at: '2026-11-16T00:00:00' }]) assert.throws(() => parseMqttPayload(bytes({ ...reading, ...extra })));
});

test('ingesta guarda sesión en JSONB y serializa duplicados sin RPC ni columnas auxiliares', async () => {
  const payload = { device_id: 'test', session_id: id, seq: 1, captured_at: '2026-11-16T14:00:00Z' };
  const stored = [];
  const client = { from(table) {
    assert.equal(table, 'mediciones');
    return { select() { return this; }, eq() { return this; }, limit() { return this; },
      async abortSignal() { return { data: stored.length ? [{ id }] : [], error: null }; },
      async insert(row) { assert.deepEqual(row, { datos: payload }); stored.push(row); return { error: null }; }
    };
  } };
  const results = await Promise.all([saveReading(payload, () => client), saveReading(payload, () => client)]);
  assert.deepEqual(results, [{ duplicate: false }, { duplicate: true }]);
  assert.equal(stored.length, 1);
});

test('paginación carga más de 1000 registros y consultas incrementales no recargan historia', async () => {
  const rows = Array.from({ length: 1205 }, (_, index) => ({ id: `row-${index}` }));
  const calls = [];
  const page = async ({ after, snapshot }) => {
    calls.push({ after, snapshot }); const offset = Number(after);
    return { readings: rows.slice(offset, offset + 500), next_cursor: String(Math.min(offset + 500, rows.length)), snapshot: '1205', has_more: offset + 500 < rows.length };
  };
  const initial = await loadAllPages(page);
  assert.equal(initial.readings.length, 1205); assert.equal(calls.length, 3);
  assert.equal(calls[1].snapshot, '1205');
  const update = await loadAllPages(page, { after: initial.cursor });
  assert.equal(update.readings.length, 0); assert.equal(calls.at(-1).after, '1205');
  await assert.rejects(loadAllPages(async () => ({ readings: [], next_cursor: '0', snapshot: '1', has_more: true })));
});

test('resúmenes respetan sesiones seleccionadas y no convierten ausencias a cero', () => {
  const rows = [{ id: 'a', session_id: id, created_at: '2026-11-16T14:00:00Z', temperatura: 20, humedad: 60, presion: 1013 }, { id: 'b', session_id: null, created_at: '2026-11-16T15:00:00Z', temperatura: 30, humedad: 80, presion: 1015 }];
  assert.equal(selectedRows(rows, new Set()).length, 0);
  assert.equal(selectedRows(rows, new Set([id])).length, 1);
  assert.equal(summarize(selectedRows(rows, new Set(['legacy']))).temperatura.avg, 30);
  assert.equal(summarize(rows).temperatura.avg, 25);
  assert.equal(summarize([]).temperatura.min, null);
});

test('gráficas separan sesiones y cortan intervalos sin mediciones', () => {
  const rows = [{ device_id: 'a', session_id: id, created_at: '2026-11-16T14:00:00Z', temperatura: 20 }, { device_id: 'a', session_id: id, created_at: '2026-11-16T14:00:03Z', temperatura: 21 }, { device_id: 'a', session_id: id, created_at: '2026-11-16T20:00:00Z', temperatura: 22 }, { device_id: 'a', session_id: 'another', created_at: '2026-11-16T21:00:00Z', temperatura: 23 }];
  const model = chartModel(rows, 'temperatura'); assert.equal(model.groups.size, 2);
  const path = pointPath([...model.groups.values()][0], (time) => time, (value) => value);
  assert.equal((path.match(/M/g) || []).length, 2); assert.equal((path.match(/L/g) || []).length, 1);
});

test('sesiones agrupadas por JSONB distinguen dispositivo, evento de fin e inactividad', () => {
  const row = (device, session, at, event) => ({ datos: { device_id: device, session_id: session, ...(event ? { event } : { temperatura: 20 }) }, created_at: at });
  const input = [row('a', 'same', '2026-11-16T14:00:00Z'), row('a', 'same', '2026-11-16T14:00:03Z'), row('b', 'same', '2026-11-16T14:00:03Z')];
  let groups = groupSessions(input, { now: Date.parse('2026-11-16T14:00:10Z'), inactivitySeconds: 120 });
  assert.equal(groups.length, 2); assert.notEqual(groups[0].id, groups[1].id);
  assert.equal(groups.find((g) => g.device_id === 'a').total, 2);
  assert.ok(groups.every((g) => g.estado === 'activa'));
  groups = groupSessions([...input, row('a', 'same', '2026-11-16T14:00:04Z', 'session_end')], { now: Date.parse('2026-11-16T14:00:10Z') });
  assert.equal(groups.find((g) => g.device_id === 'a').cierre_motivo, 'explicito');
  assert.equal(groups.find((g) => g.device_id === 'a').total, 2);
  assert.ok(groupSessions(input, { now: Date.parse('2026-11-16T15:00:00Z') }).every((g) => g.estado === 'finalizada'));
  const restarted = groupSessions([row('a', 'old', '2026-11-16T14:00:00Z'), row('a', 'new', '2026-11-16T14:00:05Z'), row('a', 'old', '2026-11-16T14:00:08Z')], { now: Date.parse('2026-11-16T14:00:10Z') });
  assert.equal(restarted.find((g) => g.session_id === 'old').cierre_motivo, 'reinicio');
  assert.equal(restarted.find((g) => g.session_id === 'new').estado, 'activa');
});

test('API diaria devuelve error seguro de consulta y valida antes de consultar', async (t) => {
  const app = express(); app.use('/api', createDailyRouter({ readings: async () => { throw new Error('private'); }, sessions: async () => [], summary: async () => ({ total: 0 }), logger: { error() {} } }));
  const server = app.listen(0, '127.0.0.1'); await new Promise((done) => server.once('listening', done));
  t.after(() => new Promise((done) => server.close(done)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  assert.equal((await fetch(`${base}/sesiones?fecha=2026-11-16`)).status, 200);
  assert.equal((await fetch(`${base}/resumen?fecha=2026-11-16`)).status, 200);
  assert.equal((await fetch(`${base}/mediciones?fecha=bad`)).status, 400);
  const missing = await fetch(`${base}/mediciones?fecha=2026-11-16`); assert.equal(missing.status, 503);
  const body = await missing.json(); assert.equal(body.code, 'DAILY_QUERY_FAILED'); assert.ok(!JSON.stringify(body).includes('private'));
});

test('cursor conserva microsegundos y rechaza contenido no válido para PostgREST', () => {
  const row = { id, created_at: '2026-11-16T14:00:00.123456Z' };
  assert.deepEqual(decodeCursor(encodeCursor(row)), row);
  assert.throws(() => decodeCursor(Buffer.from(JSON.stringify(['bad', 'or(id.eq.1)'])).toString('base64url')));
});

test('consulta directa pagina 1205 mediciones, excluye eventos y calcula sesiones/resumen completos', async () => {
  const raw = Array.from({ length: 1205 }, (_, index) => ({ id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, datos: { device_id: 'a', session_id: 'historica-1', temperatura: 20, humedad: 60, presion: 1013 }, created_at: new Date(Date.parse('2026-11-16T14:00:00Z') + index * 3000).toISOString() }));
  raw[499].created_at = raw[500].created_at; // Empate justo en el cambio de página.
  raw.push({ id: '00000000-0000-4000-8000-000000002000', datos: { device_id: 'a', session_id: 'historica-1', event: 'session_end' }, created_at: '2026-11-16T16:00:00.000Z' });
  const requests = [];
  const client = createClient('https://example.invalid', 'test-key', { global: { fetch: async (url) => {
    const request = new URL(url); requests.push(request);
    assert.equal(request.pathname, '/rest/v1/mediciones');
    assert.equal(request.searchParams.get('select'), 'id,datos,created_at');
    const or = request.searchParams.get('or');
    const time = or?.match(/created_at\.gt\.([^,]+)/)?.[1];
    const cursorId = or?.match(/id\.gt\.([a-f0-9-]+)/)?.[1];
    const data = raw.filter((r) => !time || r.created_at > time || (r.created_at === time && r.id > cursorId)).slice(0, Number(request.searchParams.get('limit')));
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  } } });
  const filters = parseDailyFilters({ fecha: '2026-11-16' });
  const full = await loadAllPages(({ after, snapshot }) => listDayReadings({ ...filters, after, snapshot }, () => client));
  assert.equal(full.readings.length, 1205); assert.equal(requests.length, 3);
  assert.ok(full.readings.every((r) => r.session_id === 'historica-1' && r.session_key === 'a:historica-1'));
  const sessions = await listDaySessions(filters, () => client);
  assert.equal(sessions.length, 1); assert.equal(sessions[0].total, 1205); assert.equal(sessions[0].cierre_motivo, 'explicito');
  const summary = await daySummary(filters, () => client);
  assert.equal(summary.total, 1205); assert.equal(summary.temperatura.avg, 20);
});
