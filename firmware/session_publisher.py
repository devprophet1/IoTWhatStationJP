"""Módulo MicroPython separado: integrar con las lecturas REALES del ESP32.
Requiere umqtt.simple actual, SSLContext y reloj sincronizado con NTP en UTC.
No contiene credenciales ni reemplaza main_esp32.py.
"""
import os
import json
import time
import ssl
import math
from umqtt.simple import MQTTClient

TOPIC = b"estacion/mediciones"


def uuid4():
    raw = bytearray(os.urandom(16))
    raw[6] = (raw[6] & 0x0f) | 0x40
    raw[8] = (raw[8] & 0x3f) | 0x80
    value = "".join("%02x" % byte for byte in raw)
    return "%s-%s-%s-%s-%s" % (value[:8], value[8:12], value[12:16], value[16:20], value[20:])


def utc_now():
    parts = time.gmtime()
    return "%04d-%02d-%02dT%02d:%02d:%02dZ" % parts[:6]


def tls_client(host, username, password, device_id, ca_file="emqx-ca.pem"):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.verify_mode = ssl.CERT_REQUIRED
    context.load_verify_locations(cafile=ca_file)
    # umqtt.simple actual pasa server_hostname al envolver el socket.
    return MQTTClient(device_id.encode(), host, port=8883,
                      user=username.encode(), password=password.encode(),
                      keepalive=60, ssl=context)


class SessionPublisher:
    def __init__(self, mqtt_client, device_id, reconnect_wifi=None):
        self.client = mqtt_client
        self.device_id = device_id
        self.session_id = uuid4()  # Una vez por sesión; nunca por medición.
        self.seq = 0
        self.started_at = None
        self.closed = False
        self.reconnect_wifi = reconnect_wifi

    def _send(self, message):
        encoded = json.dumps(message).encode()
        # En un reintento se conserva exactamente session_id, seq y timestamp.
        while True:
            try:
                self.client.publish(TOPIC, encoded, retain=False, qos=1)
                return
            except OSError:
                print("MQTT desconectado; reintentando sin crear otra sesión")
                time.sleep(5)
                try:
                    if self.reconnect_wifi:
                        self.reconnect_wifi()
                    self.client.connect()
                except OSError:
                    pass

    def start(self):
        if self.closed:
            raise ValueError("Crear otro SessionPublisher para una nueva sesión")
        if self.started_at is None:
            self.started_at = utc_now()
        self._send({"event": "session_start", "device_id": self.device_id,
                    "session_id": self.session_id, "timestamp": self.started_at})

    def publish_reading(self, temperatura, humedad, presion):
        if self.closed:
            raise ValueError("Sesión finalizada")
        if not all(isinstance(value, (int, float)) and math.isfinite(value)
                   for value in (temperatura, humedad, presion)):
            raise ValueError("Lecturas no válidas")
        if not 0 <= humedad <= 100 or presion <= 0:
            raise ValueError("Lecturas fuera de rango")
        if self.started_at is None:
            self.start()
        self._send({"device_id": self.device_id, "session_id": self.session_id,
                    "seq": self.seq, "captured_at": utc_now(),
                    "temperatura": temperatura, "humedad": humedad, "presion": presion})
        self.seq += 1

    def finish(self):
        if self.closed:
            return
        self._send({"event": "session_end", "device_id": self.device_id,
                    "session_id": self.session_id, "timestamp": utc_now()})
        self.closed = True
