const { getSupabase } = require('../config/supabase');

function parseReading(payload) {
  let reading;
  try {
    reading = JSON.parse(payload.toString('utf8'));
  } catch {
    throw new Error('JSON inválido');
  }
  if (!reading || typeof reading !== 'object' || Array.isArray(reading)) {
    throw new Error('Se esperaba un objeto JSON');
  }
  if (typeof reading.device_id !== 'string' || !reading.device_id.trim()) {
    throw new Error('device_id debe ser una cadena no vacía');
  }
  for (const field of ['temperatura', 'humedad', 'presion']) {
    if (typeof reading[field] !== 'number' || !Number.isFinite(reading[field])) {
      throw new Error(`${field} debe ser un número finito`);
    }
  }
  if (reading.humedad < 0 || reading.humedad > 100) {
    throw new Error('humedad debe estar entre 0 y 100');
  }
  if (reading.presion <= 0) {
    throw new Error('presion debe ser mayor que cero');
  }
  return reading;
}

const pendingWrites = new Map();
async function saveReading(reading, getClient = getSupabase) {
  const key = JSON.stringify([reading.device_id, reading.session_id]);
  const previous = pendingWrites.get(key) || Promise.resolve();
  const write = previous.catch(() => {}).then(async () => {
    const client = getClient();
    const event = reading.event || 'reading';
    if (reading.session_id && (reading.seq !== undefined || event !== 'reading')) {
      let query = client.from('mediciones').select('id')
        .eq('datos->>device_id', reading.device_id).eq('datos->>session_id', reading.session_id);
      query = event === 'reading' ? query.eq('datos->>seq', String(reading.seq)) : query.eq('datos->>event', event);
      const { data, error } = await query.limit(1).abortSignal(AbortSignal.timeout(8000));
      if (error) throw new Error('No se pudo comprobar el mensaje repetido');
      if (data?.length) return { duplicate: true };
    }
    // Solo las tres columnas existentes. created_at conserva su default UTC de
    // recepción; captured_at/timestamp del ESP32 se conservan dentro de datos.
    const { error } = await client.from('mediciones').insert({ datos: reading });
    if (error) throw new Error('Error al insertar el mensaje en Supabase');
    return { duplicate: false };
  });
  pendingWrites.set(key, write);
  try { return await write; }
  finally { if (pendingWrites.get(key) === write) pendingWrites.delete(key); }
}

function parseReadingFilters(query) {
  const allowed = ['limit', 'device_id', 'from', 'to', 'before'];
  for (const [key, value] of Object.entries(query)) {
    if (!allowed.includes(key) || typeof value !== 'string') throw new Error('Parámetro desconocido o repetido');
  }
  const rawLimit = query.limit ?? '200';
  if (!/^[1-9]\d{0,3}$/.test(rawLimit) || Number(rawLimit) > 1000) throw new Error('limit debe ser un entero entre 1 y 1000');
  const filters = { limit: Number(rawLimit) };
  if (query.device_id !== undefined) {
    if (!query.device_id.trim() || query.device_id.length > 128 || /[\x00-\x1f]/.test(query.device_id)) throw new Error('device_id debe contener entre 1 y 128 caracteres válidos');
    filters.device_id = query.device_id;
  }
  if (query.to !== undefined && query.before !== undefined) throw new Error('Utiliza to o before, no ambos');
  for (const field of ['from', 'to', 'before']) {
    if (query[field] === undefined) continue;
    const value = query[field];
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
    if (!match) throw new Error(`${field} debe ser una fecha ISO 8601 con zona horaria`);
    const [, year, month, day, hour, minute, second, , offsetHour = '0', offsetMinute = '0'] = match;
    const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
    if (+month < 1 || +month > 12 || +day < 1 || +day > days || +hour > 23 || +minute > 59 || +second > 59 || +offsetHour > 23 || +offsetMinute > 59 || !Number.isFinite(Date.parse(value))) throw new Error(`${field} contiene una fecha inválida`);
    filters[field] = new Date(value).toISOString();
  }
  if (filters.from && filters.to && filters.from > filters.to) throw new Error('from no puede ser posterior a to');
  if (filters.from && filters.before && filters.from >= filters.before) throw new Error('from debe ser anterior a before');
  return filters;
}

async function listReadings(filters, getClient = getSupabase) {
  let query = getClient().from('mediciones').select('id,datos,created_at')
    .or('datos->>event.is.null,datos->>event.eq.reading')
    .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(filters.limit);
  if (filters.device_id) query = query.eq('datos->>device_id', filters.device_id);
  if (filters.from) query = query.gte('created_at', filters.from);
  if (filters.to) query = query.lte('created_at', filters.to);
  if (filters.before) query = query.lt('created_at', filters.before);
  const { data, error } = await query.abortSignal(AbortSignal.timeout(8000));
  if (error) throw new Error('No se pudieron consultar las mediciones');
  return (data || []).map((row) => ({
    id: row.id,
    device_id: typeof row.datos?.device_id === 'string' ? row.datos.device_id : null,
    temperatura: Number.isFinite(row.datos?.temperatura) ? row.datos.temperatura : null,
    humedad: Number.isFinite(row.datos?.humedad) ? row.datos.humedad : null,
    presion: Number.isFinite(row.datos?.presion) ? row.datos.presion : null,
    created_at: utcTimestamp(row.created_at)
  }));
}

function utcTimestamp(value) {
  const iso = new Date(value).toISOString();
  // Date trabaja con milisegundos; conservar también la fracción original de
  // PostgreSQL cuando created_at tiene precisión de microsegundos.
  const fraction = /\.(\d{4,6})(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1];
  return fraction ? iso.replace(/\.\d{3}Z$/, `.${fraction}Z`) : iso;
}

module.exports = { parseReading, saveReading, parseReadingFilters, listReadings, utcTimestamp };
