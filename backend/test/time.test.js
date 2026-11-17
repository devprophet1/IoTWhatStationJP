const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { TIME_ZONE, dateFormatter, limaInputToUtc, limaDayRange } = require('../../frontend/js/time');
const { chartModel } = require('../../frontend/js/charts');

test('medianoche UTC se muestra en el día anterior de Lima, sin doble conversión', () => {
  assert.equal(TIME_ZONE, 'America/Lima');
  assert.equal(dateFormatter.resolvedOptions().timeZone, 'America/Lima');
  const parts = (value) => Object.fromEntries(dateFormatter.formatToParts(new Date(value)).map(({ type, value: part }) => [type, part]));
  assert.equal(parts('2026-11-17T02:00:00Z').day, '16');
  assert.equal(parts('2026-11-17T02:00:00Z').hour, '21');
  assert.equal(parts('2026-11-17T04:59:59Z').day, '16');
  assert.equal(parts('2026-11-17T05:00:00Z').day, '17');
  assert.equal(parts('2026-11-17T05:00:00Z').hour, '00');
  assert.equal(limaInputToUtc('2026-11-16T21:00'), '2026-11-17T02:00:00.000Z');
});

test('el día de Lima incluye medianoche UTC y excluye el siguiente día local', () => {
  const range = limaDayRange('2026-11-16');
  assert.deepEqual(range, { from: '2026-11-16T05:00:00.000Z', before: '2026-11-17T05:00:00.000Z' });
  const included = (value) => Date.parse(value) >= Date.parse(range.from) && Date.parse(value) < Date.parse(range.before);
  assert.equal(included('2026-11-16T04:59:59.999Z'), false);
  assert.equal(included('2026-11-16T05:00:00Z'), true);
  assert.equal(included('2026-11-17T00:00:00Z'), true);
  assert.equal(included('2026-11-17T04:59:59.999Z'), true);
  assert.equal(included('2026-11-17T05:00:00Z'), false);
  assert.deepEqual(limaDayRange('2026-12-31'), { from: '2026-12-31T05:00:00.000Z', before: '2027-01-01T05:00:00.000Z' });
});

test('rechaza fechas inválidas y timestamps ya convertidos como entrada local', () => {
  for (const value of ['2026-02-30T12:00', '2026-11-16T24:00', 'bad', '2026-11-16T12:00:00Z', '2026-11-16T12:00-05:00']) assert.throws(() => limaInputToUtc(value));
  assert.throws(() => limaDayRange('2026-02-30'));
});

test('los límites de Lima no dependen de la zona del navegador o proceso', () => {
  for (const TZ of ['UTC', 'Asia/Tokyo', 'America/New_York']) {
    const result = spawnSync(process.execPath, ['-e', "const {limaDayRange}=require('./frontend/js/time'); process.stdout.write(JSON.stringify(limaDayRange('2026-11-16')));"], { cwd: require('node:path').resolve(__dirname, '../..'), env: { ...process.env, TZ }, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), limaDayRange('2026-11-16'));
  }
});

test('las gráficas ordenan por instante real y separan dispositivos sin inventar ceros', () => {
  const model = chartModel([
    { device_id: 'a', temperatura: 20, created_at: '2026-11-17T02:00:00Z' },
    { device_id: 'b', temperatura: 10, created_at: '2026-11-17T01:00:00Z' },
    { device_id: 'a', temperatura: null, created_at: '2026-11-17T01:30:00Z' }
  ], 'temperatura');
  assert.equal(model.groups.size, 2);
  assert.deepEqual(model.groups.get('a').map((point) => point.value), [null, 20]);
  assert.equal(chartModel([], 'temperatura'), null);
  assert.equal(chartModel([{ created_at: 'bad', temperatura: 20 }], 'temperatura'), null);
  const single = chartModel([{ device_id: 'a', temperatura: 0, created_at: '2026-11-17T02:00:00Z' }], 'temperatura');
  assert.ok(single.minTime < single.maxTime);
  assert.ok(single.min < 0 && single.max > 0);
});
