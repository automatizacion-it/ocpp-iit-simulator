# CLAUDE.md — ocpp-iit-simulator

Contexto del proyecto para sesiones futuras de Claude (o de cualquier desarrollador) trabajando en este repo.

## Qué es esto

Simulador de protocolo **OCPP 1.6J** para validar el flujo de mensajes del ecosistema de cargadores **IIT** (Infraestructura-IT) y del cargador físico DC 30 kW (EU-30KW, placa MDXDC3001) antes de levantar el CSMS en producción.

Dos páginas HTML estáticas, sin backend, sin dependencias, comunicadas vía `BroadcastChannel` del navegador.

## Por qué existe

Banco de pruebas OCPP de la plataforma **Electrolineras** (marketplace de operadores con comisión por sesión). El hardware de referencia es un cargador comercial DC 30 kW ya en mano; IIT no fabrica el cargador, solo desarrolla el CSMS.

## Cargador de referencia

- Modelo EU-30KW, placa MDXDC3001, serie MDX20260715001, conector CCS2, salida 200–1000 VDC / 0–100 A
- Controladora STM32, firmware SSWL_DC-V1.0.69 (SSWL; servidor OCPP de fábrica ocpp.sswl.com)
- Comunicación: Ethernet, WiFi o 4G (Quectel EC20, sin SIM por ahora); OCPP 1.6J, con TLS opcional
- Parámetros OCPP en pantalla: `domain_master`, `pile_number_master`, `pile_password_master`; red en Set up → Net Settings
- Carga real registrada en logs: ~422 V, 50–65 A (≈21–27 kW)

## Estado actual

- ✅ `cargador.html` — simulador Charge Point: BootNotification, Authorize, StatusNotification (Preparing/Charging/Faulted), StartTransaction, MeterValues automático (cada 3s), StopTransaction, recepción de RemoteStart/RemoteStop/Reset desde CSMS
- ✅ `csms.html` — monitor Central System: recepción en tiempo real, gráfica de potencia (canvas), costo estimado en COP ($1.200/kWh hardcoded), envío de comandos remotos
- ✅ Identidad visual IIT aplicada (cyan `#00d4ff`, verde `#10b981`, púrpura `#7c3aed`, Syne + Space Mono)
- ⬜ Sin persistencia — todo el estado vive en memoria del navegador, se pierde al recargar
- ✅ `server/csms-server.js` — CSMS OCPP 1.6J mínimo por WebSocket para conectar el cargador real en LAN; registra el tráfico en JSONL
- ✅ `server/panel.html` — panel web servido por el CSMS: los 24 comandos CSMS→CP de OCPP 1.6J, respuestas y matriz de compatibilidad exportable
- ✅ `server/sim-cargador.js` — cargador simulado por WebSocket (perfil EU-30KW) para probar el panel sin hardware
- ⬜ `cargador.html`/`csms.html` siguen usando `BroadcastChannel` (solo entre pestañas del mismo navegador)

## Decisiones técnicas clave

**¿Por qué BroadcastChannel y no WebSocket en esta fase?**
Para validar la lógica de estados y el formato de mensajes OCPP sin levantar infraestructura. Cero servidor, cero Node.js, cero conexión a internet — abrir dos archivos HTML basta. El formato de cada mensaje (`{from, chargePointId, action, payload, msgId, frame, timestamp}` y el frame OCPP real `[2, msgId, action, payload]`) es deliberadamente idéntico al que usará el WebSocket real, para que portar a producción sea solo cambiar el transporte, no la lógica.

**¿Por qué no Tuya Smart / plataformas IoT genéricas?**
Decisión ya tomada: MubOn y el mercado EV usan OCPP 1.6 como protocolo estándar abierto, no plataformas propietarias tipo Tuya. OCPP da interoperabilidad real con cualquier CSMS o cargador de terceros — importante si IIT eventualmente gestiona cargadores de otras marcas además de los propios.

## Próximos pasos (orden sugerido)

1. **Conectar el cargador real** al CSMS de `server/` por IP fija en la LAN y capturar el tráfico (GetConfiguration completo, measurands que envía, formato del chargePointId).
2. **Portar los handlers** al módulo `ocpp-gateway` de Electrolineras (NestJS + PostgreSQL), con sesiones y CDR persistidos.
3. **Autorización y tarifa por operador**, energía facturada como `meterStop − meterStart`.
4. **Cobro y dispersión** con Wompi.
5. **TLS (`wss://`)** y conectividad 4G para operación en campo.

## Convenciones de este repo

Siguiendo el workflow de trazabilidad usado en otros proyectos IIT (`iit-ordenes-servicio-v2`):
- Issue en GitHub → fix → commit con `closes #N` → actualizar este `CLAUDE.md`
- Sin `node_modules` ni `server/logs/` versionados
- Commits descriptivos en español, cuerpo del commit explica el "por qué" no solo el "qué"

## Referencias cruzadas

- Electrolineras — backend NestJS (`ocpp-gateway`, `sesiones`, `facturacion`), destino de integración del CSMS real
- `Manual_Cargador_DC30kW_Completo_ES.docx` — manual en español del cargador con notas de instalación de IIT

---
**Infraestructura-IT (IIT)** · Construye. Conecta. Evoluciona.
