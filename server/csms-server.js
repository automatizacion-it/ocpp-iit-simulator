// CSMS OCPP 1.6J para pruebas en LAN con el cargador DC 30 kW (MDXDC3001).
//  - Responde a los mensajes del cargador (CALLRESULT) y registra todo en logs/ocpp-<fecha>.jsonl
//  - Sirve un panel web en http://<IP>:<PUERTO>/ para enviar todos los comandos OCPP 1.6J y ver sus respuestas
//
// Uso:  npm install  &&  npm start          (puerto 9000; PORT=8180 npm start para otro)
// Cargador:  domain_master = ws://<IP-de-este-PC>:9000/ocpp
// Panel:     http://<IP-de-este-PC>:9000/
//
// Comandos por consola: start [idTag] · stop [txId] · reset [Soft|Hard] · config [clave]
//                       set <clave> <valor> · trigger <Mensaje> · list

const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');

const PORT = parseInt(process.env.PORT || '9000', 10);
const HEARTBEAT_S = 60;
const CALL_TIMEOUT_MS = 30000;

const logDir = path.join(__dirname, 'logs');
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, `ocpp-${new Date().toISOString().slice(0, 10)}.jsonl`);
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

const chargers = new Map();   // cpId -> { ws, ip, url, activeTx, boot, connectedAt }
const pending = new Map();    // uniqueId -> { cpId, action, sentAt, timer }
const sessions = new Map();   // transactionId -> { cpId, idTag, meterStart, start }
const monitors = new Set();   // WebSockets del panel web
const recent = [];            // últimos mensajes OCPP, para que el panel recupere la sesión al recargar
const RECENT_MAX = 4000;
let nextTxId = 1;

const now = () => new Date().toISOString();
const t = () => new Date().toLocaleTimeString('es-CO', { hour12: false });

// ── Panel web: difusión de eventos ──
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const m of monitors) if (m.readyState === 1) m.send(data);
}
function chargerList() {
  return [...chargers.entries()].map(([id, c]) => ({
    id, ip: c.ip, url: c.url, activeTx: c.activeTx, boot: c.boot, connectedAt: c.connectedAt,
  }));
}
const pushChargers = () => broadcast({ type: 'chargers', list: chargerList() });

function record(cpId, dir, frame) {
  const ts = now();
  logStream.write(JSON.stringify({ ts, cpId, dir, frame }) + '\n');
  const msg = { type: 'frame', ts, cpId, dir, frame };
  recent.push(msg);
  if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
  broadcast(msg);
  const arrow = dir === 'in' ? '← CP→CSMS' : '→ CSMS→CP';
  console.log(`${t()} [${cpId}] ${arrow} ${JSON.stringify(frame)}`);
}

function send(cpId, frame) {
  const c = chargers.get(cpId);
  if (!c) { console.log(`No hay cargador conectado con id ${cpId}`); return false; }
  c.ws.send(JSON.stringify(frame));
  record(cpId, 'out', frame);
  return true;
}

function call(cpId, action, payload) {
  const id = `csms-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  if (!chargers.has(cpId)) {
    broadcast({ type: 'result', id, cpId, action, kind: 'error', error: 'NoConectado', description: 'El cargador no está conectado', ms: 0 });
    return null;
  }
  const timer = setTimeout(() => {
    if (!pending.has(id)) return;
    pending.delete(id);
    console.log(`   ↳ ${action}: sin respuesta en ${CALL_TIMEOUT_MS / 1000} s`);
    broadcast({ type: 'result', id, cpId, action, kind: 'timeout', ms: CALL_TIMEOUT_MS });
  }, CALL_TIMEOUT_MS);
  pending.set(id, { cpId, action, sentAt: Date.now(), timer });
  send(cpId, [2, id, action, payload]);
  broadcast({ type: 'sent', id, cpId, action, payload });
  return id;
}

// ── Respuestas a las solicitudes del cargador ──
const handlers = {
  BootNotification: (cpId, p) => {
    chargers.get(cpId).boot = p;
    pushChargers();
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
    pushChargers();
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
    if (s) console.log(`   ↳ sesión ${p.transactionId} cerrada · ${((p.meterStop - s.meterStart) / 1000).toFixed(3)} kWh · motivo ${p.reason || 'Local'}`);
    else console.log(`   ↳ StopTransaction de una sesión desconocida (${p.transactionId})`);
    const c = chargers.get(cpId);
    if (c && c.activeTx === p.transactionId) { c.activeTx = null; pushChargers(); }
    return { idTagInfo: { status: 'Accepted' } };
  },
  DataTransfer: (cpId, p) => {
    console.log(`   ↳ DataTransfer vendorId=${p.vendorId} messageId=${p.messageId || ''}`);
    return { status: 'Accepted' };
  },
  FirmwareStatusNotification: () => ({}),
  DiagnosticsStatusNotification: () => ({}),
};

// ── Servidor HTTP (panel) + WebSocket (cargadores y panel) ──
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'GET' && (url === '/' || url === '/panel' || url === '/panel.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(path.join(__dirname, 'panel.html')).pipe(res);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('No encontrado. Panel en /  ·  cargadores en ws://<IP>:' + PORT + '/ocpp/<id>');
});

const wss = new WebSocketServer({
  server,
  handleProtocols: (protocols) => (protocols.has('ocpp1.6') ? 'ocpp1.6' : false),
});

wss.on('connection', (ws, req) => {
  const urlPath = (req.url || '/').split('?')[0];

  // Panel web
  if (urlPath === '/monitor') {
    monitors.add(ws);
    ws.send(JSON.stringify({ type: 'hello', port: PORT, chargers: chargerList(), recent }));
    ws.on('message', (data) => {
      let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'call' && msg.cpId && msg.action) {
        const id = call(msg.cpId, msg.action, msg.payload || {});
        if (id && msg.ref) ws.send(JSON.stringify({ type: 'ack', ref: msg.ref, id }));
      }
    });
    ws.on('close', () => monitors.delete(ws));
    return;
  }

  // Cargador: suele agregar su identificador al final de la URL (/ocpp/<pile_number>)
  const segments = urlPath.split('/').filter(Boolean);
  const cpId = decodeURIComponent(segments[segments.length - 1] || 'SIN-ID');
  const ip = (req.socket.remoteAddress || '').replace('::ffff:', '');
  chargers.set(cpId, { ws, ip, url: req.url, activeTx: null, boot: null, connectedAt: now() });
  console.log(`\n${t()} ✔ Conectado ${cpId} desde ${ip} · URL ${req.url} · subprotocolo ${ws.protocol || '(ninguno)'}`);
  if (req.headers.authorization) console.log('   ↳ el cargador envía autenticación Basic (pile_password)');
  broadcast({ type: 'connected', cpId, ip, url: req.url, protocol: ws.protocol || null, ts: now() });
  pushChargers();

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
      const p = pending.get(id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(id);
      const ms = Date.now() - p.sentAt;
      if (type === 3) {
        if (p.action === 'GetConfiguration') {
          for (const k of frame[2].configurationKey || []) console.log(`   ${k.readonly ? '🔒' : '  '} ${k.key} = ${k.value}`);
          if ((frame[2].unknownKey || []).length) console.log(`   claves desconocidas: ${frame[2].unknownKey.join(', ')}`);
        }
        broadcast({ type: 'result', id, cpId, action: p.action, kind: 'result', payload: frame[2], ms });
      } else {
        broadcast({ type: 'result', id, cpId, action: p.action, kind: 'error', error: frame[2], description: frame[3], details: frame[4], ms });
      }
    }
  });

  ws.on('close', (code) => {
    console.log(`${t()} ✖ Desconectado ${cpId} (código ${code})`);
    if (chargers.get(cpId)?.ws === ws) chargers.delete(cpId);
    broadcast({ type: 'disconnected', cpId, code, ts: now() });
    pushChargers();
  });
});

server.on('error', (e) => { console.error('Error del servidor:', e.message); process.exit(1); });

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
  if (cmd === 'list') return console.log(chargerList().map(c => `${c.id} (${c.ip}, tx activa: ${c.activeTx ?? '—'})`).join('\n') || 'Ninguno');
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
    default: console.log('Comandos: start, stop, reset, config, set, trigger, list  ·  o usa el panel web');
  }
});

server.listen(PORT, () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log(`CSMS OCPP 1.6J escuchando en el puerto ${PORT}`);
  console.log(`Configura en el cargador → domain_master: ${ips.map(ip => `ws://${ip}:${PORT}/ocpp`).join('  o  ') || `ws://<IP-de-este-PC>:${PORT}/ocpp`}`);
  console.log(`Panel de pruebas: ${ips.map(ip => `http://${ip}:${PORT}/`).join('  o  ')}`);
  console.log(`Registro de tráfico: ${logFile}\n`);
});
