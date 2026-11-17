# Whater Station

Monitoreo ambiental con ESP32, MQTT/EMQX Cloud, Node.js, Express, Supabase y un
dashboard HTML/CSS/JavaScript con gráficas SVG, sin frameworks de frontend.

## Base de datos actual

Solo se utiliza `public.mediciones`: `id UUID`, `datos JSONB`, `created_at TIMESTAMPTZ`.
`datos` contiene `device_id`, `session_id`, `temperatura`, `humedad` y `presion`.
El JSON completo se conserva. La API agrupa las sesiones por dispositivo e
identificador JSONB; no utiliza tablas relacionales, RPC ni columnas auxiliares.

**No se necesita ejecutar ninguna migración SQL.** La migración relacional anterior
fue retirada del proyecto. No se eliminaron ni alteraron registros de Supabase.

## Ejecución

Node.js 24 y las dependencias declaradas en `package.json`:

1. En una instalación nueva: `npm install`.
2. Configurar `.env` en la raíz tomando `.env.example` como referencia. Conservar
   las credenciales existentes; no subir el archivo al repositorio.
3. `npm start` y abrir `http://localhost:3000`.
4. `npm test` para ejecutar las pruebas sin acceder a servicios externos.

En PowerShell, si la política bloquea `npm.ps1`, usar `npm.cmd start` y `npm.cmd test`.

## Organización

- `backend/src/app.js`: aplicación HTTP reutilizada localmente y en Vercel.
- `backend/src/server.js`: servidor persistente que inicia también MQTT.
- `backend/src/config/supabase.js`: cliente privado de Supabase.
- `backend/src/mqtt/client.js`: conexión TLS, suscripción y recepción de mensajes.
- `backend/src/services/readings.js`: validación, inserción JSONB y consulta compatible.
- `backend/src/services/daily.js`: consultas paginadas, agrupación y resúmenes diarios.
- `backend/src/services/sessions.js`: validación de mensajes y eventos MQTT.
- `backend/src/routes/`: API HTTP.
- `frontend/`: dashboard estático, filtros, fechas de Lima y gráficas SVG.
- `firmware/session_publisher.py`: módulo MicroPython separado para el ESP32.
- `api/index.js`: entrada serverless sin iniciar MQTT.

## Dashboard diario

Selecciona automáticamente el día actual de `America/Lima` y permite consultar
fechas anteriores, dispositivo, horas y una o varias sesiones. Se conservan las
tarjetas, el resumen diario, la gráfica combinada con tres escalas independientes,
las tres gráficas individuales y la tabla paginada. No se unen sesiones diferentes
ni intervalos sin datos mayores de 15 segundos.

Las consultas recorren todas las páginas del día: más de 1000 mediciones no se
recortan silenciosamente. El número de filas de tabla solo cambia la paginación
visual, no los datos de las gráficas o estadísticas. La presión conserva la unidad
del sensor; no se infiere hPa sin confirmación.

Las fechas se almacenan y se devuelven en UTC; se muestran con `Intl.DateTimeFormat`
y `America/Lima`. Un día local comprende desde `05:00Z` hasta antes de `05:00Z` del
día siguiente. Los filtros no aplican dos veces el desplazamiento horario.

Las sesiones activas del día actual se actualizan cada 10 segundos, y sin actividad
se buscan novedades cada 60 segundos. Se recuperan lecturas posteriores al cursor,
con 120 segundos de solapamiento y combinación por UUID. Las fechas históricas no
se consultan continuamente. “Actualizar” vuelve a cargar el día completo para
detectar también cambios manuales antiguos. Los errores conservan los datos previos.

## API

- `GET /api/health`: disponibilidad de Express; no verifica servicios externos.
- `GET /api/sesiones?fecha=YYYY-MM-DD`: sesiones agrupadas por JSONB, horarios
  observados, cantidad de lecturas y estado explícito o inferido.
- `GET /api/mediciones?fecha=YYYY-MM-DD`: páginas de hasta 500 filas; respuesta
  `{ readings, snapshot, next_cursor, has_more }`. Cursores opacos de timestamp+UUID.
- `GET /api/resumen?fecha=YYYY-MM-DD`: agregados completos de las sesiones seleccionadas.
- `GET /api/readings`: contrato anterior, `{ readings, meta }`, orden `created_at
  DESC` e `id DESC`, límite predeterminado 200, validado entre 1 y 1000. Admite
  `device_id`, `from`, `to` y `before` con zona horaria explícita.

Las rutas diarias aceptan `device_id`, rango ISO `from`/`to`, `session_ids` y
`session_keys`. Los identificadores de grupo devueltos por la API distinguen dos
dispositivos aunque reutilicen el mismo session_id. Los parámetros inválidos
devuelven HTTP 400; los fallos de consulta, HTTP 503 sin detalles privados.
Las respuestas no se almacenan en caché. Contratos en [docs/SESIONES.md](docs/SESIONES.md).

## MQTT y sesiones

Se mantiene `estacion/mediciones`, MQTT sobre TLS (`mqtts://`) y puerto 8883, con
verificación de certificado, reconexión y resuscripción. Al encender, el módulo
MicroPython genera un UUID una sola vez. Lo conserva en todas las lecturas y
reintentos hasta terminar la sesión. El backend nunca genera un UUID por mensaje.

Los eventos `session_start`/`session_end` también se conservan dentro de `datos`
en la misma tabla y se excluyen de las lecturas y estadísticas. Si falta el evento
de fin, el estado se infiere por inactividad (120 s predeterminados, configurable
con `SESSION_INACTIVITY_SECONDS`) o al aparecer una sesión posterior del dispositivo.
Sin evento de fin no se puede distinguir con certeza apagado de desconexión.
No hay un mantenimiento que escriba cierres en la base ni dependencia del navegador.

La deduplicación de mensajes con `seq` o eventos consulta el JSONB y serializa las
escrituras en un consumidor. No equivale a una restricción única de base de datos:
mantener un solo consumidor para evitar carreras entre procesos. Los mensajes
sin secuencia no se deduplican arbitrariamente. Los errores se registran sin
credenciales ni payloads; no hay cola durable para fallos de Supabase.

## Vercel Hobby y seguridad

Se conserva `vercel.json`: raíz del repositorio, preset Other y salida estática
`frontend`, sin compilación. `api/index.js` expone Express sin abrir un puerto ni
iniciar MQTT o timers. El consumidor debe ejecutarse como proceso persistente
fuera de Vercel. No se agregaron servicios ni dependencias de producción.

Las cinco rutas de API tienen rewrites explícitos hacia `/api` en `vercel.json`.
No usar `/api/:path*` con destino `/api`: Vercel convierte la captura no utilizada
en `?path=...`, y ese parámetro adicional es rechazado por la validación estricta.
Al añadir otro endpoint hay que añadir también su rewrite explícito. Cualquier
cambio en esta configuración requiere subir el commit y desplegarlo de nuevo.

Configurar las variables privadas de Supabase en Vercel. El navegador solo utiliza
la API HTTP: nunca recibe la clave `service_role` ni credenciales MQTT. `.env` queda
excluido de Git. El dashboard no incorpora autenticación de usuarios.

Resultados de pruebas reales y aisladas en [TESTING.md](TESTING.md). La integración
del firmware con los sensores reales y el despliegue de esta versión son manuales.

## Interfaz del observatorio

El dashboard conserva HTML, CSS, JavaScript y SVG nativo y se organiza en las
pestañas Resumen, Gráficas e Historial. Los filtros de dispositivo y fecha son
comunes a las tres vistas. El rango horario opcional se despliega por separado.
Las tarjetas incluyen iconos, mínimo/máximo/promedio y una sparkline solo si existen
al menos tres lecturas consecutivas del mismo tramo de sesión. Una única medición
se presenta como lectura puntual, sin inventar una curva temporal.

El indicador de dispositivo distingue lectura reciente (hasta 30 segundos), datos
antiguos, consulta histórica y ausencia de datos. No interpreta el éxito de la
consulta HTTP como conexión MQTT del ESP32. Las sesiones sin lecturas confirmadas
no se destacan como activas. Detalles de interacción y pruebas en [docs/UI.md](docs/UI.md).
