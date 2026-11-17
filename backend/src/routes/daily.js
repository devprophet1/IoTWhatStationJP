const { Router } = require('express');
const { parseDailyFilters, listDaySessions, listDayReadings, daySummary } = require('../services/daily');

function createDailyRouter({ sessions = listDaySessions, readings = listDayReadings, summary = daySummary, logger = console } = {}) {
  const router = Router();
  for (const [path, action, key] of [['/sesiones', sessions, 'sessions'], ['/mediciones', readings, null], ['/resumen', summary, 'summary']]) {
    router.get(path, async (req, res) => {
      res.set('Cache-Control', 'no-store');
      let filters;
      try { filters = parseDailyFilters(req.query); }
      catch (error) { return res.status(400).json({ error: error.message }); }
      try {
        const value = await action(filters);
        res.json(key ? { [key]: value } : value);
      } catch (error) {
        logger.error('[Supabase] Falló la consulta diaria; revisar permisos o disponibilidad');
        res.status(503).json({ error: 'No se pudo consultar el día. Intenta nuevamente.', code: 'DAILY_QUERY_FAILED' });
      }
    });
  }
  return router;
}

module.exports = createDailyRouter();
module.exports.createDailyRouter = createDailyRouter;
