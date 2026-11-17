# Interfaz del observatorio ambiental

Se conservan la arquitectura HTML/CSS/JavaScript, el encabezado oscuro, la paleta,
las fuentes del sistema y los gráficos SVG propios. No se añadieron dependencias
de producción ni se modificaron el backend MQTT, el contrato de las API, las
credenciales o el esquema `mediciones(id,datos,created_at)`.

## Vistas y componentes

- **Resumen:** última medición, tarjetas compactas con iconos SVG, mínimo/máximo/
  promedio del periodo y gráfica combinada en paneles apilados (uno por variable).
- **Gráficas:** tres gráficos individuales, color consistente por métrica y
  patrones de línea por dispositivo. Se conservan los datos y los cortes por sesión.
- **Historial:** tabla paginada del periodo seleccionado, encabezados fijos y
  desplazamiento interno para evitar páginas excesivamente largas.
- Los filtros y las sesiones son comunes: cambiar de pestaña conserva fecha,
  dispositivo, horas y selección. Los filtros quedan accesibles al desplazar la
  página en escritorio y móvil vertical; en pantallas de poca altura se prioriza
  el espacio disponible para el contenido.

Las tarjetas usan naranja para temperatura, azul para humedad y verde para presión.
Las estadísticas incluyen todas las lecturas filtradas, no únicamente las filas
visibles de tabla. La presión conserva su unidad original, sin asumir hPa.

## Visualización sin inventar información

Una sparkline exige tres lecturas consecutivas, con timestamps distintos, dentro
del mismo dispositivo/sesión y con separación máxima de 15 segundos. Sin ese tramo
se indica lectura única, datos insuficientes o lecturas aisladas. No se dibujan
tendencias ficticias ni se conectan sesiones distintas. Las líneas conservan todas
las lecturas, aunque se reduzca el número de círculos para disminuir ruido visual.

Una lectura puntual o varias lecturas simultáneas no se presentan con una curva
temporal. La gráfica combinada muestra un resumen compacto del instante. Con varias
lecturas en el tiempo dibuja un panel por variable, cada uno con su propia escala Y,
compartiendo un único eje X real (sin ejes Y superpuestos) y un cursor sincronizado.
La leyenda permite activar y desactivar cada variable. El tooltip muestra hora de
Lima, dispositivo, sesión y valores de las variables visibles, sin redondear los
datos almacenados ni modificar la API.

## Estado del dispositivo

“Lecturas recientes” significa que se observó una medición de la selección hace
30 segundos o menos. No significa “MQTT conectado”. Más de 30 segundos se indica
como ausencia de lecturas recientes; los días anteriores se identifican como
históricos y no se interpretan como estado actual. Los timestamps futuros se
señalan para revisión, sin destacar actividad no demostrada.

Una sesión se destaca solo si la API la considera activa, tiene mediciones y la
última lectura es reciente. Un evento de inicio sin lecturas muestra “Esperando
lecturas”. Un fin explícito o inferido mantiene la etiqueta de finalizada. El
estado de consulta HTTP aparece en un área separada, por lo que un navegador con
conexión no implica que el ESP32 esté transmitiendo.

La frescura se recalcula cada 15 segundos sin nuevas consultas. Se mantienen las
consultas automáticas existentes (10/60 segundos según actividad, cuando el día
actual está visible), el historial manual y la conversión mediante `America/Lima`.

## Accesibilidad y responsive

- Pestañas con roles tab/tablist/tabpanel, `aria-selected`, paneles ocultos y un
  único tab activo. Flechas izquierda/derecha, Inicio y Fin cambian la pestaña.
- Foco visible, enlace para saltar al contenido, etiquetas de formulario y scopes
  en encabezados de tabla. Los iconos decorativos no se anuncian como contenido.
- Todos los gráficos temporales permiten recorrer lecturas con flechas (Mayús = 10),
  Inicio, Fin y Esc, además de cursor y toque.
  No depende exclusivamente del hover; las mismas lecturas permanecen en la tabla.
- Tooltips con textos y colores consistentes, estados identificados por texto y
  no solo color, y transiciones discretas que respetan `prefers-reduced-motion`.
- Los gráficos se redibujan al ancho real del contenedor (texto a tamaño fijo y menos
  marcas en pantallas estrechas); en móvil el tooltip pasa a una lectura fija bajo la
  gráfica. La página no se desborda horizontalmente. Los estados de
  lectura única no reservan un lienzo grande ni requieren desplazamiento.

## Verificación

Las pruebas de Node, Chrome con fixtures y Chrome contra Supabase real se detallan
en `TESTING.md`. La prueba real captura las respuestas recibidas por el dashboard
para comparar tarjetas y estadísticas con su mismo lote: el ESP32 puede continuar
enviando lecturas mientras se prueba. Ninguna prueba escribe mediciones en Supabase.
