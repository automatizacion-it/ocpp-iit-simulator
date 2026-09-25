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

La estructura de cada mensaje (`action`, `payload`, frame `[2, msgId, action, payload]`) es **idéntica** a la del OCPP 1.6J real. El simulador reproduce el perfil del cargador físico DC 30 kW (modelo EU-30KW, placa MDXDC3001, firmware SSWL_DC-V1.0.69).

## Fase 2 — CSMS en red local con el cargador real

La carpeta `server/` tiene un CSMS OCPP 1.6J mínimo en Node.js (`ws`) que el cargador físico puede usar como servidor en la LAN. Responde BootNotification, Heartbeat, StatusNotification, Authorize, StartTransaction (con `transactionId` incremental), MeterValues, StopTransaction y DataTransfer, y guarda todo el tráfico en `server/logs/*.jsonl`.

```
cd server
npm install
npm start
```

En el cargador (menú de administración, clave de fábrica 1234):

- **Net Settings**: `com_type` = Ethernet, `dhcp` = off, IP fija, máscara y gateway de la misma red que el PC.
- **Basic Settings**: `domain_master` = `ws://<IP-del-PC>:9000/ocpp`, `pile_number_master` = número de serie, `Time setting` con la hora actual.

### Panel de pruebas

Con el servidor corriendo, abre `http://<IP-del-PC>:9000/`. El panel lista los 24 comandos que OCPP 1.6J define del CSMS al cargador (Core, gestión de firmware, lista local, reservas, carga inteligente y disparo remoto), con un payload de ejemplo editable. Muestra la respuesta de cada uno y arma una matriz de compatibilidad que se puede descargar en JSON. El botón *Probar los comandos de solo lectura* ejecuta en secuencia los que no cambian el estado del cargador.

Para probar el panel sin el equipo real, en otra terminal: `npm run sim` (cargador simulado EU-30KW).

Comandos por consola: `start`, `stop`, `reset`, `config`, `set <clave> <valor>`, `trigger <Mensaje>`, `list`.

## Próximos pasos

- [ ] Integrar los handlers en el módulo `ocpp-gateway` de Electrolineras (NestJS + PostgreSQL)
- [ ] Autorización de idTag contra la base de datos del operador
- [ ] Tarifa por operador y facturación por sesión (Wompi)
- [ ] TLS (`wss://`) para operación fuera de la LAN

## Stack

- HTML / CSS / JavaScript vanilla — sin dependencias, sin build step
- Identidad visual IIT: fondo `#080b10`, cyan `#00d4ff`, verde `#10b981`, púrpura `#7c3aed`
- Tipografía: Syne (display) + Space Mono (mono/datos)

---

**Infraestructura-IT (IIT)** · Construye. Conecta. Evoluciona.
