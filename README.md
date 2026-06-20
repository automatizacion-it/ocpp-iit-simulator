# OCPP IIT Simulator

Simulador de protocolo **OCPP 1.6J** para pruebas del ecosistema de cargadores **IIT** (Infraestructura-IT), sin necesidad de hardware físico ni servidor backend.

Dos páginas HTML independientes se comunican en tiempo real a través de la [BroadcastChannel API](https://developer.mozilla.org/en-US/docs/Web/API/Broadcast_Channel_API) del navegador, simulando el intercambio de mensajes entre un **Charge Point** (cargador) y un **CSMS** (Central System / servidor central).

## Archivos

| Archivo | Rol | Descripción |
|---|---|---|
| `cargador.html` | Charge Point | Simula el cargador IIT. Botones para BootNotification, Authorize, StartTransaction, MeterValues automático, StopTransaction, fallas, etc. |
| `csms.html` | Central System | Monitor en tiempo real de todos los mensajes recibidos, gráfica de potencia en vivo, costo estimado en COP, y comandos remotos (RemoteStart/RemoteStop/Reset). |

## Cómo usar

1. Clona el repo
2. Abre `cargador.html` en una pestaña del navegador
3. Abre `csms.html` en **otra pestaña del mismo navegador** (mismo origen — debe ser el mismo navegador, no necesariamente el mismo perfil)
4. Pulsa los botones en `cargador.html` en este orden:
   - **BootNotification** → registra el cargador
   - **Authorize** → autoriza el idTag (RFID)
   - **Conectar cable** → StatusNotification → Preparing
   - **StartTransaction** → inicia la sesión de carga
   - **▶ MeterValues auto** → empieza a enviar telemetría cada 3s (kWh, W, V, A)
   - **StopTransaction** → cierra la sesión

5. Desde `csms.html` puedes enviar comandos remotos de vuelta al cargador:
   - **RemoteStartTransaction**
   - **RemoteStopTransaction**
   - **Reset**

Todo el tráfico se ve en el log de mensajes de ambas páginas, con el frame OCPP real `[messageTypeId, uniqueId, action, payload]`.

## Por qué BroadcastChannel y no WebSocket

Esta es la **fase 1** de validación — probar la lógica de estados y el formato de mensajes OCPP sin levantar infraestructura. No requiere Node.js, no requiere servidor, no requiere conexión a internet. Basta abrir los dos archivos en el navegador.

La estructura de cada mensaje (`action`, `payload`, frame `[2, msgId, action, payload]`) es **idéntica** a la que usará el CSMS real en Node.js — el siguiente paso es reemplazar `BroadcastChannel` por `WebSocket` (`ws` en el cargador real con ESP32-S3, y el servidor `ws` de Node.js en `relay.js`).

## Próximos pasos (fase 2)

- [ ] Servidor CSMS real en Node.js (`ws` + Express) integrado a `relay.js`
- [ ] Firmware ESP32-S3 con cliente WebSocket OCPP 1.6J (WiFi nativo)
- [ ] Persistencia de sesiones en Supabase
- [ ] Facturación vía MATIAS API (DIAN)

## Stack

- HTML / CSS / JavaScript vanilla — sin dependencias, sin build step
- Identidad visual IIT: fondo `#080b10`, cyan `#00d4ff`, verde `#10b981`, púrpura `#7c3aed`
- Tipografía: Syne (display) + Space Mono (mono/datos)

---

**Infraestructura-IT (IIT)** · Construye. Conecta. Evoluciona.
