(() => {
  const TIME_ZONE = 'America/Lima';
  const dateFormatter = new Intl.DateTimeFormat('es-PE', {
    timeZone: TIME_ZONE, dateStyle: 'medium', timeStyle: 'medium', hourCycle: 'h23'
  });

  // datetime-local no incluye zona. Se interpreta una sola vez como UTC-5,
  // independientemente de la zona configurada en el navegador.
  function limaInputToUtc(value) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) throw new Error('Fecha u hora inválida');
    const complete = value.length === 16 ? `${value}:00` : value;
    const date = new Date(`${complete}-05:00`);
    if (!Number.isFinite(date.getTime())) throw new Error('Fecha u hora inválida');
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(date).map(({ type, value: part }) => [type, part]));
    const roundTrip = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
    if (roundTrip !== complete) throw new Error('Fecha u hora inválida');
    return date.toISOString();
  }

  function limaDayRange(day) {
    const from = limaInputToUtc(`${day}T00:00:00`);
    // Supabase admite microsegundos: el límite final cubre el último segundo completo.
    const nextDay = new Date(Date.parse(from) + 86400000).toISOString();
    return { from, before: nextDay };
  }

  function todayLima(now = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map(({ type, value }) => [type, value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  const api = { TIME_ZONE, dateFormatter, limaInputToUtc, limaDayRange, todayLima };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.WhaterTime = api;
})();
