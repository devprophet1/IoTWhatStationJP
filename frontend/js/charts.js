/* SVG nativo: sin dependencias, fuentes ni servicios externos. */
(() => {
  const { TIME_ZONE, dateFormatter } = typeof module !== 'undefined' && module.exports ? require('./time') : window.WhaterTime;
  const palette = ['#176b65', '#cc764d', '#4587b1', '#8870a4', '#b28a32', '#be5e83'];
  const colorFor = (index) => palette[index % palette.length];
  const deviceName = (row) => row.device_id ?? 'Sin dispositivo';
  const NS = 'http://www.w3.org/2000/svg';
  // Lima no tiene horario de verano: las marcas del eje se alinean a UTC−5 fijo.
  const LIMA_OFFSET = 5 * 3600000;
  const GAP = 15000;
  const INK = { grid: '#e6edf0', baseline: '#c8d5db', label: '#5a7381', crosshair: '#4f6977' };
  const number = new Intl.NumberFormat('es-PE', { maximumFractionDigits: 2 });
  const hourFormat = new Intl.DateTimeFormat('es-PE', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const dayFormat = new Intl.DateTimeFormat('es-PE', { timeZone: TIME_ZONE, day: '2-digit', month: '2-digit' });
  const format = (value) => Number.isFinite(value) ? number.format(value) : '—';

  const metrics = {
    temperatura: { name: 'Temperatura', unit: '°C', label: 'Temperatura °C', color: '#cc764d', textColor: '#a65731' },
    humedad: { name: 'Humedad', unit: '%', label: 'Humedad %', color: '#4587b1', textColor: '#246e9b' },
    presion: { name: 'Presión', unit: '', label: 'Presión · sensor', color: '#176b65', textColor: '#176b65' }
  };

  const svgNode = (name, attributes = {}, text) => {
    const node = document.createElementNS(NS, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const htmlNode = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function chartModel(readings, field) {
    const groups = new Map();
    const times = [];
    const values = [];
    for (const row of [...readings].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
      const time = Date.parse(row.created_at);
      if (!Number.isFinite(time)) continue;
      const key = row.session_id ? `${deviceName(row)}\u0000${row.session_id}` : deviceName(row);
      if (!groups.has(key)) groups.set(key, []);
      const value = Number.isFinite(row[field]) ? row[field] : null;
      groups.get(key).push({ time, value, reading: row });
      times.push(time);
      if (value !== null) values.push(value);
    }
    if (!values.length) return null;
    let minTime = times.reduce((a, b) => Math.min(a, b), Infinity), maxTime = times.reduce((a, b) => Math.max(a, b), -Infinity);
    if (minTime === maxTime) { minTime -= 30000; maxTime += 30000; }
    const min = values.reduce((a, b) => Math.min(a, b), Infinity), max = values.reduce((a, b) => Math.max(a, b), -Infinity);
    const pad = (max - min) * .12 || Math.max(Math.abs(min) * .02, 1);
    return { groups, minTime, maxTime, min: min - pad, max: max + pad };
  }

  // Tramos continuos: dos lecturas a más de 15 s se consideran un hueco real.
  function segments(points) {
    const runs = [];
    let run = [], previous = null;
    for (const point of points) {
      if (point.value === null) { previous = null; continue; }
      if (!previous || point.time - previous.time > GAP) { run = []; runs.push(run); }
      run.push(point); previous = point;
    }
    return runs;
  }

  function pointPath(points, x, y) {
    let path = '', previous = null;
    for (const point of points) {
      if (point.value === null) { previous = null; continue; }
      const join = previous !== null && point.time - previous.time <= GAP;
      path += `${join ? 'L' : 'M'}${x(point.time)},${y(point.value)} `;
      previous = point;
    }
    return path;
  }

  function areaPath(points, x, y, floor) {
    return segments(points).filter((run) => run.length > 1)
      .map((run) => `M${x(run[0].time)},${floor} ${run.map((p) => `L${x(p.time)},${y(p.value)}`).join(' ')} L${x(run.at(-1).time)},${floor} Z`).join(' ');
  }

  // Marcas "redondas" (1, 2, 2,5, 5 × 10ⁿ) dentro del dominio.
  function niceTicks(min, max, count) {
    const raw = (max - min) / Math.max(1, count);
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw);
    const ticks = [];
    for (let value = Math.ceil(min / step) * step; value <= max + step * 1e-9; value += step) ticks.push(Number(value.toFixed(10)));
    return ticks;
  }

  const timeSteps = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].map((minutes) => minutes * 60000);
  function timeTicks(minTime, maxTime, maxCount) {
    const span = maxTime - minTime;
    const step = timeSteps.find((s) => span / s <= maxCount) || Math.ceil(span / maxCount / 86400000) * 86400000;
    const ticks = [];
    for (let time = Math.ceil((minTime - LIMA_OFFSET) / step) * step + LIMA_OFFSET; time <= maxTime; time += step) ticks.push(time);
    return ticks;
  }

  // Redibuja al ancho real del contenedor: el texto conserva su tamaño en móvil.
  const views = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver((entries) => {
    for (const entry of entries) {
      const view = views.get(entry.target);
      if (view && entry.contentRect.width > 0 && Math.abs(entry.contentRect.width - view.width) > 4) view.redraw();
    }
  }) : null;
  function track(container, width, redraw) {
    if (!observer) return;
    views.set(container, { width, redraw });
    observer.observe(container);
  }

  function renderTimeChart(container, config) {
    const width = Math.max(280, container.clientWidth || 900);
    const compact = width < 560;
    const stacked = config.lanes.length > 1;
    const margin = { left: compact ? 42 : 54, right: compact ? 48 : 62, top: 4, bottom: 30 };
    const titleSpace = stacked ? 24 : 10, laneGap = stacked ? 22 : 0;
    const laneHeight = config.laneHeight(compact);
    let cursor = margin.top;
    const lanes = config.lanes.map((lane) => {
      const top = cursor + titleSpace, bottom = top + laneHeight;
      cursor = bottom + laneGap;
      return { ...lane, top, bottom, y: (value) => bottom - (value - lane.min) / (lane.max - lane.min) * laneHeight };
    });
    const plotTop = lanes[0].top, plotBottom = lanes.at(-1).bottom, height = plotBottom + margin.bottom;
    const plotLeft = margin.left, plotRight = width - margin.right;
    const { minTime, maxTime } = config;
    const x = (time) => plotLeft + (time - minTime) / (maxTime - minTime) * (plotRight - plotLeft);
    const svg = svgNode('svg', { class: 'time-chart', viewBox: `0 0 ${width} ${height}`, role: 'img', tabindex: '0', 'aria-label': config.label });

    const multiDay = dayFormat.format(minTime) !== dayFormat.format(maxTime);
    for (const time of timeTicks(minTime, maxTime, Math.max(2, Math.floor((plotRight - plotLeft) / (compact ? 64 : 92))))) {
      const px = x(time);
      for (const lane of lanes) svg.append(svgNode('line', { x1: px, x2: px, y1: lane.top, y2: lane.bottom, stroke: INK.grid }));
      const anchor = px < plotLeft + 20 ? 'start' : px > plotRight - 20 ? 'end' : 'middle';
      const label = multiDay ? `${dayFormat.format(time)} ${hourFormat.format(time)}` : hourFormat.format(time);
      svg.append(svgNode('text', { x: px, y: plotBottom + 20, 'text-anchor': anchor, fill: INK.label, 'font-size': 11 }, label));
    }

    for (const lane of lanes) {
      const metric = metrics[lane.field];
      if (stacked) {
        svg.append(svgNode('text', { x: plotLeft, y: lane.top - 9, fill: '#2c485a', 'font-size': 12, 'font-weight': 600 }, metric.label));
      }
      for (const value of niceTicks(lane.min, lane.max, laneHeight >= 140 ? 4 : 3)) {
        svg.append(svgNode('line', { x1: plotLeft, x2: plotRight, y1: lane.y(value), y2: lane.y(value), stroke: INK.grid }));
        svg.append(svgNode('text', { x: plotLeft - 8, y: lane.y(value) + 4, 'text-anchor': 'end', fill: INK.label, 'font-size': 11 }, format(value)));
      }
      svg.append(svgNode('line', { x1: plotLeft, x2: plotRight, y1: lane.bottom, y2: lane.bottom, stroke: INK.baseline }));
      let last = null;
      for (const series of lane.series) {
        if (lane.area) svg.append(svgNode('path', { d: areaPath(series.points, x, lane.y, lane.bottom), fill: series.color, 'fill-opacity': '.09', stroke: 'none' }));
        svg.append(svgNode('path', { d: pointPath(series.points, x, lane.y), stroke: series.color, 'stroke-width': 2, fill: 'none', 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'stroke-dasharray': series.dashed ? '6 3' : 'none' }));
        const valid = series.points.filter((point) => point.value !== null);
        // Puntos solo cuando hay pocas lecturas o quedan aislados (sin línea que los muestre).
        for (const run of segments(series.points)) {
          if (run.length > 1 && valid.length > 40) continue;
          for (const point of run) svg.append(svgNode('circle', { cx: x(point.time), cy: lane.y(point.value), r: 3, fill: series.color, stroke: 'white', 'stroke-width': 1.5 }));
        }
        const end = valid.at(-1);
        if (end && (!last || end.time > last.point.time)) last = { point: end, color: series.color };
      }
      if (last) {
        const ly = Math.min(lane.bottom - 2, Math.max(lane.top + 10, lane.y(last.point.value) + 4));
        svg.append(svgNode('text', { x: plotRight + 7, y: ly, fill: '#2c485a', 'font-size': 11, 'font-weight': 600 }, format(last.point.value)));
      }
    }

    // Capa de exploración: cursor, toque o teclado.
    const crosshair = svgNode('line', { y1: plotTop, y2: plotBottom, stroke: INK.crosshair, 'stroke-width': 1, 'stroke-dasharray': '3 3', visibility: 'hidden', 'pointer-events': 'none' });
    const markers = lanes.map(() => svgNode('circle', { r: 4.5, fill: 'white', 'stroke-width': 2.5, visibility: 'hidden', 'pointer-events': 'none' }));
    svg.append(crosshair, ...markers);

    const frame = htmlNode('div', 'chart-frame');
    if (config.stats) frame.append(config.stats);
    const tooltip = htmlNode('div', 'chart-tooltip');
    tooltip.setAttribute('role', 'status'); tooltip.setAttribute('aria-live', 'polite'); tooltip.setAttribute('aria-atomic', 'true');
    tooltip.dataset.visible = 'false';
    const hint = htmlNode('p', 'chart-hint', compact ? 'Toca la gráfica para ver cada lectura.' : 'Pasa el cursor sobre la gráfica o usa ← → para recorrer las lecturas.');
    const rows = config.rows, times = rows.map((row) => Date.parse(row.created_at));
    let focusedIndex = -1, shownIndex = -1;

    function hide() {
      shownIndex = -1; tooltip.dataset.visible = 'false';
      crosshair.setAttribute('visibility', 'hidden');
      for (const marker of markers) marker.setAttribute('visibility', 'hidden');
    }
    function show(index) {
      focusedIndex = index;
      if (shownIndex === index) return;
      shownIndex = index;
      const row = rows[index], px = x(times[index]);
      crosshair.setAttribute('x1', px); crosshair.setAttribute('x2', px); crosshair.setAttribute('visibility', 'visible');
      lanes.forEach((lane, i) => {
        const value = row[lane.field];
        if (!Number.isFinite(value)) { markers[i].setAttribute('visibility', 'hidden'); return; }
        markers[i].setAttribute('cx', px); markers[i].setAttribute('cy', lane.y(value));
        markers[i].setAttribute('stroke', config.colorOf(row, lane.field)); markers[i].setAttribute('visibility', 'visible');
      });
      tooltip.replaceChildren();
      const context = htmlNode('strong', 'tooltip-context', `${dateFormatter.format(new Date(row.created_at))} Lima`);
      const meta = htmlNode('p', 'tooltip-meta', `${deviceName(row)} · ${config.sessionName(row.session_key || row.session_id || 'legacy')}`);
      const values = htmlNode('div', 'tooltip-values');
      for (const field of config.fields) {
        const item = htmlNode('span', '', `${metrics[field].label}: `);
        item.style.setProperty?.('--swatch', config.colorOf(row, field));
        item.append(htmlNode('b', '', format(row[field])));
        values.append(item);
      }
      tooltip.append(context, meta, values);
      tooltip.dataset.visible = 'true';
      // Coloca la tarjeta junto al cursor sin salir del panel.
      const frameWidth = frame.clientWidth || width, tipWidth = tooltip.offsetWidth || 220;
      const left = px / width * frameWidth;
      tooltip.style.left = `${Math.max(0, left + 14 + tipWidth > frameWidth ? left - 14 - tipWidth : left + 14)}px`;
      tooltip.style.top = `${(config.stats?.offsetHeight || 0) + plotTop / height * (svg.clientHeight || height)}px`;
    }
    const nearest = (target) => {
      let low = 0, high = times.length;
      while (low < high) { const middle = (low + high) >> 1; if (times[middle] < target) low = middle + 1; else high = middle; }
      return [low, low - 1].filter((i) => i >= 0 && i < times.length).sort((a, b) => Math.abs(times[a] - target) - Math.abs(times[b] - target))[0];
    };
    const inspect = (event) => {
      const rect = svg.getBoundingClientRect();
      const px = Math.min(plotRight, Math.max(plotLeft, (event.clientX - rect.left) / rect.width * width));
      const target = minTime + (px - plotLeft) / (plotRight - plotLeft) * (maxTime - minTime);
      const index = nearest(target);
      // Acepta la lectura más cercana si cae dentro de un hueco corto o a menos de 24 px.
      if (index === undefined || (Math.abs(times[index] - target) > GAP && Math.abs(x(times[index]) - px) > 24)) { hide(); return; }
      show(index);
    };
    svg.addEventListener('pointermove', inspect);
    svg.addEventListener('pointerdown', inspect);
    svg.addEventListener('pointerleave', (event) => { if (event.pointerType !== 'touch') hide(); });
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key) || !rows.length) return;
      event.preventDefault();
      if (event.key === 'Escape') { hide(); return; }
      const step = event.shiftKey ? 10 : 1;
      show(event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, focusedIndex < 0 ? 0 : focusedIndex + (event.key === 'ArrowRight' ? step : -step))));
    });

    frame.append(svg, tooltip);
    container.append(frame, hint);
    track(container, width, config.redraw);
  }

  function emptyState(container, message) {
    container.append(htmlNode('p', 'chart-empty', message));
  }

  const orderedRows = (readings, fields) => readings
    .filter((row) => Number.isFinite(Date.parse(row.created_at)) && fields.some((field) => Number.isFinite(row[field])))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

  function chartStats(rows, field) {
    const values = rows.map((row) => row[field]).filter(Number.isFinite);
    const stats = htmlNode('dl', 'chart-stats');
    const unit = metrics[field].unit ? ` ${metrics[field].unit}` : '';
    for (const [label, value] of [['Última', values.at(-1)], ['Mín', Math.min(...values)], ['Máx', Math.max(...values)]]) {
      const item = htmlNode('div');
      item.append(htmlNode('dt', '', label), htmlNode('dd', '', `${format(value)}${unit}`));
      stats.append(item);
    }
    return stats;
  }

  function drawChart(container, readings, field, title, devices, sessionName = (id) => id) {
    container.replaceChildren();
    const model = chartModel(readings, field);
    if (!model) { emptyState(container, 'Sin mediciones para este rango'); return; }
    if (new Set(readings.map((row) => Date.parse(row.created_at))).size === 1) {
      drawSingleReading(container, readings, [field], title, sessionName);
      return;
    }
    const multi = devices.length > 1;
    const colorOf = (row) => multi ? colorFor(Math.max(0, devices.indexOf(deviceName(row)))) : metrics[field].color;
    const rows = orderedRows(readings, [field]);
    renderTimeChart(container, {
      lanes: [{ field, min: model.min, max: model.max, area: !multi, series: [...model.groups.values()].map((points) => ({ points, color: colorOf(points[0].reading), dashed: multi && devices.indexOf(deviceName(points[0].reading)) > 0 })) }],
      minTime: model.minTime, maxTime: model.maxTime, laneHeight: (compact) => compact ? 150 : 190,
      rows, fields: [field], colorOf, sessionName, stats: chartStats(rows, field),
      label: `${title}. Evolución por dispositivo en horario de Lima, UTC-5. Usa flechas izquierda y derecha para recorrer las lecturas. Datos detallados en Historial.`,
      redraw: () => drawChart(container, readings, field, title, devices, sessionName)
    });
  }

  function trendModel(readings, field) {
    const model = chartModel(readings, field);
    const count = readings.filter((row) => Number.isFinite(row[field]) && Number.isFinite(Date.parse(row.created_at))).length;
    let continuous = false;
    for (const points of model?.groups.values() || []) {
      let run = 0, previous;
      for (const point of points) {
        run = point.value === null ? 0 : previous && point.time > previous.time && point.time - previous.time <= GAP ? run + 1 : 1;
        if (run >= 3) continuous = true;
        previous = point.value === null ? undefined : point;
      }
    }
    return { model: continuous ? model : null, count, label: count === 0 ? 'Sin datos del periodo' : count === 1 ? 'Una lectura · Sin tendencia todavía' : count < 3 ? `${count} lecturas · Esperando más datos` : 'Lecturas aisladas · Sin tendencia continua' };
  }

  function drawSparkline(container, readings, field) {
    container.replaceChildren();
    const trend = trendModel(readings, field);
    if (!trend.model) {
      const note = htmlNode('span', 'sparkline-note', trend.label); container.append(note); return;
    }
    const { model } = trend;
    const svg = svgNode('svg', { viewBox: '0 0 320 48', preserveAspectRatio: 'none', role: 'img', 'aria-label': `${metrics[field].label}: tendencia real del periodo; se respetan sesiones e intervalos sin datos` });
    const x = (time) => 2 + (time - model.minTime) / (model.maxTime - model.minTime) * 316;
    const y = (value) => 44 - (value - model.min) / (model.max - model.min) * 40;
    for (const points of model.groups.values()) {
      svg.append(svgNode('path', { d: areaPath(points, x, y, 48), fill: metrics[field].color, 'fill-opacity': '.1', stroke: 'none' }));
      svg.append(svgNode('path', { d: pointPath(points, x, y), fill: 'none', stroke: metrics[field].color, 'stroke-width': '2', 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' }));
    }
    container.append(svg);
  }

  function drawSingleReading(container, readings, fields, title, sessionName = (id) => id) {
    const row = readings[0], count = readings.length;
    const card = htmlNode('div', 'single-reading');
    card.setAttribute('role', 'img'); card.setAttribute('aria-label', `${title}. ${count} lectura(s) en un instante, horario de Lima. No hay evolución temporal.`);
    const marker = htmlNode('span', 'single-marker', '•'); marker.setAttribute('aria-hidden', 'true');
    const info = htmlNode('div');
    const heading = htmlNode('strong', '', count === 1 ? 'Una lectura, todavía sin evolución' : `${count} lecturas en un mismo instante`);
    const caption = htmlNode('p', '', `${dateFormatter.format(new Date(row.created_at))} Lima · ${count === 1 ? `${deviceName(row)} · ${sessionName(row.session_key || row.session_id || 'Histórico sin sesión')}` : 'Consulta el detalle por dispositivo en Historial'}`);
    info.append(heading, caption);
    if (count === 1) {
      const values = htmlNode('div', 'single-values');
      for (const field of fields) {
        const value = htmlNode('span', '', `${metrics[field].label}: ${format(row[field])}`); value.style.color = metrics[field].textColor; values.append(value);
      }
      info.append(values);
    }
    card.append(marker, info); container.append(card);
  }

  // Un panel por variable con eje de tiempo compartido: evita superponer tres escalas en un solo eje.
  function drawCombined(container, readings, fields, sessionName = (id) => id) {
    container.replaceChildren();
    const visible = fields.filter((field) => metrics[field]);
    const models = visible.map((field) => [field, chartModel(readings, field)]).filter(([, model]) => model);
    if (!models.length) { emptyState(container, visible.length ? 'Sin mediciones para esta selección' : 'Selecciona al menos una variable'); return; }
    if (new Set(readings.map((row) => Date.parse(row.created_at))).size === 1) {
      drawSingleReading(container, readings, visible, 'Evolución ambiental combinada', sessionName);
      return;
    }
    const minTime = Math.min(...models.map(([, model]) => model.minTime)), maxTime = Math.max(...models.map(([, model]) => model.maxTime));
    renderTimeChart(container, {
      lanes: models.map(([field, model]) => ({ field, min: model.min, max: model.max, area: true, series: [...model.groups.values()].map((points) => ({ points, color: metrics[field].color })) })),
      minTime, maxTime, laneHeight: (compact) => models.length === 1 ? 170 : compact ? 84 : 100,
      rows: orderedRows(readings, visible), fields: visible, colorOf: (row, field) => metrics[field].color, sessionName,
      label: `Evolución ambiental combinada: ${models.map(([field]) => metrics[field].label).join(', ')}. Un panel por variable con el mismo eje de tiempo, hora de Lima. Usa flechas izquierda y derecha para explorar las lecturas.`,
      redraw: () => drawCombined(container, readings, fields, sessionName)
    });
  }

  const api = { chartModel, drawChart, drawCombined, drawSparkline, trendModel, pointPath, niceTicks, timeTicks, colorFor, deviceName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.WhaterCharts = api;
})();
