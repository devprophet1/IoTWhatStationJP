const express = require('express');
const readings = require('./routes/readings');
const daily = require('./routes/daily');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'whater-station' });
});
app.use('/api/readings', readings);
app.use('/api', daily);
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Endpoint no encontrado' });
});

module.exports = app;
