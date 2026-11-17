const path = require('node:path');
const express = require('express');
const app = require('./app');
const { connectMqtt, describeMqttError } = require('./mqtt/client');

app.use(express.static(path.join(__dirname, '../../frontend')));
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Whater Station: http://localhost:${port}`);
  try {
    connectMqtt();
  } catch (error) {
    console.error(`[MQTT] No se pudo iniciar el consumidor: ${describeMqttError(error)}`);
  }
});
