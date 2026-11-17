// QA de navegador aislado: API interceptada con fixtures, sin acceder a Supabase.
const { chromium } = require(process.env.WHATER_PLAYWRIGHT_PATH || 'playwright-core');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const { todayLima, limaInputToUtc } = require('../../frontend/js/time');
const { encodeCursor, decodeCursor } = require('../src/services/daily');

(async () => {
  const app = express(); app.use(express.static(path.resolve(__dirname, '../../frontend')));
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.WHATER_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const context = await browser.newContext({ timezoneId: 'Asia/Tokyo', viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    const day = todayLima(), first = '00000000-0000-4000-8000-000000000001', second = '00000000-0000-4000-8000-000000000002';
    const fixture = Array.from({ length: 1210 }, (_, index) => ({ id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, device_id: 'esp32_qa', session_id: index < 1200 ? first : second,
      session_key: `esp32_qa:${index < 1200 ? first : second}`,
      temperatura: 24 + Math.sin(index / 60), humedad: 65 + Math.cos(index / 40) * 5, presion: 1013 + Math.sin(index / 50) * 2,
      created_at: new Date(Date.parse(limaInputToUtc(`${day}T${index < 1200 ? '09' : '15'}:00`)) + (index < 1200 ? index : index - 1200) * 3000).toISOString() }));
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      const single = url.searchParams.get('fecha') === '2020-01-02';
      const empty = !single && url.searchParams.get('fecha') !== day;
      const available = single ? [{ ...fixture[0], created_at: '2020-01-02T14:00:00.000Z' }] : empty ? [] : fixture;
      if (url.pathname === '/api/sesiones') return route.fulfill({ json: { sessions: empty ? [] : (single ? [first] : [first, second]).map((id, index) => ({ id: `esp32_qa:${id}`, session_id: id, device_id: 'esp32_qa', inicio: available[index ? 1200 : 0].created_at, fin: single ? available[0].created_at : available[index ? 1209 : 1199].created_at, estado: 'finalizada', total: single ? 1 : index ? 10 : 1200, duracion_segundos: single ? 0 : index ? 27 : 3597 })) } });
      const after = decodeCursor(url.searchParams.get('after') || '0');
      const rows = available.filter((row) => !after || row.created_at > after.created_at || (row.created_at === after.created_at && row.id > after.id));
      const readings = rows.slice(0, 500);
      return route.fulfill({ json: { readings, snapshot: limaInputToUtc(`${day}T23:59:59`), next_cursor: readings.length ? encodeCursor(readings.at(-1)) : url.searchParams.get('after') || '0', has_more: readings.length === 500 } });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'success');
    assert.equal(await page.locator('#day').inputValue(), day);
    assert.equal(await page.locator('.session-row').count(), 2);
    assert.equal(await page.locator('#tab-resumen').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#panel-graficas').isVisible(), false);
    assert.equal(await page.locator('.sparkline svg').count(), 3);
    assert.equal(await page.locator('.session-state.active').count(), 0);
    assert.equal((await page.locator('#summary-count').textContent()).replace(/\D/g, ''), '1210');
    assert.equal(await page.locator('#readings-table tr').count(), 200);
    assert.match(await page.locator('#table-page').textContent(), /1 de 7/);
    await page.locator('#tab-historial').click();
    await page.locator('#table-next').click();
    assert.match(await page.locator('#table-page').textContent(), /2 de 7/);
    await page.locator('#tab-resumen').click();
    await page.locator('.session-row input').nth(1).uncheck();
    assert.equal((await page.locator('#summary-count').textContent()).replace(/\D/g, ''), '1200');
    await page.locator('#select-none').click(); assert.equal(await page.locator('#temperature').textContent(), '—');
    await page.locator('#select-all').click();
    await page.locator('#show-humidity').uncheck();
    await page.locator('#show-pressure').uncheck();
    assert.equal(await page.locator('#combined-chart path[stroke="#4587b1"]').count(), 0);
    assert.equal(await page.locator('#combined-chart path[stroke="#cc764d"]').count(), 2);
    await page.locator('#show-humidity').check(); await page.locator('#show-pressure').check();
    await page.locator('#combined-chart svg').press('Home');
    assert.equal(await page.locator('.tooltip-values span').count(), 3);
    assert.match(await page.locator('.tooltip-context').textContent(), /Lima/);
    await page.locator('#tab-resumen').press('ArrowRight');
    assert.equal(await page.locator('#tab-graficas').getAttribute('aria-selected'), 'true');
    await page.locator('#tab-resumen').click();
    await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
    await page.screenshot({ path: process.env.WHATER_SCREENSHOT || path.join(require('node:os').tmpdir(), 'whater-dashboard-sessions.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.locator('#tab-historial').click();
    assert.equal(await page.locator('#panel-historial').isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.locator('#tab-resumen').click();
    await page.locator('#day').fill('2020-01-01'); await page.locator('#day').dispatchEvent('change');
    await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'empty');
    assert.equal(await page.locator('.session-row').count(), 0);
    await page.locator('#day').fill('2020-01-02'); await page.locator('#day').dispatchEvent('change');
    await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'success');
    assert.equal(await page.locator('.sparkline svg').count(), 0);
    assert.equal(await page.locator('#combined-chart svg').count(), 0);
    assert.equal(await page.locator('#combined-chart .single-reading').count(), 1);
    assert.equal(await page.locator('#device-status').textContent(), 'Datos históricos');
    await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
    await page.screenshot({ path: path.join(require('node:os').tmpdir(), 'whater-observatorio-mobile.png'), fullPage: true });
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('OK: Chrome, 1210 registros, pestañas/teclado, sparklines, tooltip, selección, tabla, vacío, lectura única y móvil');
  } finally { await browser?.close(); await new Promise((resolve) => server.close(resolve)); }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
