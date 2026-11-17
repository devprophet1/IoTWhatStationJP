(() => {
  const sessionKey = (row) => row.session_key || row.session_id || 'legacy';
  const newestFirst = (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id.localeCompare(a.id);

  function selectedRows(rows, selected, range = {}) {
    return rows.filter((row) => (selected === null || selected.has(sessionKey(row))) &&
      (!range.from || Date.parse(row.created_at) >= Date.parse(range.from)) &&
      (!range.to || Date.parse(row.created_at) <= Date.parse(range.to))).sort(newestFirst);
  }

  function summarize(rows) {
    const summary = { total: rows.length, sesiones: new Set(rows.map(sessionKey)).size };
    for (const field of ['temperatura', 'humedad', 'presion']) {
      let min = Infinity, max = -Infinity, sum = 0, n = 0;
      for (const row of rows) if (Number.isFinite(row[field])) {
        min = Math.min(min, row[field]); max = Math.max(max, row[field]); sum += row[field]; n++;
      }
      summary[field] = { min: n ? min : null, max: n ? max : null, avg: n ? sum / n : null };
    }
    return summary;
  }

  async function loadAllPages(fetchPage, { after = '0', signal, onProgress = () => {} } = {}) {
    const readings = new Map();
    let cursor = after, snapshot = null;
    for (;;) {
      if (signal?.aborted) throw new Error('Consulta cancelada');
      const page = await fetchPage({ after: cursor, snapshot });
      if (!Array.isArray(page.readings) || typeof page.next_cursor !== 'string' || typeof page.snapshot !== 'string' || typeof page.has_more !== 'boolean') throw new Error('Página inválida');
      if (snapshot !== null && snapshot !== page.snapshot) throw new Error('La instantánea cambió');
      snapshot = page.snapshot;
      for (const row of page.readings) readings.set(row.id, row);
      onProgress(readings.size);
      if (!page.has_more) return { readings: [...readings.values()], cursor: page.next_cursor };
      if (page.next_cursor === cursor) throw new Error('La paginación no avanzó');
      cursor = page.next_cursor;
    }
  }

  function readingFreshness(reading, { now = Date.now(), historical = false } = {}) {
    const time = Date.parse(reading?.created_at);
    if (!Number.isFinite(time)) return { state: 'empty', label: 'Sin mediciones', detail: 'No hay lecturas en la selección.' };
    if (historical) return { state: 'historical', label: 'Datos históricos', detail: 'La fecha seleccionada no indica el estado actual del dispositivo.' };
    const age = now - time;
    if (age < -5000) return { state: 'unknown', label: 'Hora por verificar', detail: 'La medición tiene una fecha futura; no confirma actividad.' };
    const elapsed = age < 60000 ? `${Math.max(0, Math.floor(age / 1000))} s` : age < 3600000 ? `${Math.floor(age / 60000)} min` : `${Math.floor(age / 3600000)} h`;
    return { state: age <= 30000 ? 'recent' : 'stale', label: age <= 30000 ? 'Lecturas recientes' : 'Sin lecturas recientes', detail: `Última lectura hace ${elapsed}. No confirma una conexión MQTT actual.` };
  }

  function sessionIsRecent(session, now = Date.now()) {
    return session.estado === 'activa' && session.total > 0 &&
      readingFreshness({ created_at: session.last_reading_at }, { now }).state === 'recent';
  }

  const api = { sessionKey, newestFirst, selectedRows, summarize, loadAllPages, readingFreshness, sessionIsRecent };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.WhaterModel = api;
})();
