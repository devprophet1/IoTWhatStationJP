
import network
import time
import json
import random
import os
import socket

from umqtt.simple import MQTTClient

# ==========================================
# CONFIGURACION
# ==========================================

WIFI_SSID = "FAMILIAMAJERHUA 2024"
WIFI_PASSWORD = "TU_CLAVE_WIFI"

# Solo hostname, sin mqtts:// ni :8883
MQTT_HOST = "e8df0f01.ala.us-east-1.emqxsl.com"
MQTT_PORT = 8883
MQTT_USER = "iotjp"
MQTT_PASSWORD = "JPardo20261*"
MQTT_TOPIC = b"estacion/mediciones"

MQTT_TOPIC = b"estacion/mediciones"

DEVICE_ID = "esp32_001"
INTERVALO = 3
REINTENTO = 5


# ==========================================
# CONECTAR WIFI
# ==========================================

def conectar_wifi():
    wifi = network.WLAN(network.STA_IF)
    wifi.active(True)

    if not wifi.isconnected():
        print("Conectando al Wi-Fi...")
        wifi.connect(WIFI_SSID, WIFI_PASSWORD)

        inicio = time.ticks_ms()

        while not wifi.isconnected():
            if time.ticks_diff(
                time.ticks_ms(), inicio
            ) > 15000:
                raise OSError("Timeout de Wi-Fi")

            time.sleep_ms(500)

    print("Wi-Fi conectado:", wifi.ifconfig()[0])
    return wifi


# ==========================================
# GENERAR ID DE SESION
# ==========================================

def crear_session_id():
    identificador = os.urandom(12).hex()

    return "ses_{}_{}".format(
        DEVICE_ID,
        identificador
    )


# ==========================================
# COMPROBAR TCP
# ==========================================

def comprobar_tcp():
    direccion = socket.getaddrinfo(
        MQTT_HOST,
        MQTT_PORT
    )[0][-1]

    sock = socket.socket()
    sock.settimeout(10)

    try:
        sock.connect(direccion)
        print("Conexion TCP correcta")
    finally:
        sock.close()


# ==========================================
# CONECTAR MQTT
# ==========================================

def conectar_mqtt():
    print("Conectando a EMQX Cloud...")

    client_id = (
        DEVICE_ID + "_" + os.urandom(4).hex()
    )

    cliente = MQTTClient(
        client_id=client_id,
        server=MQTT_HOST,
        port=MQTT_PORT,
        user=MQTT_USER,
        password=MQTT_PASSWORD,
        keepalive=60,
        ssl=True,
        ssl_params={
            "server_hostname": MQTT_HOST
        }
    )

    cliente.connect()

    print("MQTT conectado correctamente")
    print("Topico:", MQTT_TOPIC)

    return cliente


# ==========================================
# GENERAR MEDICIONES SIMULADAS
# ==========================================

def generar_medicion(session_id):
    return {
        "device_id": DEVICE_ID,
        "session_id": session_id,
        "temperatura": round(
            random.uniform(24, 32), 2
        ),
        "humedad": round(
            random.uniform(55, 75), 2
        ),
        "presion": round(
            random.uniform(995, 1020), 2
        )
    }


# ==========================================
# PROGRAMA PRINCIPAL
# ==========================================

def main():
    session_id = crear_session_id()
    cliente = None
    contador = 0

    print("==============================")
    print("WHATER STATION - ESP32")
    print("Sesion:", session_id)
    print("Intervalo:", INTERVALO, "segundos")
    print("==============================")

    try:
        while True:
            try:
                # Verificar conexion Wi-Fi
                conectar_wifi()

                # Conectar MQTT si es necesario
                if cliente is None:
                    comprobar_tcp()
                    cliente = conectar_mqtt()

                # Generar medicion
                medicion = generar_medicion(session_id)
                mensaje = json.dumps(medicion)

                # Publicar MQTT
                cliente.publish(
                    MQTT_TOPIC,
                    mensaje,
                    qos=0
                )

                contador += 1

                print("------------------------------")
                print("Medicion numero:", contador)
                print("Temperatura:", medicion["temperatura"], "C")
                print("Humedad:", medicion["humedad"], "%")
                print("Presion:", medicion["presion"])
                print("Session ID:", session_id)
                print("MQTT: publicado")
                print("------------------------------")

                time.sleep(INTERVALO)

            except KeyboardInterrupt:
                raise

            except Exception as error:
                print("ERROR:", repr(error))

                if cliente is not None:
                    try:
                        cliente.disconnect()
                    except Exception:
                        pass

                cliente = None

                # Un error de autenticacion requiere
                # corregir las credenciales.
                if (
                    error.__class__.__name__ == "MQTTException"
                    and error.args
                    and error.args[0] == 4
                ):
                    print(
                        "EMQX rechazo el usuario o la clave MQTT."
                    )
                    print(
                        "Corrige las credenciales y reinicia."
                    )
                    break

                print(
                    "Reintentando en",
                    REINTENTO,
                    "segundos..."
                )
                time.sleep(REINTENTO)

    except KeyboardInterrupt:
        print("Detenido manualmente")

    finally:
        if cliente is not None:
            try:
                cliente.disconnect()
            except Exception:
                pass

        print("Sesion finalizada")
        print("Total de publicaciones:", contador)


# ==========================================
# EJECUTAR
# ==========================================

main()
