const { Router } = require('express');
const { parseReadingFilters, listReadings } = require('../services/readings');

function createReadingsRouter({ list = listReadings, logger = console } = {}) {
  const router = Router();
  router.get('/', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    let filters;
    try { filters = parseReadingFilters(req.query); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    try {
      const readings = await list(filters);
      res.json({ readings, meta: { ...filters, count: readings.length } });
    } catch {
      logger.error('[Supabase] Error al consultar mediciones; detalles privados omitidos');
      res.status(503).json({ error: 'No se pudieron consultar las mediciones. Intenta nuevamente.' });
    }
  });
  return router;
}

module.exports = createReadingsRouter();
module.exports.createReadingsRouter = createReadingsRouter;
