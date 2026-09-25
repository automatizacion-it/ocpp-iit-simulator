// Cargador simulado (DC 30 kW, EU-30KW) que se conecta al CSMS por WebSocket.
// Simula una carga DC CCS2 realista: la tensión de la batería sube con el SoC, la corriente
// queda limitada por el vehículo y por los 30 kW del cargador, y por encima del 80 % de SoC
// la corriente baja gradualmente (fase de tensión constante), como en un vehículo real.
//
// Uso:  npm run sim
//   Variables opcionales:
//     CSMS_URL=ws://192.168.1.2:9000/ocpp   servidor CSMS
//     SIM_SPEED=20      aceleración del tiempo (20 = una carga de 1 h 40 min dura 5 min)
//     BATERIA_KWH=60    capacidad de la batería del vehículo
//     SOC_INICIAL=20    SoC al iniciar cada carga (%)
//     SOC_FINAL=95      SoC al que el vehículo termina la carga (%)
//     CORRIENTE_VE=70   corriente máxima que pide el vehículo (A)

const WebSocket = require('ws');
const BASE = process.env.CSMS_URL || 'ws://127.0.0.1:9000/ocpp';
const ID = process.env.CP_ID || 'SIM-EU30KW';
const SPEED = parseFloat(process.env.SIM_SPEED || '20');
const BATERIA_WH = parseFloat(process.env.BATERIA_KWH || '60') * 1000;
const SOC_INICIAL = parseFloat(process.env.SOC_INICIAL || '20');
const SOC_FINAL = parseFloat(process.env.SOC_FINAL || '95');
const I_VE = parseFloat(process.env.CORRIENTE_VE || '70');

// Límites del cargador EU-30KW (manual): 30 kW, 0–100 A, 200–1000 VDC
const P_MAX = 30000, I_MAX = 100;
const MUESTRA_S = 3;            // cada cuántos segundos reales se envía MeterValues
const R_INTERNA = 0.09;         // Ω, resistencia interna de la batería

let n = 0, txId = null, status = 'Available', meterTimer = null;
let registroWh = 1523400;       // contador de energía acumulado del cargador (no se reinicia)
let soc = SOC_INICIAL, ultima = { v: 0, a: 0, w: 0 };
let reloj = Date.now();         // reloj simulado (avanza SPEED veces más rápido durante la carga)
const ts = () => new Date(reloj).toISOString();

const ws = new WebSocket(`${BASE}/${ID}`, 'ocpp1.6');
const waiting = new Map();

function callCsms(action, payload) {
  const id = `sim-${++n}`;
  ws.send(JSON.stringify([2, id, action, payload]));
  return new Promise(res => waiting.set(id, res));
}
const reply = (id, payload) => ws.send(JSON.stringify([3, id, payload]));
const replyErr = (id, code, desc) => ws.send(JSON.stringify([4, id, code, desc, {}]));
const setStatus = (s) => { status = s; return callCsms('StatusNotification', { connectorId: 1, status: s, errorCode: 'NoError', timestamp: ts() }); };
const ruido = (amp) => (Math.random() * 2 - 1) * amp;

// ── Modelo de la batería y del cargador ──
function tensionBateria(s, corriente) {
  const x = s / 100;
  // Tensión en circuito abierto de un paquete NMC de ~400 V: sube rápido al inicio, luego casi lineal
  const voc = 330 + 78 * x + 14 * (1 - Math.exp(-6 * x));
  return voc + corriente * R_INTERNA;
}
function corrienteSolicitada(s) {
  // Hasta 80 % el vehículo pide su corriente máxima; después baja hasta ~6 A al 100 %
  if (s <= 80) return I_VE;
  const f = Math.max(0, (100 - s) / 20);
  return Math.max(6, I_VE * Math.pow(f, 1.3));
}
function paso(dtS) {
  let i = Math.min(corrienteSolicitada(soc), I_MAX);
  let v = tensionBateria(soc, i);
  if (v * i > P_MAX) { i = P_MAX / v; v = tensionBateria(soc, i); }   // límite de potencia del cargador
  i = Math.max(0, i + ruido(0.6));
  v = v + ruido(0.4);
  const w = v * i;
  const wh = w * dtS / 3600;
  registroWh += wh;
  soc = Math.min(100, soc + (wh * 0.95) / BATERIA_WH * 100);  // 95 % llega a la batería
  ultima = { v, a: i, w };
}

function meterValues() {
  const enCarga = !!txId;
  const { v, a, w } = enCarga ? ultima : { v: 0, a: 0, w: 0 };
  const sv = [
    { value: registroWh.toFixed(0), context: 'Sample.Periodic', measurand: 'Energy.Active.Import.Register', unit: 'Wh' },
    { value: w.toFixed(0), context: 'Sample.Periodic', measurand: 'Power.Active.Import', unit: 'W' },
    { value: v.toFixed(1), context: 'Sample.Periodic', measurand: 'Voltage', unit: 'V' },
    { value: a.toFixed(1), context: 'Sample.Periodic', measurand: 'Current.Import', unit: 'A' },
  ];
  if (enCarga) sv.push({ value: soc.toFixed(0), context: 'Sample.Periodic', measurand: 'SoC', location: 'EV', unit: 'Percent' });
  const payload = { connectorId: 1, meterValue: [{ timestamp: ts(), sampledValue: sv }] };
  if (enCarga) payload.transactionId = txId;
  return callCsms('MeterValues', payload);
}

function tick() {
  const dt = MUESTRA_S * SPEED;
  reloj += dt * 1000;
  paso(dt);
  meterValues();
  if (soc >= SOC_FINAL) {
    console.log(`SoC ${soc.toFixed(1)} % alcanzado: el vehículo termina la carga`);
    stopTx('Other');
  }
}

async function startTx(idTag) {
  soc = SOC_INICIAL;
  reloj = Math.max(reloj, Date.now());
  await setStatus('Preparing');
  const r = await callCsms('StartTransaction', { connectorId: 1, idTag, meterStart: Math.round(registroWh), timestamp: ts() });
  txId = r.transactionId;
  await setStatus('Charging');
  console.log(`Carga iniciada · transacción ${txId} · SoC ${soc} % → ${SOC_FINAL} % · tiempo x${SPEED}`);
  paso(0.001);
  meterValues();
  meterTimer = setInterval(tick, MUESTRA_S * 1000);
}
async function stopTx(reason) {
  if (!txId) return;
  clearInterval(meterTimer); meterTimer = null;
  const id = txId; txId = null;
  await callCsms('StopTransaction', { transactionId: id, meterStop: Math.round(registroWh), timestamp: ts(), reason });
  console.log(`Carga detenida · transacción ${id} · motivo ${reason}`);
  await setStatus('Finishing'); await setStatus('Available');
}

const config = [
  { key: 'HeartbeatInterval', readonly: false, value: '60' },
  { key: 'MeterValueSampleInterval', readonly: false, value: String(MUESTRA_S) },
  { key: 'MeterValuesSampledData', readonly: false, value: 'Energy.Active.Import.Register,Power.Active.Import,Voltage,Current.Import,SoC' },
  { key: 'NumberOfConnectors', readonly: true, value: '1' },
  { key: 'AuthorizeRemoteTxRequests', readonly: false, value: 'false' },
  { key: 'LocalAuthListEnabled', readonly: false, value: 'true' },
  { key: 'SupportedFeatureProfiles', readonly: true, value: 'Core,FirmwareManagement,LocalAuthListManagement,RemoteTrigger' },
];

const boot = { chargePointVendor: 'SSWL', chargePointModel: 'EU-30KW', chargePointSerialNumber: ID, firmwareVersion: 'SSWL_DC-V1.0.69 (simulado)' };

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
  ChangeAvailability: () => ({ status: txId ? 'Scheduled' : 'Accepted' }),
  ClearCache: () => ({ status: 'Accepted' }),
  DataTransfer: (p) => ({ status: p.vendorId === 'SSWL' ? 'Accepted' : 'UnknownVendorId' }),
  Reset: () => { setTimeout(() => { console.log('Reset: cerrando conexión'); ws.close(1000); }, 500); return { status: 'Accepted' }; },
  GetDiagnostics: () => { setTimeout(() => callCsms('DiagnosticsStatusNotification', { status: 'UploadFailed' }), 1500); return { fileName: 'diag-EU30KW.log' }; },
  UpdateFirmware: () => { setTimeout(() => callCsms('FirmwareStatusNotification', { status: 'DownloadFailed' }), 1500); return {}; },
  GetLocalListVersion: () => ({ listVersion: 0 }),
  SendLocalList: () => ({ status: 'Accepted' }),
  TriggerMessage: (p) => {
    const act = {
      BootNotification: () => callCsms('BootNotification', boot),
      Heartbeat: () => callCsms('Heartbeat', {}),
      StatusNotification: () => setStatus(status),
      MeterValues: () => meterValues(),
      DiagnosticsStatusNotification: () => callCsms('DiagnosticsStatusNotification', { status: 'Idle' }),
      FirmwareStatusNotification: () => callCsms('FirmwareStatusNotification', { status: 'Idle' }),
    }[p.requestedMessage];
    if (!act) return { status: 'NotImplemented' };
    setTimeout(act, 200); return { status: 'Accepted' };
  },
  // Reservas y carga inteligente: el simulador los declara no soportados a propósito
  ReserveNow: 'NotSupported', CancelReservation: 'NotSupported',
  SetChargingProfile: 'NotSupported', GetCompositeSchedule: 'NotSupported', ClearChargingProfile: 'NotSupported',
};

ws.on('open', async () => {
  console.log(`Simulador conectado a ${BASE}/${ID}`);
  console.log(`Vehículo: batería ${BATERIA_WH / 1000} kWh · SoC ${SOC_INICIAL} % → ${SOC_FINAL} % · pide ${I_VE} A · tiempo x${SPEED}`);
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
