const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { parseReading, saveReading } = require('../src/services/readings');
const { connectMqtt, describeMqttError } = require('../src/mqtt/client');

const reading = { device_id: 'station-test', temperatura: 23.5, humedad: 65, presion: 1013, extra: { bateria: 80 } };
const payload = (value) => Buffer.from(JSON.stringify(value));

test('valida la medición y preserva todos sus campos', () => {
  assert.deepEqual(parseReading(payload(reading)), reading);
  assert.equal(parseReading(payload({ ...reading, temperatura: -10, humedad: 0 })).temperatura, -10);
  assert.equal(parseReading(payload({ ...reading, humedad: 100 })).humedad, 100);
});

test('rechaza JSON y valores inválidos sin coerción', () => {
  assert.throws(() => parseReading(Buffer.from('{')));
  for (const value of [null, [], 1, {}, { ...reading, device_id: ' ' },
    { ...reading, device_id: 12 }, { ...reading, temperatura: '23' },
    { ...reading, temperatura: null }, { ...reading, humedad: -1 },
    { ...reading, humedad: 101 }, { ...reading, presion: 0 },
    { ...reading, presion: -1 }, { ...reading, presion: undefined }]) {
    assert.throws(() => parseReading(payload(value)));
  }
  assert.throws(() => parseReading(Buffer.from('{"device_id":"test","temperatura":1e400,"humedad":50,"presion":1000}')));
});

test('inserta el objeto completo en mediciones.datos y propaga los fallos', async () => {
  let inserted;
  const getClient = () => ({ from(table) {
    assert.equal(table, 'mediciones');
    return { async insert(row) { inserted = row; return { error: null }; } };
  } });
  await saveReading(reading, getClient);
  assert.deepEqual(inserted, { datos: reading });
  await assert.rejects(saveReading(reading, () => ({ from: () => ({ insert: async () => ({ error: { message: 'private detail' } }) }) })));
  await assert.rejects(saveReading(reading, () => { throw new Error('network failure'); }));
});

function fixture({ save = async () => {}, denied = false } = {}) {
  const client = new EventEmitter();
  const subscriptions = [];
  client.subscribe = (topic, options, callback) => {
    subscriptions.push({ topic, options });
    callback(null, [{ topic, qos: denied ? 128 : 1 }]);
  };
  const logs = [];
  let options;
  connectMqtt({
    env: { MQTT_URL: 'mqtts://example.invalid:8883', MQTT_USERNAME: 'secret-user', MQTT_PASSWORD: 'secret-password' },
    connect: (_url, opts) => { options = opts; return client; },
    save,
    logger: Object.fromEntries(['info', 'warn', 'error'].map((level) => [level, (message) => logs.push(message)]))
  });
  return { client, subscriptions, logs, options };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('suscribe al conectar y reconectar, procesa válidos y aísla errores', async () => {
  const saved = [];
  const { client, subscriptions, logs, options } = fixture({ save: async (value) => {
    if (value.fail) throw new Error('secret-password');
    saved.push(value);
  } });
  client.emit('connect');
  client.emit('error', new Error('secret-password'));
  client.emit('offline');
  client.emit('close');
  client.emit('reconnect');
  client.emit('connect');
  assert.equal(subscriptions.length, 2);
  assert.deepEqual(subscriptions[0], { topic: 'estacion/mediciones', options: { qos: 1 } });
  assert.equal(options.reconnectPeriod, 5000);
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.port, 8883);
  assert.equal(options.reconnectOnConnackError, true);
  client.emit('message', 'other/topic', payload(reading));
  client.emit('message', 'estacion/mediciones', Buffer.from('{'));
  client.emit('message', 'estacion/mediciones', payload({ ...reading, humedad: 101 }));
  client.emit('message', 'estacion/mediciones', payload({ ...reading, fail: true }));
  await settle();
  client.emit('message', 'estacion/mediciones', payload(reading));
  await settle();
  assert.deepEqual(saved, [reading]);
  assert.ok(logs.some((line) => line.includes('descartado')));
  assert.ok(logs.some((line) => line.includes('No se pudo guardar')));
  assert.ok(logs.some((line) => line.includes('Medición guardada')));
  assert.ok(!logs.join('\n').includes('secret-password'));
  assert.ok(!logs.join('\n').includes('secret-user'));
});

test('valida protocolo TLS, puerto y tópico definitivo sin abrir conexiones inválidas', () => {
  const env = { MQTT_URL: 'mqtts://example.invalid:8883', MQTT_USERNAME: 'user', MQTT_PASSWORD: 'password', MQTT_TOPIC: 'estacion/mediciones' };
  const connect = () => assert.fail('No debe abrir una conexión');
  for (const url of ['mqtt://example.invalid:8883', 'mqtts://example.invalid:1883',
    'invalid', 'mqtts://user:password@example.invalid:8883', 'mqtts://example.invalid/path']) {
    assert.throws(() => connectMqtt({ env: { ...env, MQTT_URL: url }, connect }), { code: 'MQTT_URL_INVALID' });
  }
  assert.throws(() => connectMqtt({ env: { ...env, MQTT_TOPIC: 'station/readings' }, connect }), { code: 'MQTT_TOPIC_INVALID' });
  assert.throws(() => connectMqtt({ env: { ...env, MQTT_PASSWORD: ' ' }, connect }), { code: 'MQTT_CREDENTIALS_MISSING' });
});

test('los diagnósticos distinguen fallos sin incluir detalles privados', () => {
  assert.match(describeMqttError({ code: 'MQTT_TOPIC_INVALID' }), /estacion\/mediciones/);
  assert.match(describeMqttError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }), /certificado TLS/);
  assert.match(describeMqttError({ code: 5 }), /autorización/);
  for (const code of ['unknown', 'toString', undefined]) {
    assert.equal(describeMqttError({ code, message: 'secret-password' }), 'Fallo MQTT; revisar configuración, red, TLS y permisos');
  }
});

test('detecta una suscripción rechazada', () => {
  const { client, logs } = fixture({ denied: true });
  client.emit('connect');
  assert.ok(logs.some((line) => line.includes('rechazada o fallida')));
  assert.ok(!logs.some((line) => line.includes('Suscripción activa')));
});

test('rechaza configuración incompleta antes de conectarse', () => {
  const connect = () => { assert.fail('No debe abrir la conexión'); };
  assert.throws(() => connectMqtt({ env: {}, connect }));
  assert.throws(() => connectMqtt({ env: { MQTT_URL: 'mqtts://example.invalid' }, connect }));
  assert.throws(() => connectMqtt({ env: {
    MQTT_URL: 'mqtts://example.invalid', MQTT_USERNAME: 'user', MQTT_PASSWORD: 'password', MQTT_TOPIC: 'other'
  }, connect }));
});
