const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// DOM mínimo para probar la lógica de la página sin instalar un navegador.
function dashboard(fetchImpl) {
  class Element {
    constructor() { this.children = []; this.value = ''; this.dataset = {}; this.style = {}; this.events = {}; this.attributes = {}; this.textContent = ''; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    setAttribute(key, value) { this.attributes[key] = value; }
    getAttribute(key) { return this.attributes[key]; }
    focus() { document.activeElement = this; }
    addEventListener(event, listener) { this.events[event] = listener; }
    reportValidity() { return true; }
  }
  const elements = new Map();
  const get = (key) => {
    if (!elements.has(key)) elements.set(key, new Element());
    return elements.get(key);
  };
  get('#limit').value = '200';
  for (const key of ['#show-temperature', '#show-humidity', '#show-pressure']) get(key).checked = true;
  get('#filters').reset = () => {
    for (const id of ['#day', '#device', '#from', '#to']) get(id).value = '';
    get('#limit').value = '200';
  };
  const document = { querySelector: get, createElement: () => new Element(), createElementNS: () => new Element(), addEventListener() {}, hidden: false };
  const timers = new Map();
  let nextTimer = 0;
  const requests = [];
  const context = vm.createContext({ document, Intl, Date, URLSearchParams, AbortController,
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    fetch: async (url, options) => {
      requests.push(url);
      if (url.startsWith('/api/sesiones')) return { ok: true, json: async () => ({ sessions: [{ id: 'legacy', inicio: '2026-11-17T02:00:00Z', fin: '2026-11-17T02:00:00Z', estado: 'finalizada', total: 1, historica: true }] }) };
      const result = await fetchImpl(url, options);
      if (!result.ok) return result;
      return { ok: true, json: async () => ({ ...await result.json(), next_cursor: '1', snapshot: '1', has_more: false }) };
    }
  });
  context.window = context;
  for (const file of ['time.js', 'charts.js', 'dashboard-model.js', 'app.js']) vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../frontend/js', file), 'utf8'), context, { filename: file });
  return { get, timers, requests };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const row = { id: 'test', device_id: '<sensor>', temperatura: 20, humedad: 60, presion: 1013, created_at: '2026-11-17T02:00:00Z' };
const response = (readings) => ({ ok: true, json: async () => ({ readings }) });

test('dashboard muestra Lima, dibuja SVG y conserva datos ante errores periódicos', async () => {
  let fail = false;
  const page = dashboard(async () => { if (fail) throw new Error('network'); return response([row]); });
  assert.equal(page.get('#status').dataset.state, 'loading');
  await settle();
  assert.equal(page.get('#status').dataset.state, 'success');
  assert.equal(page.get('#temperature').textContent, '20');
  assert.match(page.get('#latest-context').textContent, /21:00:00 Lima/);
  assert.equal(page.get('#temperature-chart').children.length, 1);
  assert.match(page.get('#temperature-chart').children[0].attributes['aria-label'], /Lima/);
  assert.equal(page.get('#readings-table').children[0].children[1].textContent, '<sensor>');
  fail = true;
  const polling = [...page.timers.values()].find((timer) => timer.delay === 60000);
  assert.ok(polling);
  await polling.callback();
  await settle();
  assert.equal(page.get('#status').dataset.state, 'error');
  assert.equal(page.get('#temperature').textContent, '20');
  assert.match(page.get('#status').textContent, /Se conservan/);
});

test('dashboard envía un día de Lima en UTC, filtra dispositivos y maneja vacío e inversión de fechas', async () => {
  const page = dashboard(async () => response([]));
  await settle();
  assert.equal(page.get('#status').dataset.state, 'empty');
  assert.equal(page.get('#temperature').textContent, '—');
  page.get('#day').value = '2026-11-16';
  page.get('#device').value = 'sensor/uno';
  page.get('#filters').events.submit({ preventDefault() {} });
  await settle();
  const url = new URL(page.requests.at(-1), 'https://example.invalid');
  assert.equal(url.searchParams.get('fecha'), '2026-11-16');
  assert.equal(url.searchParams.get('page_size'), '500');
  assert.equal(url.searchParams.get('device_id'), 'sensor/uno');
  page.get('#from').value = '2026-11-16T21:00';
  page.get('#to').value = '2026-11-16T22:00';
  page.get('#filters').events.submit({ preventDefault() {} });
  await settle();
  const range = new URL(page.requests.at(-1), 'https://example.invalid');
  assert.equal(range.searchParams.get('from'), '2026-11-17T02:00:00.000Z');
  assert.equal(range.searchParams.get('to'), '2026-11-17T03:00:00.000Z');
  const previous = page.requests.length;
  page.get('#from').value = '2026-11-18T12:00';
  page.get('#filters').events.submit({ preventDefault() {} });
  assert.equal(page.requests.length, previous);
  assert.equal(page.get('#status').dataset.state, 'error');
});

test('una respuesta antigua no reemplaza los filtros nuevos', async () => {
  let completeFirst;
  let count = 0;
  const page = dashboard(() => {
    if (++count === 1) return new Promise((resolve) => { completeFirst = resolve; });
    return Promise.resolve(response([]));
  });
  page.get('#day').value = '2026-11-16';
  page.get('#filters').events.submit({ preventDefault() {} });
  await settle();
  completeFirst(response([row]));
  await settle();
  assert.equal(page.get('#status').dataset.state, 'empty');
  assert.equal(page.get('#temperature').textContent, '—');
});

test('pestañas accesibles conservan filtros y muestran un solo panel', async () => {
  const page = dashboard(async () => response([]));
  await settle();
  assert.equal(page.get('#panel-resumen').hidden, false);
  assert.equal(page.get('#panel-graficas').hidden, true);
  assert.equal(page.get('#panel-historial').hidden, true);
  page.get('#device').value = 'esp32_test';
  page.get('#tab-resumen').events.keydown({ key: 'ArrowRight', preventDefault() {} });
  assert.equal(page.get('#tab-graficas').attributes['aria-selected'], 'true');
  assert.equal(page.get('#panel-resumen').hidden, true);
  assert.equal(page.get('#panel-graficas').hidden, false);
  assert.equal(page.get('#device').value, 'esp32_test');
  page.get('#tab-graficas').events.keydown({ key: 'End', preventDefault() {} });
  assert.equal(page.get('#panel-historial').hidden, false);
  assert.equal(page.get('#tab-historial').tabIndex, 0);
});

test('una sola lectura no genera sparkline ni un eje temporal artificial', async () => {
  const page = dashboard(async () => response([row]));
  await settle();
  assert.match(page.get('#temperature-sparkline').children[0].textContent, /Una lectura/);
  assert.equal(page.get('#combined-chart').children[0].className, 'single-reading');
  assert.equal(page.get('#temperature-min').textContent, '20');
  assert.equal(page.get('#temperature-max').textContent, '20');
  assert.equal(page.get('#temperature-avg').textContent, '20');
  assert.notEqual(page.get('#device-status').textContent, 'Conectado');
});
