(() => {
  const $ = (selector) => document.querySelector(selector);
  const { drawChart, drawCombined, drawSparkline, deviceName, colorFor } = window.WhaterCharts;
  const { dateFormatter: date, limaInputToUtc, todayLima, TIME_ZONE } = window.WhaterTime;
  const { selectedRows, summarize, loadAllPages, readingFreshness, sessionIsRecent } = window.WhaterModel;
  const shortTime = new Intl.DateTimeFormat('es-PE', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const number = new Intl.NumberFormat('es-PE', { maximumFractionDigits: 2 });
  const knownDevices = new Set();
  const rows = new Map();
  const sessionBadges = new Map();
  let sessions = [], visibleRows = [], selected = null, cursor = '0';
  let filters = new URLSearchParams({ fecha: todayLima() });
  let controller, timer, lastSuccess, requestId = 0, tablePage = 0;
  $('#day').value = filters.get('fecha');

  const format = (value) => Number.isFinite(value) ? number.format(value) : '—';
  const sessionName = (id) => {
    const index = sessions.findIndex((s) => s.id === id), session = sessions[index];
    return id === 'legacy' || session?.historica ? 'Histórico sin sesión' : `Sesión ${Math.max(1, index + 1)} · ${(session?.session_id || id).slice(0, 18)}`;
  };
  function setStatus(message, state) { $('#status').textContent = message; $('#status').dataset.state = state; }
  function emptyNode(message) { const p = document.createElement('p'); p.className = 'chart-empty'; p.textContent = message; return p; }
  function duration(seconds) {
    const minutes = Math.max(0, Math.floor(seconds / 60));
    return minutes < 60 ? `${minutes} min ${Math.max(0, Math.floor(seconds % 60))} s` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  }

  function renderSessions() {
    const focusedKey = document.activeElement?.getAttribute?.('data-session-id');
    let restoreFocus;
    const list = $('#sessions-list');
    list.replaceChildren(); sessionBadges.clear();
    if (!sessions.length) { list.append(emptyNode('Todavía no hay sesiones para este día. Prueba otra fecha.')); return; }
    for (const session of sessions) {
      const label = document.createElement('label'); label.className = 'session-row';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selected === null || selected.has(session.id);
      checkbox.setAttribute('data-session-id', session.id);
      label.setAttribute('data-selected', checkbox.checked ? 'true' : 'false');
      if (session.id === focusedKey) restoreFocus = checkbox;
      checkbox.addEventListener('change', () => {
        if (selected === null) selected = new Set(sessions.map((s) => s.id));
        if (checkbox.checked) selected.add(session.id); else selected.delete(session.id);
        label.setAttribute('data-selected', checkbox.checked ? 'true' : 'false');
        tablePage = 0; render();
      });
      const info = document.createElement('span'); info.className = 'session-info';
      for (const [tag, text] of [['strong', `${sessionName(session.id)}${session.device_id ? ` · ${session.device_id}` : ''}`],
        ['small', `${shortTime.format(new Date(session.inicio))} → ${session.fin ? shortTime.format(new Date(session.fin)) : 'sin fin confirmado'} · Lima`],
        ['small', `Duración ${duration(session.duracion_segundos || 0)} · ${session.total} ${session.total === 1 ? 'medición' : 'mediciones'}`]]) {
        const node = document.createElement(tag); node.textContent = text; info.append(node);
      }
      info.title = `${date.format(new Date(session.inicio))} → ${session.fin ? date.format(new Date(session.fin)) : 'sin fin confirmado'} Lima`;
      const badge = document.createElement('span'); badge.className = 'session-state';
      sessionBadges.set(session.id, badge);
      label.append(checkbox, info, badge); list.append(label);
    }
    updateFreshness();
    restoreFocus?.focus?.();
  }

  function updateFreshness() {
    const historical = filters.get('fecha') !== todayLima();
    const latest = visibleRows[0];
    const state = readingFreshness(latest, { historical });
    $('#device-id').textContent = latest?.device_id || filters.get('device_id') || 'Sin dispositivo en la selección';
    $('#device-last-reading').textContent = latest ? date.format(new Date(latest.created_at)) : '—';
    $('#device-last-reading').setAttribute('datetime', latest?.created_at || '');
    $('#device-status').textContent = state.label; $('#device-status').dataset.state = state.state;
    $('#device-status-detail').textContent = state.detail;
    for (const session of sessions) {
      const badge = sessionBadges.get(session.id);
      if (!badge) continue;
      const recent = !historical && sessionIsRecent(session);
      badge.className = `session-state${recent ? ' active' : ''}`;
      badge.textContent = session.historica ? 'Histórico sin sesión' : session.estado === 'finalizada' ? 'Finalizada' : recent ? 'Lecturas recientes' : !session.last_reading_at ? 'Esperando lecturas' : 'Sin lecturas recientes';
      badge.title = session.cierre_motivo === 'explicito' ? 'Fin confirmado por evento del dispositivo' : session.estado === 'finalizada' ? 'Fin inferido por el historial de mensajes' : 'Estado inferido de la hora de la última medición; no indica conexión MQTT';
    }
    const recentSelected = !historical && sessions.some((s) => sessionIsRecent(s) && (selected === null || selected.has(s.id)));
    $('#view-mode').textContent = historical ? 'Histórico · Actualización manual' : recentSelected ? 'Lecturas recientes · Consulta cada 10 s' : 'Hoy · Buscar nuevas lecturas';
  }

  function renderTable() {
    const size = Number($('#limit').value) || 200;
    const pages = Math.max(1, Math.ceil(visibleRows.length / size));
    tablePage = Math.min(tablePage, pages - 1);
    const table = $('#readings-table'); table.replaceChildren();
    for (const row of visibleRows.slice(tablePage * size, (tablePage + 1) * size)) {
      const tr = document.createElement('tr');
      for (const value of [date.format(new Date(row.created_at)), deviceName(row), sessionName(row.session_key || row.session_id || 'legacy'), format(row.temperatura), format(row.humedad), format(row.presion)]) {
        const td = document.createElement('td'); td.textContent = value; tr.append(td);
      }
      table.append(tr);
    }
    if (!visibleRows.length) {
      const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 6;
      td.textContent = 'No hay mediciones para las sesiones y horas seleccionadas.'; tr.append(td); table.append(tr);
    }
    $('#table-page').textContent = `Página ${tablePage + 1} de ${pages} · ${visibleRows.length} ${visibleRows.length === 1 ? 'medición' : 'mediciones'}`;
    $('#table-prev').disabled = tablePage === 0; $('#table-next').disabled = tablePage >= pages - 1;
  }

  function renderCombined() {
    const fields = [['temperatura', '#show-temperature'], ['humedad', '#show-humidity'], ['presion', '#show-pressure']].filter(([, id]) => $(id).checked).map(([field]) => field);
    drawCombined($('#combined-chart'), visibleRows, fields, sessionName);
  }

  function render() {
    visibleRows = selectedRows([...rows.values()], selected);
    const latest = visibleRows[0], summary = summarize(visibleRows);
    $('#temperature').textContent = format(latest?.temperatura); $('#humidity').textContent = format(latest?.humedad); $('#pressure').textContent = format(latest?.presion);
    $('#latest-context').textContent = latest ? `${deviceName(latest)} · ${date.format(new Date(latest.created_at))} Lima · ${sessionName(latest.session_key || latest.session_id || 'legacy')}` : 'Sin datos para la selección';
    $('#count').textContent = `${visibleRows.length} ${visibleRows.length === 1 ? 'medición completa' : 'mediciones completas'}`;
    $('#summary-count').textContent = visibleRows.length ? format(summary.total) : '—';
    $('#summary-sessions').textContent = sessions.length ? format(sessions.filter((s) => selected === null || selected.has(s.id)).length) : '—';
    const selectedCount = sessions.filter((s) => selected === null || selected.has(s.id)).length;
    $('#summary-sessions-label').textContent = selectedCount === 1 ? 'sesión seleccionada' : 'sesiones seleccionadas';
    $('#summary-count-label').textContent = visibleRows.length === 1 ? 'medición' : 'mediciones';
    for (const [field, id] of [['temperatura', 'temperature'], ['humedad', 'humidity'], ['presion', 'pressure']]) {
      for (const stat of ['min', 'max', 'avg']) $(`#${id}-${stat}`).textContent = format(summary[field][stat]);
      drawSparkline($(`#${id}-sparkline`), visibleRows, field);
    }
    $('#session-selection-count').textContent = `${selectedCount} de ${sessions.length} ${sessions.length === 1 ? 'seleccionada' : 'seleccionadas'}`;
    updateFreshness();
    const devices = [...new Set(visibleRows.map(deviceName))].sort();
    const legend = $('#legend'); legend.replaceChildren();
    devices.forEach((device, index) => {
      const item = document.createElement('span'); item.className = 'legend-item';
      const swatch = document.createElement('span'); swatch.className = 'legend-line'; swatch.style.borderTopStyle = index > 0 ? 'dashed' : 'solid';
      if (devices.length > 1) swatch.style.borderTopColor = colorFor(index);
      const name = document.createElement('span'); name.textContent = device; item.append(swatch, name); legend.append(item);
    });
    for (const row of rows.values()) if (row.device_id) knownDevices.add(row.device_id);
    for (const session of sessions) if (session.device_id) knownDevices.add(session.device_id);
    $('#devices').replaceChildren(...[...knownDevices].sort().map((device) => { const option = document.createElement('option'); option.value = device; return option; }));
    drawChart($('#temperature-chart'), visibleRows, 'temperatura', 'Temperatura', devices, sessionName);
    drawChart($('#humidity-chart'), visibleRows, 'humedad', 'Humedad relativa', devices, sessionName);
    drawChart($('#pressure-chart'), visibleRows, 'presion', 'Presión atmosférica', devices, sessionName);
    renderCombined(); renderTable();
  }

  async function refresh(full = false) {
    clearTimeout(timer); controller?.abort(); controller = new AbortController();
    const signal = controller.signal, id = ++requestId;
    $('#refresh').disabled = true; $('#measurements').setAttribute('aria-busy', 'true');
    setStatus(lastSuccess ? 'Buscando nuevas mediciones…' : 'Cargando el día completo…', 'loading');
    async function get(path, params) {
      const request = new AbortController();
      const abort = () => request.abort(); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) request.abort();
      const timeout = setTimeout(abort, 12000);
      try {
        const response = await fetch(`${path}?${params}`, { signal: request.signal, cache: 'no-store' });
        if (!response.ok) {
          throw new Error('Consulta fallida');
        }
        return await response.json();
      } finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); }
    }
    try {
      const sessionParams = new URLSearchParams({ fecha: filters.get('fecha') });
      if (filters.has('device_id')) sessionParams.set('device_id', filters.get('device_id'));
      const [metadata, additions] = await Promise.all([
        get('/api/sesiones', sessionParams),
        loadAllPages(({ after, snapshot }) => {
          const params = new URLSearchParams(filters); params.set('after', after); params.set('page_size', '500');
          if (after !== '0' && snapshot === null) params.set('overlap_seconds', '120');
          if (snapshot !== null) params.set('snapshot', snapshot);
          return get('/api/mediciones', params);
        }, { after: full ? '0' : cursor, signal, onProgress: (n) => { if (id === requestId && !lastSuccess) setStatus(`Cargando el día completo: ${n} mediciones…`, 'loading'); } })
      ]);
      if (id !== requestId) return;
      if (!Array.isArray(metadata.sessions)) throw new Error('Sesiones inválidas');
      sessions = metadata.sessions;
      if (full) rows.clear();
      for (const row of additions.readings) rows.set(row.id, row);
      cursor = additions.cursor; lastSuccess = new Date();
      renderSessions(); render();
      $('#updated').textContent = `Consulta: ${date.format(lastSuccess)} Lima`;
      setStatus(rows.size ? `Día completo cargado · ${rows.size} ${rows.size === 1 ? 'medición disponible' : 'mediciones disponibles'}` : 'No hay mediciones para este día y rango. Puedes elegir otra fecha.', rows.size ? 'success' : 'empty');
    } catch (error) {
      if (id !== requestId) return;
      controller.abort();
      setStatus(`No se pudo actualizar el día. ${lastSuccess ? 'Se conservan los datos de la última consulta exitosa.' : 'Intenta nuevamente.'}`, 'error');
    } finally {
      if (id === requestId) {
        $('#refresh').disabled = false; $('#measurements').setAttribute('aria-busy', 'false');
        if (filters.get('fecha') === todayLima()) {
          const delay = sessions.some((s) => s.estado === 'activa') ? 10000 : 60000;
          timer = setTimeout(() => { if (!document.hidden) refresh(); }, delay);
        }
      }
    }
  }

  function applyFilters() {
    if (!$('#filters').reportValidity()) return;
    const next = new URLSearchParams({ fecha: $('#day').value });
    if ($('#device').value.trim()) next.set('device_id', $('#device').value.trim());
    try {
      for (const field of ['from', 'to']) if ($(`#${field}`).value) next.set(field, limaInputToUtc($(`#${field}`).value));
      if (next.has('from') && next.has('to') && next.get('from') > next.get('to')) throw new Error('range');
    } catch { setStatus('Revisa el rango horario de Lima.', 'error'); return; }
    if (next.toString() !== filters.toString()) {
      filters = next; rows.clear(); sessions = []; selected = null; cursor = '0'; lastSuccess = null; tablePage = 0;
      $('#updated').textContent = 'Esperando consulta'; renderSessions(); render();
    }
    refresh();
  }
  $('#filters').addEventListener('submit', (event) => { event.preventDefault(); applyFilters(); });
  $('#day').addEventListener('change', () => { $('#from').value = ''; $('#to').value = ''; applyFilters(); });
  $('#reset').addEventListener('click', () => { $('#filters').reset(); $('#day').value = todayLima(); applyFilters(); });
  $('#refresh').addEventListener('click', () => refresh(true));
  $('#select-all').addEventListener('click', () => { selected = null; tablePage = 0; renderSessions(); render(); });
  $('#select-none').addEventListener('click', () => { selected = new Set(); tablePage = 0; renderSessions(); render(); });
  $('#metric-toggles').addEventListener('change', renderCombined);
  $('#limit').addEventListener('change', () => { tablePage = 0; renderTable(); });
  $('#table-prev').addEventListener('click', () => { tablePage = Math.max(0, tablePage - 1); renderTable(); });
  $('#table-next').addEventListener('click', () => { tablePage++; renderTable(); });
  const tabs = ['resumen', 'graficas', 'historial'];
  function switchTab(name, focus = false) {
    for (const tab of tabs) {
      const active = tab === name;
      $(`#tab-${tab}`).setAttribute('aria-selected', String(active));
      $(`#tab-${tab}`).tabIndex = active ? 0 : -1;
      $(`#panel-${tab}`).hidden = !active;
    }
    if (focus) $(`#tab-${name}`).focus();
  }
  for (const [index, name] of tabs.entries()) {
    $(`#tab-${name}`).addEventListener('click', () => switchTab(name));
    $(`#tab-${name}`).addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
      switchTab(tabs[next], true);
    });
  }
  $('#open-graphs').addEventListener('click', () => switchTab('graficas', true));
  document.addEventListener('visibilitychange', () => { clearTimeout(timer); if (!document.hidden) refresh(); });
  function updateClock() {
    if (!document.hidden) updateFreshness();
    setTimeout(updateClock, 15000);
  }
  switchTab('resumen'); renderSessions(); render(); refresh(); setTimeout(updateClock, 15000);
})();
