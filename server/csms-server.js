// CSMS OCPP 1.6J mínimo para pruebas en LAN con el cargador DC 30 kW (MDXDC3001).
// Responde a los mensajes del cargador (CALLRESULT) y registra todo el tráfico
// en consola y en logs/ocpp-<fecha>.jsonl para estudiar qué envía el equipo real.
//
// Uso:  npm install  &&  npm start            (puerto 9000 por defecto)
//       PORT=8180 npm start                     (otro puerto)
// En el cargador:  domain_master = ws://<IP-de-este-PC>:9000/ocpp
//
// Comandos por consola (con un cargador conectado):
//   start [idTag]   RemoteStartTransaction
//   stop [txId]     RemoteStopTransaction (por defecto la transacción activa)
//   reset [Soft|Hard]
//   config [clave]  GetConfiguration (sin clave = todas)
//   set <clave> <valor>   ChangeConfiguration
//   trigger <Mensaje>     TriggerMessage (BootNotification, StatusNotification, MeterValues, Heartbeat)
//   list            cargadores conectados

const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');

const PORT = parseInt(process.env.PORT || '9000', 10);
const HEARTBEAT_S = 60;

const logDir = path.join(__dirname, 'logs');
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, `ocpp-${new Date().toISOString().slice(0, 10)}.jsonl`);
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

const chargers = new Map();          // chargePointId -> { ws, activeTx }
const pending = new Map();           // uniqueId -> { cpId, action }
const sessions = new Map();          // transactionId -> { cpId, idTag, meterStart, start }
let nextTxId = 1;

const now = () => new Date().toISOString();
const t = () => new Date().toLocaleTimeString('es-CO', { hour12: false });

function record(cpId, dir, frame) {
  logStream.write(JSON.stringify({ ts: now(), cpId, dir, frame }) + '\n');
  const arrow = dir === 'in' ? '← CP→CSMS' : '→ CSMS→CP';
  console.log(`${t()} [${cpId}] ${arrow} ${JSON.stringify(frame)}`);
}

function send(cpId, frame) {
  const c = chargers.get(cpId);
  if (!c) return console.log(`No hay cargador conectado con id ${cpId}`);
  c.ws.send(JSON.stringify(frame));
  record(cpId, 'out', frame);
}

function call(cpId, action, payload) {
  const id = `csms-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  pending.set(id, { cpId, action });
  send(cpId, [2, id, action, payload]);
}

// ── Respuestas a las solicitudes del cargador ──
const handlers = {
  BootNotification: (cpId, p) => {
    console.log(`   ↳ ${p.chargePointVendor} ${p.chargePointModel} · SN ${p.chargePointSerialNumber || p.chargeBoxSerialNumber || '?'} · FW ${p.firmwareVersion || '?'}`);
    return { status: 'Accepted', currentTime: now(), interval: HEARTBEAT_S };
  },
  Heartbeat: () => ({ currentTime: now() }),
  StatusNotification: (cpId, p) => {
    console.log(`   ↳ conector ${p.connectorId}: ${p.status}${p.errorCode && p.errorCode !== 'NoError' ? ' · ' + p.errorCode : ''}`);
    return {};
  },
  // Modo prueba: acepta cualquier tarjeta. En producción esto consulta la BD de Electrolineras.
  Authorize: () => ({ idTagInfo: { status: 'Accepted' } }),
  StartTransaction: (cpId, p) => {
    const transactionId = nextTxId++;
    sessions.set(transactionId, { cpId, idTag: p.idTag, meterStart: p.meterStart, start: p.timestamp });
    chargers.get(cpId).activeTx = transactionId;
    console.log(`   ↳ sesión ${transactionId} · idTag ${p.idTag} · meterStart ${p.meterStart} Wh`);
    return { transactionId, idTagInfo: { status: 'Accepted' } };
  },
  MeterValues: (cpId, p) => {
    for (const mv of p.meterValue || []) {
      const resumen = (mv.sampledValue || [])
        .map(s => `${s.measurand || 'Energy.Active.Import.Register'}${s.phase ? '(' + s.phase + ')' : ''}=${s.value}${s.unit ? ' ' + s.unit : ''}`)
        .join(' | ');
      console.log(`   ↳ ${resumen}`);
    }
    return {};
  },
  StopTransaction: (cpId, p) => {
    const s = sessions.get(p.transactionId);
    if (s) {
      const kwh = (p.meterStop - s.meterStart) / 1000;
      console.log(`   ↳ sesión ${p.transactionId} cerrada · ${kwh.toFixed(3)} kWh · motivo ${p.reason || 'Local'}`);
    } else {
      console.log(`   ↳ StopTransaction de una sesión desconocida (${p.transactionId})`);
    }
    const c = chargers.get(cpId);
    if (c && c.activeTx === p.transactionId) c.activeTx = null;
    return { idTagInfo: { status: 'Accepted' } };
  },
  DataTransfer: (cpId, p) => {
    console.log(`   ↳ DataTransfer vendorId=${p.vendorId} messageId=${p.messageId || ''}`);
    return { status: 'Accepted' };
  },
  FirmwareStatusNotification: () => ({}),
  DiagnosticsStatusNotification: () => ({}),
};

// ── Servidor ──
const wss = new WebSocketServer({
  port: PORT,
  handleProtocols: (protocols) => (protocols.has('ocpp1.6') ? 'ocpp1.6' : false),
});

wss.on('connection', (ws, req) => {
  // El cargador suele agregar su identificador al final de la URL: /ocpp/<pile_number>
  const segments = (req.url || '/').split('?')[0].split('/').filter(Boolean);
  const cpId = decodeURIComponent(segments[segments.length - 1] || 'SIN-ID');
  chargers.set(cpId, { ws, activeTx: null });
  console.log(`\n${t()} ✔ Conectado ${cpId} desde ${req.socket.remoteAddress} · URL ${req.url} · subprotocolo ${ws.protocol || '(ninguno)'}`);
  if (req.headers.authorization) console.log('   ↳ el cargador envía autenticación Basic (pile_password)');

  ws.on('message', (data) => {
    let frame;
    try { frame = JSON.parse(data.toString()); } catch { return console.log(`Mensaje no JSON de ${cpId}: ${data}`); }
    record(cpId, 'in', frame);
    const [type, id] = frame;

    if (type === 2) {
      const [, , action, payload] = frame;
      const h = handlers[action];
      if (h) send(cpId, [3, id, h(cpId, payload || {})]);
      else send(cpId, [4, id, 'NotImplemented', `Acción ${action} no soportada por este CSMS de pruebas`, {}]);
    } else if (type === 3 || type === 4) {
      const req0 = pending.get(id);
      pending.delete(id);
      if (req0 && req0.action === 'GetConfiguration' && type === 3) {
        for (const k of frame[2].configurationKey || []) console.log(`   ${k.readonly ? '🔒' : '  '} ${k.key} = ${k.value}`);
        if ((frame[2].unknownKey || []).length) console.log(`   claves desconocidas: ${frame[2].unknownKey.join(', ')}`);
      }
    }
  });

  ws.on('close', (code) => {
    console.log(`${t()} ✖ Desconectado ${cpId} (código ${code})`);
    if (chargers.get(cpId)?.ws === ws) chargers.delete(cpId);
  });
});

wss.on('error', (e) => { console.error('Error del servidor:', e.message); process.exit(1); });

// ── Consola ──
function defaultCp() {
  const ids = [...chargers.keys()];
  if (ids.length === 0) { console.log('No hay cargadores conectados.'); return null; }
  return ids[0];
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const [cmd, ...args] = line.trim().split(/\s+/);
  if (!cmd) return;
  if (cmd === 'list') return console.log([...chargers.entries()].map(([id, c]) => `${id} (tx activa: ${c.activeTx ?? '—'})`).join('\n') || 'Ninguno');
  const cp = defaultCp(); if (!cp) return;
  switch (cmd) {
    case 'start':   return call(cp, 'RemoteStartTransaction', { connectorId: 1, idTag: args[0] || 'IIT-REMOTE' });
    case 'stop': {
      const tx = args[0] ? parseInt(args[0], 10) : chargers.get(cp).activeTx;
      if (tx == null) return console.log('No hay transacción activa; indica el id: stop <txId>');
      return call(cp, 'RemoteStopTransaction', { transactionId: tx });
    }
    case 'reset':   return call(cp, 'Reset', { type: args[0] === 'Hard' ? 'Hard' : 'Soft' });
    case 'config':  return call(cp, 'GetConfiguration', args[0] ? { key: [args[0]] } : {});
    case 'set':     return call(cp, 'ChangeConfiguration', { key: args[0], value: args.slice(1).join(' ') });
    case 'trigger': return call(cp, 'TriggerMessage', { requestedMessage: args[0] || 'StatusNotification', connectorId: 1 });
    default: console.log('Comandos: start, stop, reset, config, set, trigger, list');
  }
});

const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
console.log(`CSMS OCPP 1.6J escuchando en el puerto ${PORT}`);
console.log(`Configura en el cargador → domain_master: ${ips.map(ip => `ws://${ip}:${PORT}/ocpp`).join('  o  ') || `ws://<IP-de-este-PC>:${PORT}/ocpp`}`);
console.log(`Registro de tráfico: ${logFile}\n`);
