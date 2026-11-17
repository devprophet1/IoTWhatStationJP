// El consumidor se inicia desde server.js, nunca desde la entrada de Vercel.
const mqtt = require('mqtt');
const { saveReading } = require('../services/readings');
const { parseMqttPayload } = require('../services/sessions');

const TOPIC = 'estacion/mediciones';
const ERROR_MESSAGES = {
  MQTT_URL_INVALID: 'MQTT_URL debe ser una URL mqtts con host y puerto 8883, sin credenciales embebidas',
  MQTT_CREDENTIALS_MISSING: 'Falta MQTT_USERNAME o MQTT_PASSWORD',
  MQTT_TOPIC_INVALID: 'MQTT_TOPIC debe ser estacion/mediciones',
  ECONNREFUSED: 'El broker rechazó la conexión TCP',
  ENOTFOUND: 'No se pudo resolver el host del broker',
  EAI_AGAIN: 'Fallo temporal de DNS',
  ETIMEDOUT: 'Tiempo de conexión agotado',
  ECONNRESET: 'La conexión fue interrumpida',
  CERT_HAS_EXPIRED: 'El certificado TLS ha caducado',
  ERR_TLS_CERT_ALTNAME_INVALID: 'El certificado TLS no corresponde al host',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'No se pudo verificar la cadena del certificado TLS',
  4: 'El broker rechazó usuario o contraseña',
  5: 'El broker rechazó la autorización'
};

function describeMqttError(error) {
  // Solo mensajes de una lista fija: nunca imprimir errores crudos del proveedor.
  return Object.hasOwn(ERROR_MESSAGES, error?.code)
    ? ERROR_MESSAGES[error.code]
    : 'Fallo MQTT; revisar configuración, red, TLS y permisos';
}

function configurationError(code) {
  return Object.assign(new Error(ERROR_MESSAGES[code]), { code });
}

function connectMqtt({ env = process.env, connect = mqtt.connect,
  save = saveReading, logger = console } = {}) {
  const { MQTT_URL, MQTT_USERNAME, MQTT_PASSWORD } = env;
  let url;
  try { url = new URL(MQTT_URL); } catch { /* Se informa sin revelar la URL. */ }
  if (!url || url.protocol !== 'mqtts:' || !url.hostname ||
      (url.port || '8883') !== '8883' || url.username || url.password ||
      (url.pathname && url.pathname !== '/') || url.search || url.hash || MQTT_URL !== MQTT_URL.trim()) {
    throw configurationError('MQTT_URL_INVALID');
  }
  if (!MQTT_USERNAME?.trim() || !MQTT_PASSWORD?.trim()) {
    throw configurationError('MQTT_CREDENTIALS_MISSING');
  }
  const topic = env.MQTT_TOPIC || TOPIC;
  if (topic !== TOPIC) {
    throw configurationError('MQTT_TOPIC_INVALID');
  }
  logger.info('[MQTT] Iniciando conexión TLS a EMQX Cloud (puerto 8883)');
  const client = connect(MQTT_URL, {
    username: MQTT_USERNAME,
    password: MQTT_PASSWORD,
    rejectUnauthorized: true,
    port: 8883,
    reconnectPeriod: 5000,
    reconnectOnConnackError: true,
    connectTimeout: 30000,
    // Cada evento connect vuelve a suscribir y comprueba el permiso concedido.
    resubscribe: false
  });
  client.on('connect', () => {
    logger.info('[MQTT] Conectado a EMQX Cloud');
    client.subscribe(topic, { qos: 1 }, (error, granted) => {
      if (error || !granted?.some((grant) => grant.topic === topic && grant.qos < 128)) {
        logger.error(`[MQTT] Suscripción rechazada o fallida: ${TOPIC}; revisar permisos; se reintentará al reconectar`);
        return;
      }
      logger.info(`[MQTT] Suscripción activa: ${TOPIC}`);
    });
  });
  client.on('message', async (receivedTopic, payload) => {
    if (receivedTopic !== topic) return;
    logger.info(`[MQTT] Mensaje recibido en ${TOPIC}`);
    let reading;
    try {
      reading = parseMqttPayload(payload);
    } catch (error) {
      // parseReading genera mensajes constantes; nunca imprime el payload.
      logger.warn(`[MQTT] Mensaje descartado: ${error.message}`);
      return;
    }
    try {
      const result = await save(reading);
      if (result?.duplicate) logger.info('[MQTT] Mensaje repetido ignorado');
      else if (reading.event && reading.event !== 'reading') logger.info('[Sesiones] Evento de sesión procesado');
      else logger.info('[Supabase] Medición guardada en mediciones.datos');
    } catch {
      // No imprimir errores del proveedor: pueden contener datos o URLs privadas.
      logger.error('[Supabase] No se pudo guardar la medición; no se reintenta automáticamente');
    }
  });
  client.on('reconnect', () => logger.info('[MQTT] Intentando reconexión'));
  client.on('offline', () => logger.warn('[MQTT] Sin conexión; reconexión automática habilitada'));
  client.on('close', () => logger.info('[MQTT] Conexión cerrada'));
  client.on('error', (error) => logger.error(`[MQTT] ${describeMqttError(error)}`));
  return client;
}

module.exports = { connectMqtt, describeMqttError };
