# Sesiones en JSONB: estructura actual de Whater Station

La única tabla utilizada es `public.mediciones(id UUID, datos JSONB, created_at
TIMESTAMPTZ)`. No se requieren migraciones, RPC, tablas auxiliares, columnas nuevas
ni cambios a los registros existentes. La migración anterior fue retirada del
proyecto; no se ejecutó ningún SQL de creación o eliminación en Supabase.

## Encendido, identidad y finalización

`firmware/session_publisher.py` genera un UUID v4 en el constructor de
`SessionPublisher`, **una sola vez por sesión**. Se debe crear una instancia al
encender el ESP32, fuera del bucle de muestreo. Cada lectura (aproximadamente cada
3 segundos) reutiliza `self.session_id` y aumenta `seq`. Una reconexión MQTT
conserva la misma instancia, UUID y secuencia; un reintento repite el mismo mensaje.
Un nuevo encendido crea una instancia y un UUID nuevos. El backend no inventa ni
reemplaza identificadores por mensaje.

El consumidor admite identificadores históricos de texto, no solo UUID. `seq` es
opcional por compatibilidad, aunque el firmware incluido lo envía para reconocer
repeticiones. Los mensajes antiguos sin sesión siguen siendo consultables en un
grupo “Histórico sin sesión”. Actualmente los cuatro registros reales ya tienen
identificador y se agrupan con el valor existente, sin reasignación alguna.

Todos los mensajes usan `estacion/mediciones`, MQTT sobre TLS con verificación del
certificado y puerto 8883. Los objetos completos se insertan exclusivamente como
`{ datos: mensaje }`; `id` y `created_at` usan los defaults existentes. El timestamp
de recepción permanece en UTC. `captured_at` y `timestamp` del dispositivo se
conservan dentro de `datos`, sin sobrescribir el timestamp de la tabla.

Inicio de sesión (sin valores de sensores):

```json
{"event":"session_start","device_id":"esp32_001","session_id":"b494a113-6d3c-4f4b-a43e-11bf9792cb50","timestamp":"2026-11-23T14:00:00Z"}
```

Lectura:

```json
{"device_id":"esp32_001","session_id":"b494a113-6d3c-4f4b-a43e-11bf9792cb50","seq":0,"captured_at":"2026-11-23T14:00:03Z","temperatura":25.5,"humedad":65.2,"presion":1013.25}
```

Finalización normal mediante `session.finish()`:

```json
{"event":"session_end","device_id":"esp32_001","session_id":"b494a113-6d3c-4f4b-a43e-11bf9792cb50","timestamp":"2026-11-23T15:00:00Z"}
```

Los eventos de control también se guardan como filas JSONB en la **misma tabla**.
Se utilizan para el estado, pero se excluyen de gráficas, tarjetas, conteos de
mediciones y promedios, incluidos los de `/api/readings`. Los ejemplos anteriores
son documentación: no se publicaron ni se insertaron durante las pruebas.

Si se pierde la energía y no llega `session_end`, la API infiere el cierre tras
`SESSION_INACTIVITY_SECONDS` sin mensajes (120 segundos por defecto; 15–86400).
También reconoce como anterior un grupo cuando aparece otra sesión del mismo
dispositivo. El fin inferido corresponde al último mensaje observado, no al momento
en que se abrió la página. No se escribe un estado en la base ni existe un proceso
que modifique filas para cerrar sesiones. Cerrar el navegador no finaliza una sesión.

Una sesión inferida inactiva puede aparecer activa de nuevo si vuelve a recibir
datos con el mismo UUID; un fin explícito permanece finalizado. Un paquete atrasado
de un grupo anterior no se considera un nuevo arranque. Sin un evento de fin solo
es posible **inferir** la finalización: no se puede distinguir con certeza un corte
de red de un dispositivo apagado. Los registros históricos muestran el intervalo
observado dentro del día seleccionado, no una duración global inventada.

## Integrar el módulo en el ESP32

El módulo se mantiene separado de `main_esp32.py`, que no fue modificado. Requiere
Wi-Fi conectado, reloj NTP en UTC, CA del broker y `umqtt.simple` actual con
`SSLContext`. No desactivar `CERT_REQUIRED` ni copiar secretos al frontend.

```python
import time
from session_publisher import tls_client, SessionPublisher

# Usar la configuración privada y los sensores reales del dispositivo.
client = tls_client(MQTT_HOST, MQTT_USER, MQTT_PASSWORD, DEVICE_ID)
client.connect()
session = SessionPublisher(client, DEVICE_ID)  # Una vez, fuera del bucle.
session.start()
try:
    while measurement_enabled():
        temperatura, humedad, presion = read_real_sensors()
        session.publish_reading(temperatura, humedad, presion)
        time.sleep(3)
finally:
    session.finish()
    client.disconnect()
```

`measurement_enabled()` y `read_real_sensors()` son puntos de integración con el
control y los sensores existentes, no generadores de datos simulados. Un apagado
brusco puede impedir ejecutar `finally`; en ese caso se aplica la inactividad.

## API y agrupación

Las rutas existentes se conservan. Todas las consultas seleccionan únicamente
`id,datos,created_at` desde `mediciones`; no usan funciones de base de datos.

- `GET /api/sesiones?fecha=YYYY-MM-DD&device_id=...`: agrupa en Node.js por el par
  `(datos.device_id, datos.session_id)`. Devuelve inicio, fin, cantidad de lecturas,
  duración observada y estado inferido/expreso.
- `GET /api/mediciones?fecha=YYYY-MM-DD`: páginas de hasta 500 filas con
  `{ readings, snapshot, next_cursor, has_more }`. Devuelve `session_id` y
  `session_key` junto con los valores de sensores, UUID y timestamp UTC.
- `GET /api/resumen?fecha=YYYY-MM-DD`: calcula totales, mínimos, máximos y promedios
  recorriendo todas las páginas, sin cortar silenciosamente en 1000 registros.
- `/api/readings` conserva su contrato anterior y excluye los eventos de control.

`device_id`, `from` y `to` son opcionales. Los límites de hora se intersectan con
el día seleccionado. `session_ids` acepta identificadores JSONB separados por
coma. `session_keys` permite seleccionar pares dispositivo/sesión exactos, usando
los `id` devueltos por `/api/sesiones`. Omitir la selección significa todas;
enviarla vacía significa ninguna. Un mismo session_id en dos dispositivos no se
mezcla en el dashboard ni en las estadísticas.

Los cursores son opacos y representan `(created_at, id)`, preservando microsegundos.
Para completar un día, comenzar con `after=0`; mientras `has_more`, enviar el
`next_cursor` y el mismo `snapshot`. El snapshot es un límite temporal UTC. Una
actualización posterior usa el cursor conservado y omite snapshot. Nunca debe
interpretarse el cursor como un índice numérico.

El dashboard consulta novedades cada 10 segundos cuando hay actividad y cada 60
segundos para descubrir sesiones nuevas en el día actual. Las actualizaciones
incrementales releen 120 segundos de solapamiento y combinan por UUID para tolerar
confirmaciones recientes fuera de orden. La consulta de sesiones recorre el día
seleccionado para calcular su estado, no todo el historial. Fechas pasadas se
actualizan manualmente. El botón “Actualizar” vuelve a cargar el día completo,
también para detectar ediciones manuales o inserciones históricas retroactivas.

Con solo las tres columnas existentes no hay un cursor de commit persistente ni
una restricción única sobre JSONB. Por ello no se promete captura incremental de
ediciones arbitrariamente antiguas: se usa la recarga completa. La deduplicación
de mensajes con `seq`/evento consulta la tabla y serializa escrituras dentro del
consumidor. Ejecutar **un solo consumidor**: varios procesos concurrentes podrían
insertar duplicados sin una restricción única de base de datos. No se añadió esa
restricción porque esta versión no cambia el esquema. No hay cola durable para
caídas de Supabase ni para cortes de alimentación del dispositivo.

## Dashboard

Se conservan diseño, estilos, filtros diarios, selección múltiple, tarjetas,
resúmenes, gráfica combinada y las tres gráficas individuales. Las series se
separan por dispositivo y sesión; un hueco mayor de 15 segundos corta la línea.
La tabla pagina localmente sin recortar los datos de gráficas ni estadísticas.
Las tres escalas combinadas son independientes y la leyenda permite ocultar
variables. No se asume que la presión esté en hPa sin confirmación del sensor.

`America/Lima` se utiliza en toda fecha visible; la API conserva ISO UTC. No se
desplazan los timestamps dos veces. La entrada Vercel no inicia MQTT, ni timers ni
trabajos de mantenimiento. No se necesitan servicios nuevos ni ajustes de hosting.

## Pruebas

`npm.cmd test` ejecuta las pruebas sin servicios externos. El chequeo opcional de
Chrome usa Playwright Core instalado solo como herramienta temporal:

```powershell
$taskQa = Join-Path $env:TEMP 'whater-station-sql-check'
npm.cmd install --prefix $taskQa --no-save --package-lock=false --ignore-scripts playwright-core
$env:WHATER_PLAYWRIGHT_PATH = Join-Path $taskQa 'node_modules/playwright-core'
node backend/test/browser.integration.cjs
```

Chrome utiliza fixtures solo dentro de la prueba, nunca como datos del dashboard.
Los endpoints reales se verificaron por separado leyendo los cuatro registros
existentes, sin escrituras ni cambios de esquema. Resultados en `TESTING.md`.
