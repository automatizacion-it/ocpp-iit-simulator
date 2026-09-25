// Cargador simulado (perfil DC 30 kW, EU-30KW) que se conecta al CSMS por WebSocket.
// Sirve para probar el panel sin el equipo real. Responde a todos los comandos OCPP 1.6J;
// algunos contestan NotSupported a propósito para ver cómo se ve en la matriz.
//
// Uso:  npm run sim                           (se conecta a ws://127.0.0.1:9000/ocpp/SIM-EU30KW)
//       CSMS_URL=ws://192.168.1.2:9000/ocpp npm run sim

const WebSocket = require('ws');
const BASE = process.env.CSMS_URL || 'ws://127.0.0.1:9000/ocpp';
const ID = process.env.CP_ID || 'SIM-EU30KW';

let n = 0, txId = null, meterWh = 1523400, soc = 35, meterTimer = null, status = 'Available';
const ws = new WebSocket(`${BASE}/${ID}`, 'ocpp1.6');
const waiting = new Map();

function callCsms(action, payload) {
  const id = `sim-${++n}`;
  ws.send(JSON.stringify([2, id, action, payload]));
  return new Promise(res => waiting.set(id, res));
}
const reply = (id, payload) => ws.send(JSON.stringify([3, id, payload]));
const replyErr = (id, code, desc) => ws.send(JSON.stringify([4, id, code, desc, {}]));
const setStatus = (s) => { status = s; return callCsms('StatusNotification', { connectorId: 1, status: s, errorCode: 'NoError', timestamp: new Date().toISOString() }); };

function meterValues() {
  const v = 420 + Math.random() * 4, a = 50 + Math.random() * 15, w = v * a;
  meterWh += w * 5 / 3600; soc = Math.min(100, soc + 0.2);
  return callCsms('MeterValues', { connectorId: 1, transactionId: txId, meterValue: [{ timestamp: new Date().toISOString(), sampledValue: [
    { value: meterWh.toFixed(0), measurand: 'Energy.Active.Import.Register', unit: 'Wh' },
    { value: w.toFixed(0), measurand: 'Power.Active.Import', unit: 'W' },
    { value: v.toFixed(1), measurand: 'Voltage', unit: 'V' },
    { value: a.toFixed(1), measurand: 'Current.Import', unit: 'A' },
    { value: soc.toFixed(0), measurand: 'SoC', unit: 'Percent' } ] }] });
}

async function startTx(idTag) {
  await setStatus('Preparing');
  const r = await callCsms('StartTransaction', { connectorId: 1, idTag, meterStart: Math.round(meterWh), timestamp: new Date().toISOString() });
  txId = r.transactionId;
  await setStatus('Charging');
  meterTimer = setInterval(meterValues, 5000);
}
async function stopTx(reason) {
  clearInterval(meterTimer); meterTimer = null;
  await callCsms('StopTransaction', { transactionId: txId, meterStop: Math.round(meterWh), timestamp: new Date().toISOString(), reason });
  txId = null;
  await setStatus('Finishing'); await setStatus('Available');
}

const config = [
  { key: 'HeartbeatInterval', readonly: false, value: '60' },
  { key: 'MeterValueSampleInterval', readonly: false, value: '5' },
  { key: 'MeterValuesSampledData', readonly: false, value: 'Energy.Active.Import.Register,Power.Active.Import,Voltage,Current.Import,SoC' },
  { key: 'NumberOfConnectors', readonly: true, value: '1' },
  { key: 'AuthorizeRemoteTxRequests', readonly: false, value: 'false' },
  { key: 'LocalAuthListEnabled', readonly: false, value: 'true' },
  { key: 'SupportedFeatureProfiles', readonly: true, value: 'Core,FirmwareManagement,LocalAuthListManagement,RemoteTrigger' },
];

const commands = {
  GetConfiguration: (p) => {
    if (!p.key || !p.key.length) return { configurationKey: config };
    return { configurationKey: config.filter(k => p.key.includes(k.key)), unknownKey: p.key.filter(k => !config.find(c => c.key === k)) };
  },
  ChangeConfiguration: (p) => {
    const k = config.find(c => c.key === p.key);
    if (!k) return { status: 'NotSupported' };
    if (k.readonly) return { status: 'Rejected' };
    k.value = String(p.value); return { status: 'Accepted' };
  },
  RemoteStartTransaction: (p) => {
    if (txId || status !== 'Available') return { status: 'Rejected' };
    setTimeout(() => startTx(p.idTag), 300); return { status: 'Accepted' };
  },
  RemoteStopTransaction: (p) => {
    if (!txId || p.transactionId !== txId) return { status: 'Rejected' };
    setTimeout(() => stopTx('Remote'), 300); return { status: 'Accepted' };
  },
  UnlockConnector: () => ({ status: 'Unlocked' }),
  ChangeAvailability: (p) => ({ status: txId ? 'Scheduled' : 'Accepted' }),
  ClearCache: () => ({ status: 'Accepted' }),
  DataTransfer: (p) => ({ status: p.vendorId === 'SSWL' ? 'Accepted' : 'UnknownVendorId' }),
  Reset: (p) => { setTimeout(() => { console.log('Reset: cerrando conexión'); ws.close(1000); }, 500); return { status: 'Accepted' }; },
  GetDiagnostics: () => { setTimeout(() => callCsms('DiagnosticsStatusNotification', { status: 'UploadFailed' }), 1500); return { fileName: 'diag-EU30KW.log' }; },
  UpdateFirmware: () => { setTimeout(() => callCsms('FirmwareStatusNotification', { status: 'DownloadFailed' }), 1500); return {}; },
  GetLocalListVersion: () => ({ listVersion: 0 }),
  SendLocalList: () => ({ status: 'Accepted' }),
  TriggerMessage: (p) => {
    const m = p.requestedMessage;
    const act = {
      BootNotification: () => callCsms('BootNotification', boot),
      Heartbeat: () => callCsms('Heartbeat', {}),
      StatusNotification: () => setStatus(status),
      MeterValues: () => meterValues(),
      DiagnosticsStatusNotification: () => callCsms('DiagnosticsStatusNotification', { status: 'Idle' }),
      FirmwareStatusNotification: () => callCsms('FirmwareStatusNotification', { status: 'Idle' }),
    }[m];
    if (!act) return { status: 'NotImplemented' };
    setTimeout(act, 200); return { status: 'Accepted' };
  },
  // Reservas y carga inteligente: el simulador los declara no soportados a propósito
  ReserveNow: 'NotSupported', CancelReservation: 'NotSupported',
  SetChargingProfile: 'NotSupported', GetCompositeSchedule: 'NotSupported', ClearChargingProfile: 'NotSupported',
};

const boot = { chargePointVendor: 'SSWL', chargePointModel: 'EU-30KW', chargePointSerialNumber: ID, firmwareVersion: 'SSWL_DC-V1.0.69 (simulado)' };

ws.on('open', async () => {
  console.log(`Simulador conectado a ${BASE}/${ID}`);
  await callCsms('BootNotification', boot);
  await setStatus('Available');
  setInterval(() => callCsms('Heartbeat', {}), 60000);
});

ws.on('message', (data) => {
  const f = JSON.parse(data.toString());
  if (f[0] === 3 || f[0] === 4) { const r = waiting.get(f[1]); waiting.delete(f[1]); if (r) r(f[2]); return; }
  if (f[0] !== 2) return;
  const [, id, action, payload] = f;
  const h = commands[action];
  console.log(`← ${action} ${JSON.stringify(payload)}`);
  if (h === undefined) return replyErr(id, 'NotImplemented', `${action} no implementado`);
  if (h === 'NotSupported') return replyErr(id, 'NotSupported', `${action} no soportado por este cargador`);
  reply(id, h(payload || {}));
});

ws.on('close', () => { console.log('Conexión cerrada'); process.exit(0); });
ws.on('error', (e) => { console.error('No se pudo conectar:', e.message); process.exit(1); });
