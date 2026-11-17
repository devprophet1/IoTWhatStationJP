// Verificación de frontend + API + Supabase real, exclusivamente de lectura.
// Ejecutar con node --env-file=.env backend/test/browser.real.cjs.
const { chromium } = require(process.env.WHATER_PLAYWRIGHT_PATH || 'playwright-core');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const { todayLima } = require('../../frontend/js/time');
const { getSupabase } = require('../src/config/supabase');

(async () => {
  const app = require('../../api/index');
  assert.equal(require.cache[require.resolve('../src/mqtt/client')], undefined);
  app.use(express.static(path.resolve(__dirname, '../../frontend')));
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  let browser;
  try {
    const { data, error } = await getSupabase().from('mediciones').select('id,datos,created_at').order('created_at', { ascending: false }).limit(100).abortSignal(AbortSignal.timeout(8000));
    assert.equal(error, null); assert.ok(data.length > 0, 'No hay registros reales para verificar');
    const oldest = await getSupabase().from('mediciones').select('id,datos,created_at').order('created_at').limit(1).abortSignal(AbortSignal.timeout(8000));
    assert.equal(oldest.error, null);
    browser = await chromium.launch({ executablePath: process.env.WHATER_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Tokyo' });
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    const captured = new Map(), captures = [];
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.pathname !== '/api/mediciones' || response.status() !== 200) return;
      captures.push(response.json().then((body) => {
        const day = url.searchParams.get('fecha');
        if (!captured.has(day)) captured.set(day, new Map());
        for (const row of body.readings) captured.get(day).set(row.id, row);
      }));
    });
    page.on('request', (request) => { if (request.url().includes('/api/')) assert.equal(request.method(), 'GET'); });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => ['success', 'empty', 'error'].includes(document.querySelector('#status').dataset.state));
    for (const day of new Set([...data, ...oldest.data].map((row) => todayLima(new Date(row.created_at))))) {
      await page.locator('#day').fill(day); await page.locator('#day').dispatchEvent('change');
      await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'success');
      await Promise.all(captures);
      // Comparar con el lote que recibió la página, no con una lectura previa:
      // el ESP32 puede seguir insertando mediciones mientras se ejecuta el test.
      const readings = [...captured.get(day).values()].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      assert.equal((await page.locator('#summary-count').textContent()).replace(/\D/g, ''), String(readings.length));
      const number = new Intl.NumberFormat('es-PE', { maximumFractionDigits: 2 });
      assert.equal(await page.locator('#temperature').textContent(), number.format(readings[0].temperatura));
      const temperatures = readings.map((row) => row.temperatura);
      assert.equal(await page.locator('#temperature-min').textContent(), number.format(Math.min(...temperatures)));
      assert.equal(await page.locator('#temperature-max').textContent(), number.format(Math.max(...temperatures)));
      if (readings.length === 1) {
        assert.equal(await page.locator('#combined-chart svg').count(), 0);
        assert.equal(await page.locator('.sparkline svg').count(), 0);
      }
      await page.locator('#tab-graficas').click(); assert.equal(await page.locator('#panel-graficas').isVisible(), true);
      await page.locator('#tab-historial').click();
      assert.equal(await page.locator('#readings-table tr').count(), Math.min(200, readings.length));
      await page.locator('#tab-resumen').click();
      console.log('Supabase real: dashboard y tres pestañas correctos; mediciones del día: ' + readings.length);
    }
    await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
    await page.screenshot({ path: path.join(require('node:os').tmpdir(), 'whater-observatorio-real.png'), fullPage: true });
    for (const width of [768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    }
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('Chrome + Supabase: sin errores JS ni desbordamiento; escrituras: 0, MQTT no iniciado');
  } finally { await browser?.close(); await new Promise((resolve) => server.close(resolve)); }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
