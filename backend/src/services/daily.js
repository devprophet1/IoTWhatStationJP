const { getSupabase } = require('../config/supabase');
const { parseReadingFilters, utcTimestamp } = require('./readings');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validSessionId = (id) => typeof id === 'string' && id.trim().length > 0 && id.length <= 128 && !/[\x00-\x1f]/.test(id);
const sessionKey = (device, session) => `${encodeURIComponent(device || '')}:${encodeURIComponent(session || '')}`;
const encodeCursor = (row) => Buffer.from(JSON.stringify([row.created_at, row.id])).toString('base64url');

function decodeCursor(token) {
  if (token === '0') return null;
  try {
    if (!/^[A-Za-z0-9_-]{1,400}$/.test(token)) throw new Error();
    const value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || !UUID.test(value[1])) throw new Error();
    parseReadingFilters({ from: value[0] });
    return { created_at: utcTimestamp(value[0]), id: value[1] };
  } catch { throw new Error('Cursor inválido'); }
}

function parseDailyFilters(query) {
  const allowed = ['fecha', 'device_id', 'session_ids', 'session_keys', 'from', 'to', 'after', 'snapshot', 'page_size', 'overlap_seconds'];
  if (Object.entries(query).some(([key, value]) => !allowed.includes(key) || typeof value !== 'string')) throw new Error('Parámetro desconocido o repetido');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(query.fecha || '')) throw new Error('fecha debe ser YYYY-MM-DD de Lima');
  const day = parseReadingFilters({ from: `${query.fecha}T00:00:00-05:00` });
  const before = new Date(Date.parse(day.from) + 86400000).toISOString();
  const optional = {};
  for (const key of ['device_id', 'from', 'to']) if (query[key] !== undefined) optional[key] = query[key];
  const filters = parseReadingFilters(optional);
  const result = { fecha: query.fecha, from: day.from, before, device_id: filters.device_id || null, to: filters.to || null, sessions: null, session_keys: null, after: query.after || '0', snapshot: query.snapshot || null, page_size: 500, overlap_seconds: 0 };
  if (filters.from && filters.from > day.from) result.from = filters.from;
  if (result.to && result.to >= before) result.to = null;
  if (result.from >= before || (result.to && result.to < result.from)) throw new Error('El rango horario debe intersectar el día seleccionado');
  for (const [param, target] of [['session_ids', 'sessions'], ['session_keys', 'session_keys']]) {
    if (query[param] === undefined) continue;
    result[target] = query[param] ? [...new Set(query[param].split(','))] : [];
    if (result[target].length > 100 || result[target].some((id) => !validSessionId(id) && param === 'session_ids') || result[target].some((id) => id.length > 800)) throw new Error('Selección de sesiones inválida');
  }
  decodeCursor(result.after);
  if (query.overlap_seconds !== undefined) {
    if (!/^\d{1,3}$/.test(query.overlap_seconds) || +query.overlap_seconds > 300) throw new Error('overlap_seconds debe estar entre 0 y 300');
    result.overlap_seconds = +query.overlap_seconds;
  }
  if (result.snapshot) {
    parseReadingFilters({ from: result.snapshot });
    result.snapshot = utcTimestamp(result.snapshot);
  }
  if (query.page_size !== undefined) {
    if (!/^[1-9]\d{0,2}$/.test(query.page_size) || +query.page_size > 500) throw new Error('page_size debe estar entre 1 y 500');
    result.page_size = +query.page_size;
  }
  return result;
}

function baseQuery(filters, client, snapshot) {
  let query = client.from('mediciones').select('id,datos,created_at')
    .gte('created_at', filters.from).lt('created_at', filters.before)
    .lte('created_at', snapshot).order('created_at').order('id');
  if (filters.device_id) query = query.eq('datos->>device_id', filters.device_id);
  if (filters.to) query = query.lte('created_at', filters.to);
  return query;
}

function project(row) {
  return { id: row.id, session_id: validSessionId(row.datos?.session_id) ? row.datos.session_id : null,
    session_key: sessionKey(row.datos?.device_id, row.datos?.session_id),
    device_id: typeof row.datos?.device_id === 'string' ? row.datos.device_id : null,
    temperatura: Number.isFinite(row.datos?.temperatura) ? row.datos.temperatura : null,
    humedad: Number.isFinite(row.datos?.humedad) ? row.datos.humedad : null,
    presion: Number.isFinite(row.datos?.presion) ? row.datos.presion : null,
    created_at: utcTimestamp(row.created_at) };
}
const isReading = (row) => !row.datos?.event || row.datos.event === 'reading';
function matches(row, filters) {
  return (filters.sessions === null || filters.sessions.includes(row.session_id || 'legacy')) &&
    (filters.session_keys === null || filters.session_keys.includes(row.session_key));
}

async function fetchPage(filters, getClient = getSupabase, { includeEvents = false } = {}) {
  const snapshot = filters.snapshot || new Date().toISOString();
  let query = baseQuery(filters, getClient(), snapshot);
  let cursor = decodeCursor(filters.after);
  if (cursor && !filters.snapshot && filters.overlap_seconds) cursor = {
    created_at: new Date(Date.parse(cursor.created_at) - filters.overlap_seconds * 1000).toISOString(),
    id: '00000000-0000-0000-0000-000000000000'
  };
  if (cursor) query = query.or(`created_at.gt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.gt.${cursor.id})`);
  const { data, error } = await query.limit(filters.page_size).abortSignal(AbortSignal.timeout(8000));
  if (error) throw new Error('No se pudieron consultar las mediciones');
  const raw = data || [];
  const readings = includeEvents ? raw : raw.filter(isReading).map(project).filter((row) => matches(row, filters));
  return { readings, snapshot, next_cursor: raw.length ? encodeCursor(raw.at(-1)) : filters.after,
    has_more: raw.length === filters.page_size };
}

async function allRows(filters, getClient, includeEvents = false) {
  let after = '0', snapshot = filters.snapshot, rows = [];
  for (;;) {
    const page = await fetchPage({ ...filters, after, snapshot }, getClient, { includeEvents });
    rows.push(...page.readings);
    if (!page.has_more) return rows;
    if (page.next_cursor === after) throw new Error('La paginación no avanzó');
    after = page.next_cursor; snapshot = page.snapshot;
  }
}

function groupSessions(rows, { now = Date.now(), inactivitySeconds = Number(process.env.SESSION_INACTIVITY_SECONDS || 120) } = {}) {
  if (!Number.isInteger(inactivitySeconds) || inactivitySeconds < 15 || inactivitySeconds > 86400) throw new Error('Umbral de inactividad inválido');
  const groups = new Map(), latestByDevice = new Map();
  for (const row of rows) {
    const data = row.datos || {}, id = sessionKey(data.device_id, data.session_id), at = utcTimestamp(row.created_at);
    if (!groups.has(id)) groups.set(id, { id, session_id: data.session_id || null, device_id: data.device_id || null, inicio: at, fin: null, last_reading_at: null, total: 0, historica: !data.session_id, last_at: at, explicit_end: false });
    const group = groups.get(id);
    if (at < group.inicio) group.inicio = at;
    if (at > group.last_at) group.last_at = at;
    if (data.event === 'session_end') group.explicit_end = true;
    if (isReading(row)) { group.total++; if (!group.last_reading_at || at > group.last_reading_at) group.last_reading_at = at; }
  }
  // El reinicio se deduce del comienzo de un grupo nuevo. Un paquete atrasado de
  // una sesión vieja no debe convertirla en la sesión más reciente del equipo.
  for (const group of groups.values()) {
    const previous = latestByDevice.get(group.device_id);
    if (!previous || Date.parse(group.inicio) > Date.parse(previous.at)) latestByDevice.set(group.device_id, { id: group.id, at: group.inicio });
  }
  return [...groups.values()].map((group) => {
    const restarted = latestByDevice.get(group.device_id)?.id !== group.id;
    const inactive = now - Date.parse(group.last_at) > inactivitySeconds * 1000;
    const ended = group.explicit_end || restarted || inactive || group.historica;
    return { id: group.id, session_id: group.session_id, device_id: group.device_id, inicio: group.inicio,
      fin: ended ? group.last_at : null, estado: ended ? 'finalizada' : 'activa',
      cierre_motivo: group.explicit_end ? 'explicito' : restarted ? 'reinicio' : ended ? 'inactividad_inferida' : null,
      total: group.total, last_reading_at: group.last_reading_at, historica: group.historica,
      duracion_segundos: Math.max(0, (Date.parse(group.last_at) - Date.parse(group.inicio)) / 1000) };
  }).sort((a, b) => Date.parse(a.inicio) - Date.parse(b.inicio) || a.id.localeCompare(b.id));
}

const listDaySessions = async (filters, getClient) => groupSessions(await allRows(filters, getClient, true));
const listDayReadings = (filters, getClient) => fetchPage(filters, getClient);
async function daySummary(filters, getClient) {
  const rows = await allRows(filters, getClient);
  const summary = { total: rows.length, sesiones: new Set(rows.map((row) => row.session_key)).size };
  for (const field of ['temperatura', 'humedad', 'presion']) {
    let min = Infinity, max = -Infinity, sum = 0, count = 0;
    for (const row of rows) if (Number.isFinite(row[field])) { min = Math.min(min, row[field]); max = Math.max(max, row[field]); sum += row[field]; count++; }
    summary[field] = { min: count ? min : null, max: count ? max : null, avg: count ? sum / count : null };
  }
  return summary;
}

module.exports = { UUID, validSessionId, sessionKey, encodeCursor, decodeCursor, parseDailyFilters, listDaySessions, listDayReadings, daySummary, groupSessions, project };
