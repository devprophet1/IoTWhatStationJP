const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readingFreshness, sessionIsRecent } = require('../../frontend/js/dashboard-model');
const { trendModel } = require('../../frontend/js/charts');
const now = Date.parse('2026-11-17T15:00:00Z');

test('frescura usa lecturas reales y distingue histórico, ausencia y marcas futuras', () => {
  assert.equal(readingFreshness(null, { now }).state, 'empty');
  assert.equal(readingFreshness({ created_at: '2026-11-17T14:59:50Z' }, { now }).state, 'recent');
  assert.equal(readingFreshness({ created_at: '2026-11-17T14:59:20Z' }, { now }).state, 'stale');
  assert.equal(readingFreshness({ created_at: '2026-11-17T15:01:00Z' }, { now }).state, 'unknown');
  assert.equal(readingFreshness({ created_at: '2026-11-17T14:59:50Z' }, { now, historical: true }).state, 'historical');
});

test('un inicio de sesión sin lecturas o una sesión finalizada no se destacan como transmisiones', () => {
  const session = { estado: 'activa', total: 0, last_reading_at: null };
  assert.equal(sessionIsRecent(session, now), false);
  assert.equal(sessionIsRecent({ ...session, total: 1, last_reading_at: '2026-11-17T14:59:50Z' }, now), true);
  assert.equal(sessionIsRecent({ estado: 'finalizada', total: 1, last_reading_at: '2026-11-17T14:59:50Z' }, now), false);
  assert.equal(sessionIsRecent({ ...session, total: 2, last_reading_at: '2026-11-17T14:00:00Z' }, now), false);
});

test('sparklines exigen tres lecturas consecutivas de la misma sesión y respetan huecos', () => {
  const rows = [0, 3, 6].map((seconds) => ({ device_id: 'esp32_test', session_id: 'one', temperatura: 20 + seconds, created_at: new Date(now + seconds * 1000).toISOString() }));
  assert.equal(trendModel(rows.slice(0, 1), 'temperatura').model, null);
  assert.equal(trendModel(rows.slice(0, 2), 'temperatura').model, null);
  assert.ok(trendModel(rows, 'temperatura').model);
  assert.equal(trendModel(rows.map((row, i) => ({ ...row, session_id: String(i) })), 'temperatura').model, null);
  assert.equal(trendModel(rows.map((row, i) => ({ ...row, created_at: new Date(now + i * 3600000).toISOString() })), 'temperatura').model, null);
  assert.equal(trendModel(rows.map((row) => ({ ...row, created_at: rows[0].created_at })), 'temperatura').model, null);
});
