const { parseReading, parseReadingFilters } = require('./readings');
const { validSessionId } = require('./daily');

function parseMqttPayload(payload) {
  let message;
  try { message = JSON.parse(payload.toString('utf8')); }
  catch { throw new Error('JSON inválido'); }
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Se esperaba un objeto JSON');
  const event = message.event || 'reading';
  if (!['reading', 'session_start', 'session_end'].includes(event)) throw new Error('Tipo de evento desconocido');
  if (typeof message.device_id !== 'string' || !message.device_id.trim() || message.device_id.length > 128) throw new Error('device_id inválido');
  if (event === 'reading') parseReading(payload);
  if (event !== 'reading' || message.session_id !== undefined) {
    if (!validSessionId(message.session_id)) throw new Error('session_id debe ser una cadena válida de hasta 128 caracteres');
    if (event === 'reading' && message.seq !== undefined && (!Number.isSafeInteger(message.seq) || message.seq < 0 || message.seq > 999999999999999)) throw new Error('seq debe ser un entero entre 0 y 999999999999999');
  }
  for (const field of ['timestamp', 'captured_at']) if (message[field] !== undefined) {
    try { parseReadingFilters({ from: message[field] }); }
    catch { throw new Error('Timestamp MQTT inválido; requiere zona horaria explícita'); }
    if (Date.parse(message[field]) > Date.now() + 300000) throw new Error('Timestamp MQTT demasiado adelantado');
  }
  return message;
}

module.exports = { parseMqttPayload };
