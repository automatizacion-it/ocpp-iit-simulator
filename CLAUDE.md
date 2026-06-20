# CLAUDE.md — ocpp-iit-simulator

Contexto del proyecto para sesiones futuras de Claude (o de cualquier desarrollador) trabajando en este repo.

## Qué es esto

Simulador de protocolo **OCPP 1.6J** para validar el flujo de mensajes del ecosistema de cargadores **IIT** (Infraestructura-IT) antes de tocar hardware real (ESP32-S3) o levantar un servidor CSMS en producción.

Dos páginas HTML estáticas, sin backend, sin dependencias, comunicadas vía `BroadcastChannel` del navegador.

## Por qué existe

Parte de la decisión de construir un **PaaS vertical EV** propio para IIT — fabricación de cargadores propios + CSMS propio en Node.js (extensión de `relay.js`) + app móvil, en lugar de depender de plataformas de terceros (Tuya Smart, MubOn, etc). Ver contexto de negocio: mercado colombiano de carga EV (MubOn, Evsy, Ergenia), comparación de costos hardware ($250-320 USD BOM propio vs $1.400 USD marcas premium importadas), y arquitectura completa documentada en sesiones previas de Claude (no versionadas en este repo).

## Estado actual

- ✅ `cargador.html` — simulador Charge Point: BootNotification, Authorize, StatusNotification (Preparing/Charging/Faulted), StartTransaction, MeterValues automático (cada 3s), StopTransaction, recepción de RemoteStart/RemoteStop/Reset desde CSMS
- ✅ `csms.html` — monitor Central System: recepción en tiempo real, gráfica de potencia (canvas), costo estimado en COP ($1.200/kWh hardcoded), envío de comandos remotos
- ✅ Identidad visual IIT aplicada (cyan `#00d4ff`, verde `#10b981`, púrpura `#7c3aed`, Syne + Space Mono)
- ⬜ Sin persistencia — todo el estado vive en memoria del navegador, se pierde al recargar
- ⬜ Sin servidor — `BroadcastChannel` solo funciona entre pestañas del mismo navegador, mismo origen `file://`

## Decisiones técnicas clave

**¿Por qué BroadcastChannel y no WebSocket en esta fase?**
Para validar la lógica de estados y el formato de mensajes OCPP sin levantar infraestructura. Cero servidor, cero Node.js, cero conexión a internet — abrir dos archivos HTML basta. El formato de cada mensaje (`{from, chargePointId, action, payload, msgId, frame, timestamp}` y el frame OCPP real `[2, msgId, action, payload]`) es deliberadamente idéntico al que usará el WebSocket real, para que portar a producción sea solo cambiar el transporte, no la lógica.

**¿Por qué no Tuya Smart / plataformas IoT genéricas?**
Decisión ya tomada: MubOn y el mercado EV usan OCPP 1.6 como protocolo estándar abierto, no plataformas propietarias tipo Tuya. OCPP da interoperabilidad real con cualquier CSMS o cargador de terceros — importante si IIT eventualmente gestiona cargadores de otras marcas además de los propios.

## Próximos pasos (orden sugerido)

1. **Fase 2 — CSMS real en Node.js**: reemplazar `BroadcastChannel` por servidor `ws` (WebSocket), extendiendo `relay.js` con handlers OCPP (`BootNotification`, `Authorize`, `StartTransaction`, `MeterValues`, `StopTransaction`) — ver estructura ya diseñada (router.js + handlers/ + Supabase).
2. **Fase 3 — Firmware ESP32-S3**: cliente WebSocket OCPP 1.6J sobre WiFi nativo del ESP32-S3 (sin módulo 4G en esta fase — ver decisión de conectividad: WiFi para prototipo/residencial, Ethernet W5500 para conjuntos/comercios, 4G EC21-G solo para producción outdoor).
3. **Fase 4 — Persistencia**: sesiones y CDR (Charge Data Record) en Supabase, igual patrón que `iit-ordenes-servicio-v2`.
4. **Fase 5 — Facturación**: integración con MATIAS API (DIAN) ya construida en `iit-facturacion`, para generar factura electrónica por sesión de carga.
5. **Fase 6 — Hardware**: PCB propio con ESP32-S3-N16R8, RCD Tipo B 30mA (Schneider A9R81240, no el A9R35240 que es 300mA Tipo A — descartado), contactor 32A, medidor PZEM-004T, conector J1772.

## Convenciones de este repo

Siguiendo el workflow de trazabilidad usado en otros proyectos IIT (`iit-ordenes-servicio-v2`):
- Issue en GitHub → fix → commit con `closes #N` → actualizar este `CLAUDE.md`
- Sin `node_modules` versionado (no aplica aún, no hay dependencias)
- Commits descriptivos en español, cuerpo del commit explica el "por qué" no solo el "qué"

## Referencias cruzadas (otros repos IIT relevantes)

- `relay.js` — WebSocket broker central, target de integración para el CSMS real
- `iit-facturacion` — microservicio MATIAS API / DIAN para la facturación de sesiones
- `iit-ordenes-servicio-v2` — patrón de referencia para trazabilidad de issues y estructura Supabase
- ESP32_GPIO_PRO_S3V5 — firmware base de referencia para el patrón de chunking PROGMEM si el cargador IIT termina con interfaz web embebida

---
**Infraestructura-IT (IIT)** · Construye. Conecta. Evoluciona.
