// ===== IOSSCANNER — scanner.js =====
const VALUE_TYPE_OPTIONS = [
  {v:'TYPE_BIT',l:'Bit'},{v:'TYPE_BIT_REG',l:'Bit in Reg'},
  {v:'TYPE_U8',l:'U8'},{v:'TYPE_U16',l:'U16'},{v:'TYPE_I16',l:'I16'},
  {v:'TYPE_U32',l:'U32'},{v:'TYPE_I32',l:'I32'},{v:'TYPE_F32',l:'F32'},
];

let scModel = { scanners: [] };
let scEs = null;
let scPollTimer = null;
let scSseRetryTimer = null;
let scInited = false;
const scLiveEditState = {};
const scDetOpen = {};

function scApi(path) {
  const base = getDeviceUrl();
  return base ? base + '/Scanner' + path : null;
}

async function scFetch(path, method = 'GET', body = null) {
  const url = scApi(path);
  if (!url) return null;
  try {
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const txt = await r.text();
    try { return JSON.parse(txt); } catch { return { raw: txt, http: r.status }; }
  } catch { return null; }
}

function scSetStatus(status) {
  const el = document.getElementById('sc-live-dot');
  if (!el) return;
  el.className = 'dot ' + ({online:'dot-green',offline:'dot-grey',poll:'dot-orange'}[status] ?? 'dot-grey');
  el.title = {online:'SSE: Live',offline:'Offline',poll:'Polling'}[status] ?? status;
}

function scNormalize(data) {
  const raw = data?.scanners ?? [];
  const scanners = Array.isArray(raw) ? raw.map(z => {
    z.ios = z.ios ?? {};
    for (const t of ['IO_MODBUS','IO_I2C','IO_GPIO','IO_SHIFT'])
      if (!Array.isArray(z.ios[t])) z.ios[t] = [];
    return z;
  }) : [];
  return { scanners };
}

function scTypeLabel(t) { return {IO_MODBUS:'MODBUS',IO_I2C:'I2C',IO_GPIO:'GPIO',IO_SHIFT:'SHIFT'}[t] ?? t; }

function scToVtLabel(v) {
  if (typeof v === 'number') return VALUE_TYPE_OPTIONS[Math.max(0,Math.trunc(v))]?.v ?? 'TYPE_U8';
  const s = String(v ?? '');
  return VALUE_TYPE_OPTIONS.some(o => o.v === s) ? s : 'TYPE_U8';
}

function scNormShift(v) { const n=Number(v??0); return Number.isFinite(n)?(Math.trunc(n)>>>0)&0xFF:0; }
function scBitFromMask(mask) { const m=Number(mask??0); for(let b=0;b<32;b++){if(m&(1<<b))return b;} return 0; }
function scAsBitOnOff(v) { return (v===true||v===1||v==='1')?'ON':'OFF'; }
function scModbusWritable(fc) { return ![2,4].includes(Number(fc??3)); }

function scFormatVal(io, t) {
  if (t === 'IO_GPIO') return io.pinType === 'DIGITAL_PIN' ? scAsBitOnOff(io.value) : String(io.value ?? 0);
  if (t === 'IO_SHIFT') {
    const vt = scToVtLabel(io.valueType ?? 2);
    if (vt === 'TYPE_BIT') return scAsBitOnOff(io.value);
    if (vt === 'TYPE_BIT_REG') { const mask=scNormShift(io.bitMask??0); return 'B'+scBitFromMask(mask)+':'+((scNormShift(io.value??0)&mask)!==0?'ON':'OFF'); }
    return String(io.value ?? 0);
  }
  if (t === 'IO_MODBUS') {
    const vt = scToVtLabel(io.valueType ?? 3);
    if (vt === 'TYPE_BIT') return 'B0:'+(Number(io.value)?'ON':'OFF');
    if (vt === 'TYPE_BIT_REG') return 'B'+scBitFromMask(io.bitMask)+':'+(Number(io.value)?'ON':'OFF');
  }
  if (t === 'IO_I2C') {
    if (io.isRTC) return io.rtcStr || '--:--:-- --/--/--';
    const vt = scToVtLabel(io.valueType ?? 2);
    if (vt === 'TYPE_BIT') return 'B0:'+(Number(io.value)?'ON':'OFF');
    if (vt === 'TYPE_BIT_REG') return 'B'+scBitFromMask(io.bitMask)+':'+(Number(io.value)?'ON':'OFF');
  }
  return String(io.value ?? 0);
}

function scWriteCtrl(sIdx, t, io) {
  if (t === 'IO_GPIO') {
    if (io.isInput !== false) return '';
    if (io.pinType === 'ANALOG_PIN')
      return `<input type="number" step="0.01" min="0" max="1" value="0" inputmode="decimal" id="gpiow_${sIdx}_${io.ioIdx}" oninput="scLiveEditState[this.id]=this.value"><button onclick="scGPIOWrite(${sIdx},${io.ioIdx})">Set</button>`;
    const on = io.value===1||io.value===true;
    return `<button class="${on?'btn-on':''}" onclick="scGPIOToggle(${sIdx},${io.ioIdx},${on?0:1})">${on?'ON→0':'OFF→1'}</button>`;
  }
  if (t === 'IO_SHIFT' && !io.isInput) {
    const vt = scToVtLabel(io.valueType ?? 2);
    if (vt === 'TYPE_BIT') { const on=io.value===1||io.value===true; return `<button class="${on?'btn-on':''}" onclick="scShiftToggle(${sIdx},${io.ioIdx},${on?0:1})">${on?'ON→0':'OFF→1'}</button>`; }
    const id=`shiftw_${sIdx}_${io.ioIdx}`, val=scLiveEditState[id]??(io.value??0);
    return `<input type="number" min="0" max="255" value="${val}" inputmode="numeric" id="${id}" oninput="scLiveEditState[this.id]=this.value"><button onclick="scShiftWrite(${sIdx},${io.ioIdx})">Set</button>`;
  }
  if (t === 'IO_MODBUS') {
    if (!scModbusWritable(io.functionCode)||io.commEnable===false) return '';
    const vt = scToVtLabel(io.valueType??3);
    if (vt==='TYPE_BIT'||vt==='TYPE_BIT_REG') {
      const on=Number(io.value)!==0, bp=vt==='TYPE_BIT_REG'?scBitFromMask(io.bitMask):0;
      return `<button class="${on?'btn-on':''}" onclick="scModbusWrite(${sIdx},${io.ioIdx},${on?0:1})">B${bp}:${on?'ON→0':'OFF→1'}</button>`;
    }
    const id=`mbw_${sIdx}_${io.ioIdx}`, val=scLiveEditState[id]??(io.value??0);
    return `<input type="number" value="${val}" inputmode="numeric" id="${id}" oninput="scLiveEditState[this.id]=this.value"><button onclick="scModbusWrite(${sIdx},${io.ioIdx})">Set</button>`;
  }
  if (t === 'IO_I2C') {
    if (io.isRTC) return `<input type="datetime-local" id="rtcw_${sIdx}_${io.ioIdx}"><button onclick="scRTCSet(${sIdx},${io.ioIdx})">Set</button>`;
    if (io.isInput!==false) return '';
    const vt=scToVtLabel(io.valueType??2);
    if (vt==='TYPE_BIT'||vt==='TYPE_BIT_REG') {
      const on=Number(io.value)!==0, bp=vt==='TYPE_BIT_REG'?scBitFromMask(io.bitMask):0;
      return `<button class="${on?'btn-on':''}" onclick="scI2CWrite(${sIdx},${io.ioIdx},${on?0:1})">B${bp}:${on?'ON→0':'OFF→1'}</button>`;
    }
    const id=`i2cw_${sIdx}_${io.ioIdx}`, val=scLiveEditState[id]??(io.value??0);
    return `<input type="number" value="${val}" inputmode="numeric" id="${id}" oninput="scLiveEditState[this.id]=this.value"><button onclick="scI2CWrite(${sIdx},${io.ioIdx})">Set</button>`;
  }
  return '';
}

function scRenderLive(data) {
  const root = document.getElementById('sc-live-root');
  if (!root) return;
  const ae = document.activeElement;
  if (ae?.tagName==='INPUT' && root.contains(ae)) return;
  if (!data.scanners.length) { root.innerHTML='<p class="muted" style="padding:14px">No scanners configured.</p>'; return; }
  let html = '';
  data.scanners.forEach((z, sIdx) => {
    html += `<div class="sc-card"><div class="sc-card-head"><span class="sc-card-title">${escHtml(z.name)}</span><span class="badge badge-id">ID:${z.scannerId}</span></div><div class="io-grid">`;
    for (const t of ['IO_MODBUS','IO_I2C','IO_GPIO','IO_SHIFT']) {
      for (const io of (z.ios[t]??[])) {
        if (!io.active||io.initOnly) continue;
        const val=scFormatVal(io,t), ctrl=scWriteCtrl(sIdx,t,io);
        const tcpTag=(t==='IO_MODBUS'&&(io.transport??'RTU')==='TCP')?' <span style="color:var(--warn);font-size:9px">TCP</span>':'';
        html += `<div class="io-cell${io.changed?' io-changed':''}"><div class="io-type-tag">${scTypeLabel(t)}${tcpTag}</div><div class="io-name">${escHtml(io.name)}</div><div class="io-val" id="val_${sIdx}_${t}_${io.ioIdx}">${escHtml(val)}</div>${ctrl?`<div class="io-write">${ctrl}</div>`:''}</div>`;
      }
    }
    html += '</div></div>';
  });
  root.innerHTML = html;
  for (const [id, val] of Object.entries(scLiveEditState)) { const el=document.getElementById(id); if(el) el.value=val; }
}

const _scInFlight = new Set();
function scGuarded(key, fn) { if(_scInFlight.has(key)) return; _scInFlight.add(key); Promise.resolve().then(fn).finally(()=>_scInFlight.delete(key)); }

function scGPIOToggle(sIdx,ioIdx,val) { scGuarded('gpio_'+sIdx+'_'+ioIdx,()=>scFetch('/api/gpio/write','POST',{scannerIdx:sIdx,ioIdx,value:val})); }
function scGPIOWrite(sIdx,ioIdx) { const el=document.getElementById('gpiow_'+sIdx+'_'+ioIdx); if(el) scGuarded('gpio_'+sIdx+'_'+ioIdx,()=>scFetch('/api/gpio/write','POST',{scannerIdx:sIdx,ioIdx,value:parseFloat(el.value)})); }
function scShiftToggle(sIdx,ioIdx,val) { scGuarded('shift_'+sIdx+'_'+ioIdx,()=>scFetch('/api/shift/write','POST',{scannerIdx:sIdx,ioIdx,value:val})); }
function scShiftWrite(sIdx,ioIdx) { const el=document.getElementById('shiftw_'+sIdx+'_'+ioIdx); if(el) scGuarded('shift_'+sIdx+'_'+ioIdx,()=>scFetch('/api/shift/write','POST',{scannerIdx:sIdx,ioIdx,value:parseInt(el.value)})); }
function scModbusWrite(sIdx,ioIdx,val) { if(val===undefined){const el=document.getElementById('mbw_'+sIdx+'_'+ioIdx); val=el?parseFloat(el.value):0;} scGuarded('mb_'+sIdx+'_'+ioIdx,()=>scFetch('/api/modbus/write','POST',{scannerIdx:sIdx,ioIdx,value:val})); }
function scI2CWrite(sIdx,ioIdx,val) { if(val===undefined){const el=document.getElementById('i2cw_'+sIdx+'_'+ioIdx); val=el?parseFloat(el.value):0;} scGuarded('i2c_'+sIdx+'_'+ioIdx,()=>scFetch('/api/i2c/write','POST',{scannerIdx:sIdx,ioIdx,value:val})); }
function scRTCSet(sIdx,ioIdx) { const el=document.getElementById('rtcw_'+sIdx+'_'+ioIdx); if(!el) return; scGuarded('rtc_'+sIdx+'_'+ioIdx,()=>scFetch('/api/i2c/rtcset','POST',{scannerIdx:sIdx,ioIdx,ts:Math.floor(new Date(el.value).getTime()/1000)})); }

function scConnectSSE() {
  const url = scApi('/events');
  if (!url) { scSetStatus('offline'); return; }
  if (scEs) { scEs.close(); scEs=null; }
  try {
    scEs = new EventSource(url);
    scEs.onopen = () => { scSetStatus('online'); scStopPoll(); };
    scEs.onmessage = ev => { try { scModel=scNormalize(JSON.parse(ev.data)); scRenderLive(scModel); } catch {} };
    scEs.onerror = () => { scEs.close(); scEs=null; scSetStatus('poll'); scStartPoll(); if(!scSseRetryTimer) scSseRetryTimer=setTimeout(()=>{scSseRetryTimer=null;scConnectSSE();},15000); };
  } catch { scSetStatus('poll'); scStartPoll(); }
}

function scStartPoll() {
  if (scPollTimer) return;
  scPollTimer = setInterval(async()=>{ const d=await scFetch('/api/values'); if(d){scModel=scNormalize(d);scRenderLive(scModel);} },2000);
}
function scStopPoll() { if(scPollTimer){clearInterval(scPollTimer);scPollTimer=null;} }

function scInit() {
  if (!getDeviceUrl()) { document.getElementById('sc-live-root').innerHTML='<p class="muted" style="padding:14px">Configure device IP in Settings first.</p>'; return; }
  if (!scInited) { scInited=true; scConnectSSE(); }
}

// ===== SCANNER CONFIG PANEL =====
function scLog(msg) { const el=document.getElementById('sc-log'); if(el) el.textContent='['+new Date().toLocaleTimeString()+'] '+msg+'\n'+el.textContent; }

function scOpenPanel() {
  openFsPanel('Scanner Config', `
    <div class="sc-panel-toolbar">
      <button onclick="scReload()">&#8635; Reload</button>
      <button onclick="scSave()">Save</button>
      <button onclick="scAddScanner()">+ Scanner</button>
    </div>
    <div id="sc-scanners-body" style="padding:14px"></div>
    <pre class="log-box" id="sc-log"></pre>
  `);
  scRenderConfig();
}

async function scReload() { const d=await scFetch('/api/scanners'); if(d){scModel=scNormalize(d);scRenderConfig();scLog('Reloaded');}else scLog('Reload failed'); }
async function scSave() { const r=await scFetch('/api/scanners','POST',scModel); scLog(r?.ok?'Saved OK':'Save failed'); }
async function scAddScanner() { if(scModel.scanners.length>=12){scLog('Max 12 scanners');return;} scModel.scanners.push({name:'Scanner '+(scModel.scanners.length+1),scannerId:scModel.scanners.length+1,ios:{IO_MODBUS:[],IO_I2C:[],IO_GPIO:[],IO_SHIFT:[]}}); scRenderConfig(); }
async function scDeleteScanner(idx) { if(!confirm('Delete scanner?')) return; scModel.scanners.splice(idx,1); scRenderConfig(); }

function scRenderConfig() {
  const body = document.getElementById('sc-scanners-body');
  if (!body) return;
  body.innerHTML = scBuildConfigHtml();
}

// ===== SCANNER CONFIG HELPERS (shared with render) =====
function scToHex(value, width) {
  width = width ?? 2;
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '0x00';
  return '0x' + Math.max(0, Math.trunc(n)).toString(16).toUpperCase().padStart(width, '0');
}

function scParseHexOrDec(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : 0;
  const s = String(value ?? '').trim();
  if (!s) return 0;
  if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function scToVtIndex(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.trunc(v));
  const idx = VALUE_TYPE_OPTIONS.findIndex(o => o.v === String(v ?? ''));
  return idx >= 0 ? idx : 2;
}

const SC_MODBUS_FC_OPTIONS = [
  {v:1, l:'FC01 Read Coils'},
  {v:2, l:'FC02 Read Discrete Inputs'},
  {v:3, l:'FC03 Read Holding Regs'},
  {v:4, l:'FC04 Read Input Regs'},
];

function scSetIOField(scanner, t, ioIdx, field, value) {
  const io = scanner.ios[t]?.find(x => x.ioIdx === ioIdx);
  if (io) io[field] = value;
}
window.scSetIOField = scSetIOField;

function scToggleExtraDetails(sIdx, t, ioIdx) {
  const key = sIdx + ':' + t + ':' + ioIdx;
  scDetOpen[key] = !scDetOpen[key];
  scRenderConfig();
}
window.scToggleExtraDetails = scToggleExtraDetails;

window.scAddIO = function(sIdx, t) {
  const scanner = scModel.scanners[sIdx];
  if (!scanner) return;
  const arr = scanner.ios[t];
  if (arr.length >= 8) { scLog(scTypeLabel(t) + ' limit reached (8 per scanner)'); return; }
  const ioIdx = arr.reduce((m, x) => Math.max(m, Number(x.ioIdx) || 0), -1) + 1;
  const base = {ioIdx, name: scTypeLabel(t) + ' ' + ioIdx, active:true, scale:1.0, initOnly:false, initValue:0};
  if (t === 'IO_SHIFT')  Object.assign(base, {isInput:false, value:0, writeValue:0, dataPin:0, clockPin:0, latchPin:-1, outEnablePin:-1, outEnabled:true, reverseOut:false, valueType:2, bitMask:0});
  else if (t === 'IO_GPIO')   Object.assign(base, {pinType:'DIGITAL_PIN', pin:0, pullup:false, isInput:true, writeValue:0});
  else if (t === 'IO_I2C')    Object.assign(base, {deviceAddr:0x40, regAddr:0, regSize:1, quantity:1, valueType:2, bitMask:0, writeValue:0, isInput:true, isRTC:false, rtcCount:7, rtcStopReg:255, rtcStr:''});
  else if (t === 'IO_MODBUS') Object.assign(base, {slaveId:1, functionCode:0x03, startAddress:0, quantity:1, valueType:3, bitMask:0, writeValue:0});
  arr.push(base);
  scRenderConfig();
};

window.scDeleteIO = function(sIdx, t, ioIdx) {
  const z = scModel.scanners[sIdx];
  if (z) z.ios[t] = z.ios[t].filter(x => Number(x.ioIdx) !== Number(ioIdx));
  scRenderConfig();
};

window.scApplyShiftWrite = (sIdx, ioIdx) => scGuarded('sh_'+sIdx+'_'+ioIdx, async () => {
  const io = scModel.scanners[sIdx]?.ios['IO_SHIFT']?.find(x => Number(x.ioIdx) === Number(ioIdx));
  if (!io) return;
  const vt = scToVtLabel(io.valueType ?? 2);
  let val = Number(io.writeValue ?? 0);
  if (vt === 'TYPE_BIT') val = val ? 1 : 0;
  const r = await scFetch('/api/shift/write','POST',{scannerIdx:sIdx,ioIdx,value:val});
  scLog('SHIFT write: ' + JSON.stringify(r));
});

window.scApplyShiftBitToggle = (sIdx, ioIdx, bitVal) => scGuarded('sh_'+sIdx+'_'+ioIdx, async () => {
  const r = await scFetch('/api/shift/write','POST',{scannerIdx:sIdx,ioIdx,value:bitVal});
  scLog('SHIFT bit: ' + JSON.stringify(r));
});

window.scApplyShiftOE = (sIdx, ioIdx, enabled) => scGuarded('shoe_'+sIdx+'_'+ioIdx, async () => {
  const r = await scFetch('/api/shift/oe','POST',{scannerIdx:sIdx,ioIdx,enabled:!!enabled});
  scLog('SHIFT OE: ' + JSON.stringify(r));
});

window.scApplyModbusWrite = (sIdx, ioIdx, val) => scGuarded('mb_'+sIdx+'_'+ioIdx, async () => {
  const io = scModel.scanners[sIdx]?.ios['IO_MODBUS']?.find(x => Number(x.ioIdx) === Number(ioIdx));
  if (!io) return;
  const writeVal = val !== undefined ? val : Number(io.writeValue ?? 0);
  const r = await scFetch('/api/modbus/write','POST',{scannerIdx:sIdx,ioIdx,value:writeVal});
  scLog('MODBUS write: ' + JSON.stringify(r));
});

window.scApplyI2CWrite = (sIdx, ioIdx, val) => scGuarded('i2c_'+sIdx+'_'+ioIdx, async () => {
  const io = scModel.scanners[sIdx]?.ios['IO_I2C']?.find(x => Number(x.ioIdx) === Number(ioIdx));
  if (!io) return;
  const writeVal = val !== undefined ? val : Number(io.writeValue ?? 0);
  const r = await scFetch('/api/i2c/write','POST',{scannerIdx:sIdx,ioIdx,value:writeVal});
  scLog('I2C write: ' + JSON.stringify(r));
});

window.scApplyGPIOWrite = (sIdx, ioIdx) => scGuarded('gpio_'+sIdx+'_'+ioIdx, async () => {
  const io = scModel.scanners[sIdx]?.ios['IO_GPIO']?.find(x => Number(x.ioIdx) === Number(ioIdx));
  if (!io) return;
  const payload = io.pinType === 'ANALOG_PIN'
    ? {scannerIdx:sIdx,ioIdx,scaledValue:Number(io.writeScaledValue??0)}
    : {scannerIdx:sIdx,ioIdx,value:Number(io.writeValue??0)};
  const r = await scFetch('/api/gpio/write','POST',payload);
  scLog('GPIO write: ' + JSON.stringify(r));
});

window.scToggleCfgLegend = function(id) {
  const body = document.getElementById(id);
  const btn  = document.getElementById(id + '_btn');
  if (!body || !btn) return;
  if (body.style.display === 'none') {
    body.style.display = '';
    btn.innerHTML = '? Fields &#9650;';
  } else {
    body.style.display = 'none';
    btn.innerHTML = '? Fields &#9660;';
  }
};

// ===== RENDER CONFIG HELPERS =====
function scBuildExtraConfig(sIdx, t, io) {
  const SI = 'scModel.scanners[' + sIdx + ']';
  const sif = (field, expr) => 'scSetIOField(' + SI + ",'" + t + "'," + io.ioIdx + ",'" + field + "'," + expr + ')';

  const mqttFields = (io) =>
      '<div class="mini">MQTT <input type="checkbox"' + (io.mqttEnable ? ' checked' : '') + ' onchange="' + sif('mqttEnable','this.checked') + ';scRenderConfig()" title="Publish value to MQTT broker on every change; subscribe for remote write commands"/></div>'
    + (io.mqttEnable
        ? '<div class="mini">Min Interval (s) <input type="number" min="0" value="' + (io.mqttMinInterval ?? 0) + '" style="width:60px" title="Minimum seconds between MQTT publishes (throttle). 0 = publish on every change." onchange="' + sif('mqttMinInterval','Number(this.value)') + '"/></div>'
        + '<div class="mini">Dead Band <input type="number" min="0" step="0.1" value="' + (io.mqttDeadBand ?? 0) + '" style="width:65px" title="Minimum value change required before publishing again. 0 = publish on any change." onchange="' + sif('mqttDeadBand','Number(this.value)') + '"/></div>'
        : '');

  const legId = 'cfgleg_' + sIdx + '_' + io.ioIdx;
  const cfgLegend = (html) =>
      '<div class="cfg-legend-row"><button id="' + legId + '_btn" class="cfg-legend-btn" onclick="scToggleCfgLegend(\'' + legId + '\')">? Fields &#9660;</button></div>'
    + '<div id="' + legId + '" class="cfg-legend-body" style="display:none"><table>' + html + '</table></div>';

  if (t === 'IO_MODBUS') {
    const curVT  = scToVtLabel(io.valueType ?? 3);
    const isTCP  = (io.transport ?? 'RTU') === 'TCP';
    const tcpFields = isTCP
      ? '<div class="mini">IP <input type="text" value="' + escHtml(io.tcpIp ?? '') + '" style="width:110px" placeholder="192.168.x.x" title="IP address of the remote Modbus TCP server" onchange="' + sif('tcpIp','this.value') + '"/></div>'
        + '<div class="mini">Port <input type="number" value="' + (io.tcpPort ?? 502) + '" style="width:65px" title="TCP port of the Modbus server (default: 502)" onchange="' + sif('tcpPort','Number(this.value)') + '"/></div>'
        + '<div class="mini">Unit ID <input type="number" value="' + (io.slaveId ?? 1) + '" style="width:60px" title="Modbus unit/slave ID within the TCP server (1-247). Use 255 if the server ignores it." onchange="' + sif('slaveId','Number(this.value)') + '"/></div>'
      : '<div class="mini">Slave ID <input type="number" value="' + (io.slaveId ?? 1) + '" style="width:60px" title="RS-485 bus address of the target slave device (1-247). Must match the device DIP switch or config." onchange="' + sif('slaveId','Number(this.value)') + '"/></div>';
    return '<div class="cfg-section-head">Connection</div>'
      + '<div class="mini">Transport <select title="RTU = serial over RS-485 (uses Hardware Config baud/pins); TCP = WiFi/Ethernet socket connection" onchange="' + sif('transport','this.value') + '; scRenderConfig()">'
          + '<option value="RTU"' + (!isTCP ? ' selected' : '') + '>RTU (RS-485)</option>'
          + '<option value="TCP"' + ( isTCP ? ' selected' : '') + '>TCP (WiFi)</option>'
          + '</select></div>'
      + tcpFields
      + '<div class="cfg-section-head">Register</div>'
      + '<div class="mini">FC <select title="Function Code — what to do on the slave." onchange="' + sif('functionCode','Number(this.value)') + '">'
      + SC_MODBUS_FC_OPTIONS.map(o => '<option value="' + o.v + '"' + ((io.functionCode??3)===o.v?' selected':'') + '>' + o.l + '</option>').join('')
      + '</select></div>'
      + '<div class="mini">Address <input type="number" value="' + (io.startAddress??0) + '" style="width:75px" title="Register start address (0-based PDU)." onchange="' + sif('startAddress','Number(this.value)') + '"/></div>'
      + '<div class="mini">Qty <input type="number" value="' + (io.quantity??1) + '" style="width:55px" title="Number of registers or coils to read per request." onchange="' + sif('quantity','Number(this.value)') + '"/></div>'
      + '<div class="cfg-section-head">Data</div>'
      + '<div class="mini">Type <select title="How to interpret the raw register word(s)" onchange="' + sif('valueType','scToVtIndex(this.value)') + '">'
        + VALUE_TYPE_OPTIONS.map(o => '<option value="' + o.v + '"' + (curVT===o.v?' selected':'') + '>' + o.l + '</option>').join('') + '</select></div>'
      + '<div class="mini">BitMask <input type="text" value="' + scToHex(io.bitMask??0,2) + '" style="width:80px" placeholder="0x00" title="Only used for Bit-in-Reg type." onchange="' + sif('bitMask','scParseHexOrDec(this.value)') + '"/></div>'
      + (['TYPE_U32','TYPE_I32','TYPE_F32'].includes(curVT)
          ? '<div class="mini">Word Swap <input type="checkbox"' + (io.wordSwap ? ' checked' : '') + ' onchange="' + sif('wordSwap','this.checked') + '" title="Swap high/low 16-bit words for 32-bit values."/></div>'
          : '')
      + '<div class="cfg-section-head">Options</div>'
      + '<div class="mini">Comm Enable <input type="checkbox"' + (io.commEnable !== false ? ' checked' : '') + ' onchange="' + sif('commEnable','this.checked') + '" title="Uncheck to disable read and write for this IO without deleting it."/></div>'
      + '<div class="mini">Init Only <input type="checkbox"' + (io.initOnly ? ' checked' : '') + ' onchange="' + sif('initOnly','this.checked') + '; scRenderConfig()" title="Write startup value once at boot, then exclude from scan loop."/></div>'
      + (io.initOnly ? '<div class="mini">Startup Value <input type="number" value="' + (io.initValue ?? 0) + '" style="width:75px" title="Raw value written to the register at boot." onchange="' + sif('initValue','Number(this.value)') + '"/></div>' : '')
      + mqttFields(io)
      + cfgLegend(
          '<tr><td>Transport</td><td>RTU = RS-485 serial (uses HW Config baud/pins) &nbsp;|&nbsp; TCP = WiFi/Ethernet socket</td></tr>'
        + '<tr><td>Slave ID</td><td>RS-485 device address (1-247). Must match device DIP switch or config.</td></tr>'
        + '<tr><td>Unit ID</td><td>Slave ID within a Modbus TCP server (1-247). Use 255 if the server ignores it.</td></tr>'
        + '<tr><td>IP / Port</td><td>Remote Modbus TCP server IP address and port (default: 502)</td></tr>'
        + '<tr><td>FC</td><td>Function Code — FC3=read holding regs &nbsp;FC4=input regs &nbsp;FC1=coils &nbsp;FC2=discrete inputs</td></tr>'
        + '<tr><td>Address</td><td>0-based register address. Holding reg 40001 = address 0, 40002 = 1, etc.</td></tr>'
        + '<tr><td>Qty</td><td>Registers/coils per request. For 32-bit types use Qty=1 (firmware reads 2 registers automatically).</td></tr>'
        + '<tr><td>Type</td><td>Data format: U16=unsigned 16-bit &nbsp;I16=signed 16-bit &nbsp;Bit-in-Reg=single bit via BitMask &nbsp;U32/I32/F32=32-bit</td></tr>'
        + '<tr><td>BitMask</td><td>Bit-in-Reg only — which bit to extract: 0x01=bit0 &nbsp;0x02=bit1 &nbsp;0x80=bit7 &nbsp;0x0100=bit8</td></tr>'
        + '<tr><td>Word Swap</td><td>Swap high/low 16-bit words for 32-bit values. Required for Schneider and some VFDs.</td></tr>'
        + '<tr><td>Comm Enable</td><td>Uncheck to disable all read/write without deleting this IO (temporary bypass)</td></tr>'
        + '<tr><td>Init Only</td><td>Write Startup Value once at boot then stop scanning. Use for one-time config registers.</td></tr>'
        + '<tr><td>MQTT</td><td>Publish value on change to broker; subscribe to receive remote write commands</td></tr>'
        + '<tr><td>Min Interval</td><td>Minimum seconds between MQTT publishes (throttle). 0 = every change.</td></tr>'
        + '<tr><td>Dead Band</td><td>Minimum value change required to trigger a publish. 0 = any change.</td></tr>'
        );
  }
  if (t === 'IO_I2C') {
    const curVT = scToVtLabel(io.valueType ?? 2);
    return '<div class="cfg-section-head">Device</div>'
      + '<div class="mini">Dev Addr <input type="text" value="' + scToHex(io.deviceAddr,2) + '" style="width:70px" title="7-bit I2C device address (hex)." onchange="' + sif('deviceAddr','scParseHexOrDec(this.value)') + '"/></div>'
      + '<div class="mini">Reg Addr <input type="text" value="' + scToHex(io.regAddr??0,2) + '" style="width:70px" title="Register address to read or write on the device (hex)." onchange="' + sif('regAddr','scParseHexOrDec(this.value)') + '"/></div>'
      + '<div class="mini">Reg Size <select title="Width of each register access." onchange="' + sif('regSize','Number(this.value)') + '">'
        + [{v:0,l:'AUTO'},{v:1,l:'8-bit'},{v:2,l:'16-bit'}].map(o => '<option value="' + o.v + '"' + ((io.regSize??1)===o.v?' selected':'') + '>' + o.l + '</option>').join('') + '</select></div>'
      + '<div class="mini">Qty <input type="number" value="' + (io.quantity??1) + '" style="width:55px" title="Number of consecutive registers to read in one I2C transaction." onchange="' + sif('quantity','Number(this.value)') + '"/></div>'
      + '<div class="cfg-section-head">Data</div>'
      + '<div class="mini">Type <select title="How to interpret the raw bytes." onchange="' + sif('valueType','scToVtIndex(this.value)') + '">'
        + VALUE_TYPE_OPTIONS.map(o => '<option value="' + o.v + '"' + (curVT===o.v?' selected':'') + '>' + o.l + '</option>').join('') + '</select></div>'
      + '<div class="mini">BitMask <input type="text" value="' + scToHex(io.bitMask??0,2) + '" style="width:80px" placeholder="0x00" title="Only used for Bit-in-Reg type." onchange="' + sif('bitMask','scParseHexOrDec(this.value)') + '"/></div>'
      + '<div class="mini">Dir <select title="Input = read value from the device register; Output = write value to the device register." onchange="' + sif('isInput',"this.value==='input'") + '">'
        + '<option value="input"'  + (io.isInput!==false?' selected':'') + '>Input</option>'
        + '<option value="output"' + (io.isInput===false?' selected':'') + '>Output</option>'
        + '</select></div>'
      + '<div class="cfg-section-head">Options</div>'
      + '<div class="mini">RTC Mode <input type="checkbox"' + (io.isRTC ? ' checked' : '') + ' onchange="' + sif('isRTC','this.checked') + '; scRenderConfig()" title="Enable BCD real-time clock read mode."/></div>'
      + (io.isRTC
          ? '<div class="mini">Byte Count <input type="number" min="1" max="8" value="' + (io.rtcCount ?? 7) + '" style="width:55px" title="Number of BCD bytes to read from the RTC. DS3231/DS1307 = 7." onchange="' + sif('rtcCount','Number(this.value)') + '"/></div>'
          + '<div class="mini">Stop Reg <input type="text" value="' + scToHex(io.rtcStopReg??255,2) + '" style="width:55px" title="RX8130CE only: address of the STOP-bit control register (0x1C). 0xFF = disable." onchange="' + sif('rtcStopReg','scParseHexOrDec(this.value)') + '"/></div>'
          : '')
      + '<div class="mini">Init Only <input type="checkbox"' + (io.initOnly ? ' checked' : '') + ' onchange="' + sif('initOnly','this.checked') + '; scRenderConfig()" title="Write startup value once at boot, then exclude from scan loop."/></div>'
      + (io.initOnly ? '<div class="mini">Startup Value <input type="number" value="' + (io.initValue ?? 0) + '" style="width:75px" title="Raw value written to the register at boot." onchange="' + sif('initValue','Number(this.value)') + '"/></div>' : '')
      + mqttFields(io)
      + cfgLegend(
          '<tr><td>Dev Addr</td><td>7-bit I2C device address (hex). 0x40=INA219 &nbsp;0x48=ADS1115/TMP102 &nbsp;0x68=DS3231/MPU6050 &nbsp;0x3C=SSD1306 &nbsp;0x76=BME280</td></tr>'
        + '<tr><td>Reg Addr</td><td>Target register address on the device (hex). See the device datasheet register map.</td></tr>'
        + '<tr><td>Reg Size</td><td>Access width: 8-bit=1 byte per register &nbsp;16-bit=2 bytes (big-endian) &nbsp;AUTO=firmware decides</td></tr>'
        + '<tr><td>Qty</td><td>Number of consecutive registers to read in one I2C transaction</td></tr>'
        + '<tr><td>Type</td><td>Data format: U16=unsigned 16-bit &nbsp;I16=signed &nbsp;Bit-in-Reg=single bit via BitMask &nbsp;F32=IEEE 754 float</td></tr>'
        + '<tr><td>BitMask</td><td>Bit-in-Reg only — which bit to extract: 0x01=bit0 &nbsp;0x08=bit3 &nbsp;0x80=bit7</td></tr>'
        + '<tr><td>Dir</td><td>Input = read value from device register &nbsp;|&nbsp; Output = write value to device register</td></tr>'
        + '<tr><td>RTC Mode</td><td>BCD decode for DS3231/DS1307/RX8130CE. Reads packed BCD time registers and decodes them into a timestamp.</td></tr>'
        + '<tr><td>Byte Count</td><td>BCD bytes to read from RTC. DS3231/DS1307 = 7 (sec, min, hr, weekday, day, month, year).</td></tr>'
        + '<tr><td>Stop Reg</td><td>RX8130CE only: STOP-bit control register (0x1C). Must be cleared before oscillator starts. 0xFF = disable.</td></tr>'
        + '<tr><td>Init Only</td><td>Write Startup Value once at boot then stop scanning. Use for one-time config registers.</td></tr>'
        + '<tr><td>MQTT</td><td>Publish value on change to broker; subscribe to receive remote write commands</td></tr>'
        + '<tr><td>Min Interval</td><td>Minimum seconds between MQTT publishes (throttle). 0 = every change.</td></tr>'
        + '<tr><td>Dead Band</td><td>Minimum value change required to trigger a publish. 0 = any change.</td></tr>'
        );
  }
  if (t === 'IO_GPIO') {
    return '<div class="cfg-section-head">Pin</div>'
      + '<div class="mini">Type <select title="Digital = binary on/off; Analog = PWM output 0.0-1.0 or ADC input 0-4095." onchange="' + sif('pinType','this.value') + '">'
          + '<option value="DIGITAL_PIN"' + (io.pinType!=='ANALOG_PIN'?' selected':'') + '>Digital</option>'
          + '<option value="ANALOG_PIN"'  + (io.pinType==='ANALOG_PIN'?' selected':'') + '>Analog</option>'
          + '</select></div>'
      + '<div class="mini">Pin <input type="number" value="' + (io.pin??0) + '" style="width:60px" title="ESP32 GPIO pin number (0-39)." onchange="' + sif('pin','Number(this.value)') + '"/></div>'
      + '<div class="mini">Dir <select title="Input = read pin state; Output = drive pin." onchange="' + sif('isInput',"this.value==='input'") + '">'
          + '<option value="input"'  + (io.isInput!==false?' selected':'') + '>Input</option>'
          + '<option value="output"' + (io.isInput===false?' selected':'') + '>Output</option>'
          + '</select></div>'
      + '<div class="mini">Pull-up <input type="checkbox"' + (io.pullup?' checked':'') + ' title="Enable internal pull-up resistor (~45kΩ)." onchange="' + sif('pullup','this.checked') + '"/></div>'
      + '<div class="cfg-section-head">Options</div>'
      + '<div class="mini">Init Only <input type="checkbox"' + (io.initOnly ? ' checked' : '') + ' onchange="' + sif('initOnly','this.checked') + '; scRenderConfig()" title="Write startup value once at boot then stop scanning."/></div>'
      + (io.initOnly ? '<div class="mini">Startup Value <input type="number" value="' + (io.initValue ?? 0) + '" style="width:75px" title="Value written at boot: 0=LOW, 1=HIGH." onchange="' + sif('initValue','Number(this.value)') + '"/></div>' : '')
      + mqttFields(io)
      + cfgLegend(
          '<tr><td>Type</td><td>Digital: 0=LOW, 1=HIGH &nbsp;|&nbsp; Analog: PWM output 0.0-1.0 duty cycle or ADC input 0-4095 (12-bit)</td></tr>'
        + '<tr><td>Pin</td><td>ESP32 GPIO number (0-39). GPIO 6-11 reserved for internal flash; GPIO 34-39 are input-only.</td></tr>'
        + '<tr><td>Dir</td><td>Input = read pin state &nbsp;|&nbsp; Output = drive HIGH/LOW (digital) or set PWM duty (analog)</td></tr>'
        + '<tr><td>Pull-up</td><td>Enable internal ~45kΩ pull-up resistor. Keeps idle input HIGH. Use for buttons wired to GND and open-drain sensors.</td></tr>'
        + '<tr><td>Init Only</td><td>Write Startup Value once at boot then stop scanning</td></tr>'
        + '<tr><td>MQTT</td><td>Publish value on change to broker; subscribe to receive remote write commands</td></tr>'
        + '<tr><td>Min Interval</td><td>Minimum seconds between MQTT publishes (throttle). 0 = every change.</td></tr>'
        + '<tr><td>Dead Band</td><td>Minimum value change required to trigger a publish. 0 = any change.</td></tr>'
        );
  }
  if (t === 'IO_SHIFT') {
    const curVT = scToVtLabel(io.valueType ?? 2);
    const isOut = !io.isInput;
    const latchLabel = isOut ? 'Latch Pin' : 'Load Pin';
    const latchTitle = isOut
      ? 'Storage latch clock (RCLK/ST_CP on 74HC595). Pulse HIGH to transfer shift register to output latches. -1 = not connected.'
      : 'Parallel load pin (PL on 74HC165). Pull LOW to load parallel inputs into register before clocking out. -1 = not connected.';
    return '<div class="cfg-section-head">Pins</div>'
      + '<div class="mini">Dir <select title="Input = read from a shift-in register (e.g. 74HC165); Output = write to a shift-out register (e.g. 74HC595)." onchange="' + sif('isInput',"this.value==='input'") + '">'
          + '<option value="input"'  + (io.isInput?' selected':'') + '>Input</option>'
          + '<option value="output"' + (!io.isInput?' selected':'') + '>Output</option>'
          + '</select></div>'
      + '<div class="mini">Data Pin <input type="number" value="' + (io.dataPin??0) + '" style="width:60px" title="Serial data line. Output: DS/SER on 74HC595. Input: Q7 on 74HC165." onchange="' + sif('dataPin','Number(this.value)') + '"/></div>'
      + '<div class="mini">Clock Pin <input type="number" value="' + (io.clockPin??0) + '" style="width:60px" title="Shift clock. Each rising edge shifts one bit." onchange="' + sif('clockPin','Number(this.value)') + '"/></div>'
      + '<div class="mini">' + latchLabel + ' <input type="number" value="' + (io.latchPin??-1) + '" style="width:60px" title="' + latchTitle + '" onchange="' + sif('latchPin','Number(this.value)') + '"/></div>'
      + '<div class="mini">OE Pin <input type="number" value="' + (io.outEnablePin??-1) + '" style="width:60px" title="Output Enable pin (active LOW). -1 = not connected." onchange="' + sif('outEnablePin','Number(this.value)') + '"/></div>'
      + '<div class="mini">Invert <input type="checkbox"' + (io.reverseOut?' checked':'') + ' title="Invert all output bits." onchange="' + sif('reverseOut','this.checked') + '"/> <label>0&#x21D7;1</label></div>'
      + '<div class="cfg-section-head">Data</div>'
      + '<div class="mini">Type <select title="How to interpret the shift register byte(s)." onchange="' + sif('valueType','scToVtIndex(this.value)') + '">'
        + VALUE_TYPE_OPTIONS.map(o => '<option value="' + o.v + '"' + (curVT===o.v?' selected':'') + '>' + o.l + '</option>').join('') + '</select></div>'
      + '<div class="mini">BitMask <input type="text" value="' + scToHex(io.bitMask??0,2) + '" style="width:80px" placeholder="0x00" title="Only used for Bit-in-Reg type." onchange="' + sif('bitMask','scParseHexOrDec(this.value)') + '"/></div>'
      + '<div class="cfg-section-head">Options</div>'
      + '<div class="mini">Init Only <input type="checkbox"' + (io.initOnly ? ' checked' : '') + ' onchange="' + sif('initOnly','this.checked') + '; scRenderConfig()" title="Write startup value once at boot, then exclude from scan loop."/></div>'
      + (io.initOnly ? '<div class="mini">Startup Value <input type="number" min="0" max="255" value="' + (io.initValue ?? 0) + '" style="width:75px" title="Byte value clocked into the shift register at boot (0-255)." onchange="' + sif('initValue','Number(this.value)') + '"/></div>' : '')
      + mqttFields(io)
      + cfgLegend(
          '<tr><td>Dir</td><td>Input = shift-in (74HC165: 8 DI via 3 wires) &nbsp;|&nbsp; Output = shift-out (74HC595: 8 DO via 3 wires)</td></tr>'
        + '<tr><td>Data Pin</td><td>Serial data line: DS/SER on 74HC595 (output) &nbsp;|&nbsp; Q7 on 74HC165 (input)</td></tr>'
        + '<tr><td>Clock Pin</td><td>Shift clock: SHCP/SH_CP on 74HC595 &nbsp;|&nbsp; CLK on 74HC165. Rising edge shifts one bit.</td></tr>'
        + '<tr><td>Latch Pin</td><td>Output (74HC595): RCLK/ST_CP — pulse HIGH to copy shift register to output latches. -1=not connected</td></tr>'
        + '<tr><td>Load Pin</td><td>Input (74HC165): PL — pull LOW to load all parallel inputs into register before reading. -1=not connected</td></tr>'
        + '<tr><td>OE Pin</td><td>Output Enable (active LOW). -1=always enabled. Pull to GND via resistor if unused.</td></tr>'
        + '<tr><td>Invert</td><td>Flip all bits: logical 1 drives output LOW, 0 drives HIGH. Use for active-low relay or LED modules.</td></tr>'
        + '<tr><td>Type</td><td>Data format: U8=byte (0-255) &nbsp;U16=two bytes unsigned &nbsp;Bit-in-Reg=single bit via BitMask</td></tr>'
        + '<tr><td>BitMask</td><td>Bit-in-Reg only — which bit to read/write: 0x01=bit0/Q0 &nbsp;0x40=bit6/Q6 &nbsp;0x80=bit7/Q7</td></tr>'
        + '<tr><td>Init Only</td><td>Clock Startup Value into shift register once at boot then stop scanning</td></tr>'
        + '<tr><td>MQTT</td><td>Publish value on change to broker; subscribe to receive remote write commands</td></tr>'
        + '<tr><td>Min Interval</td><td>Minimum seconds between MQTT publishes (throttle). 0 = every change.</td></tr>'
        + '<tr><td>Dead Band</td><td>Minimum value change required to trigger a publish. 0 = any change.</td></tr>'
        );
  }
  return '';
}

function scBuildWriteControl(sIdx, t, io) {
  const SI = 'scModel.scanners[' + sIdx + ']';
  const sif = (field, expr) => 'scSetIOField(' + SI + ",'" + t + "'," + io.ioIdx + ",'" + field + "'," + expr + ')';

  if (t === 'IO_GPIO') {
    if (io.isInput !== false) return '<span class="muted-tag">IN</span>';
    if (io.pinType === 'ANALOG_PIN') {
      return '<input type="number" step="0.01" min="0" max="1" value="' + (io.writeScaledValue??0) + '" style="width:65px" onchange="' + sif('writeScaledValue','Number(this.value)') + '"/>'
           + '<button onclick="scApplyGPIOWrite(' + sIdx + ',' + io.ioIdx + ')">Set</button>';
    }
    return '<label class="sw"><input type="checkbox"' + ((io.writeValue??0)?'checked':'') + ' onchange="' + sif('writeValue','this.checked?1:0') + '"/><span>ON/OFF</span></label>'
         + '<button onclick="scApplyGPIOWrite(' + sIdx + ',' + io.ioIdx + ')">Set</button>';
  }

  if (t === 'IO_SHIFT') {
    if (io.isInput) return '<span class="muted-tag">IN</span>';
    const vt = scToVtLabel(io.valueType ?? 2);
    let ctrl = '';
    if (vt === 'TYPE_BIT') {
      const on = (io.value ?? 0) !== 0;
      ctrl = '<button class="' + (on ? 'btn-on' : '') + '" onclick="scApplyShiftBitToggle(' + sIdx + ',' + io.ioIdx + ',' + (on ? 0 : 1) + ')">'
           + (on ? 'ON' : 'OFF') + '</button>';
    } else if (vt === 'TYPE_BIT_REG') {
      const mask = scNormShift(io.bitMask ?? 0);
      const bitIsSet = (scNormShift(io.value ?? 0) & mask) !== 0;
      let bitPos = 0;
      for (let b = 0; b < 8; b++) { if (mask & (1 << b)) { bitPos = b; break; } }
      const nextVal = bitIsSet ? 0 : 1;
      ctrl = '<button class="' + (bitIsSet ? 'btn-on' : '') + '" onclick="scApplyShiftBitToggle(' + sIdx + ',' + io.ioIdx + ',' + nextVal + ')">'
           + 'B' + bitPos + ':' + (bitIsSet ? 'ON' : 'OFF') + '</button>';
    } else {
      ctrl = '<input type="number" value="' + (io.writeValue??0) + '" style="width:65px" min="0" max="255" onchange="' + sif('writeValue','Number(this.value)') + '"/>'
           + '<button onclick="scApplyShiftWrite(' + sIdx + ',' + io.ioIdx + ')">Set</button>';
    }
    if ((io.outEnablePin ?? -1) >= 0) {
      const oeOn = io.outEnabled !== false;
      ctrl += ' <button class="' + (oeOn ? 'btn-on' : '') + '" onclick="scApplyShiftOE(' + sIdx + ',' + io.ioIdx + ',' + (oeOn ? 0 : 1) + ')" title="Output Enable (OE)">'
            + 'OE:' + (oeOn ? 'ON' : 'OFF') + '</button>';
    }
    return ctrl;
  }

  if (t === 'IO_MODBUS') {
    if (!scModbusWritable(io.functionCode)) return '<span class="muted-tag">READ</span>';
    const vt = scToVtLabel(io.valueType ?? 3);
    if (vt === 'TYPE_BIT' || vt === 'TYPE_BIT_REG') {
      const on = Number(io.value) !== 0;
      const bp = vt === 'TYPE_BIT_REG' ? scBitFromMask(io.bitMask) : 0;
      return '<button class="' + (on ? 'btn-on' : '') + '" onclick="scApplyModbusWrite(' + sIdx + ',' + io.ioIdx + ',' + (on?0:1) + ')">'
           + 'B' + bp + ':' + (on ? 'ON' : 'OFF') + '</button>';
    }
    return '<input type="number" value="' + (io.writeValue??0) + '" style="width:65px" onchange="' + sif('writeValue','Number(this.value)') + '"/>'
         + '<button onclick="scApplyModbusWrite(' + sIdx + ',' + io.ioIdx + ')">Set</button>';
  }

  if (t === 'IO_I2C') {
    if (io.isInput !== false) return '<span class="muted-tag">READ</span>';
    const vt = scToVtLabel(io.valueType ?? 2);
    if (vt === 'TYPE_BIT' || vt === 'TYPE_BIT_REG') {
      const on = Number(io.value) !== 0;
      const bp = vt === 'TYPE_BIT_REG' ? scBitFromMask(io.bitMask) : 0;
      return '<button class="' + (on ? 'btn-on' : '') + '" onclick="scApplyI2CWrite(' + sIdx + ',' + io.ioIdx + ',' + (on?0:1) + ')">'
           + 'B' + bp + ':' + (on ? 'ON' : 'OFF') + '</button>';
    }
    return '<input type="number" value="' + (io.writeValue??0) + '" style="width:65px" onchange="' + sif('writeValue','Number(this.value)') + '"/>'
         + '<button onclick="scApplyI2CWrite(' + sIdx + ',' + io.ioIdx + ')">Set</button>';
  }
  return '';
}

// ===== scBuildConfigHtml — ported from dashboard.html render() =====
function scBuildConfigHtml() {
  if (!scModel.scanners.length) return '<p class="muted">No scanners. Click + Scanner to add one.</p>';

  let out = '';
  scModel.scanners.forEach((z, sIdx) => {
    out += '<div class="card">'
         + '<div class="scanner-head"><h3>Scanner&nbsp;<input type="text" id="z_' + z.scannerId + '_name" value="'
         + escHtml(z.name) + '" style="width:160px"/>&nbsp;<span class="badge badge-id">ID:' + z.scannerId + '</span></h3>'
         + '<button class="danger" onclick="scDeleteScanner(' + sIdx + ')">Delete</button></div>';

    for (const t of ['IO_MODBUS','IO_I2C','IO_GPIO','IO_SHIFT']) {
      const arr = z.ios[t] || [];
      const atLimit = arr.length >= 8;
      out += '<div class="type-block">'
           + '<div class="type-head">'
           + '<h4>' + scTypeLabel(t) + ' <span class="muted">(' + arr.length + ')</span></h4>'
           + '<button onclick="scAddIO(' + sIdx + ",'" + t + "')" + (atLimit ? ' disabled title="' + scTypeLabel(t) + ' limit: 8 per scanner"' : '') + '>+ Add ' + scTypeLabel(t) + '</button>'
           + '</div>';

      out += '<div style="overflow-x:auto"><table class="io-table">'
           + '<colgroup>'
           + '<col style="width:32px">'
           + '<col>'
           + '<col style="width:42px">'
           + '<col style="width:115px">'
           + '<col>'
           + '<col style="width:128px">'
           + '<col style="width:42px">'
           + '<col style="width:42px">'
           + '</colgroup>'
           + '<thead><tr><th>#</th><th>Name</th><th>Act</th><th>Scale</th><th>Value</th><th>Write</th><th>Config</th><th>Del</th></tr></thead><tbody>';

      arr.forEach(io => {
        const key = sIdx + ':' + t + ':' + io.ioIdx;
        const showExtra = Boolean(scDetOpen[key]);
        const extra = scBuildExtraConfig(sIdx, t, io);
        const wctrl = scBuildWriteControl(sIdx, t, io);

        const SI = 'scModel.scanners[' + sIdx + ']';
        const sif = (field, expr) => 'scSetIOField(' + SI + ",'" + t + "'," + io.ioIdx + ",'" + field + "'," + expr + ')';

        let valDisplay = String(io.value ?? '');
        if (t === 'IO_GPIO') valDisplay = io.pinType === 'DIGITAL_PIN' ? scAsBitOnOff(io.value) : String(io.value ?? '');
        else if (t === 'IO_SHIFT') {
          const vt = scToVtLabel(io.valueType ?? 2);
          if (vt === 'TYPE_BIT') valDisplay = scAsBitOnOff(io.value);
          else if (vt === 'TYPE_BIT_REG') {
            const mask = scNormShift(io.bitMask ?? 0);
            const bitIsSet = (scNormShift(io.value ?? 0) & mask) !== 0;
            valDisplay = 'B' + scBitFromMask(mask) + ':' + (bitIsSet ? 'ON' : 'OFF');
          }
          else valDisplay = String(io.value ?? '');
        }
        else if (t === 'IO_MODBUS') {
          const vt = scToVtLabel(io.valueType ?? 3);
          if (vt === 'TYPE_BIT')     valDisplay = 'B0:' + (Number(io.value) ? 'ON' : 'OFF');
          else if (vt === 'TYPE_BIT_REG') valDisplay = 'B' + scBitFromMask(io.bitMask) + ':' + (Number(io.value) ? 'ON' : 'OFF');
        }
        else if (t === 'IO_I2C') {
          const vt = scToVtLabel(io.valueType ?? 2);
          if (vt === 'TYPE_BIT')     valDisplay = 'B0:' + (Number(io.value) ? 'ON' : 'OFF');
          else if (vt === 'TYPE_BIT_REG') valDisplay = 'B' + scBitFromMask(io.bitMask) + ':' + (Number(io.value) ? 'ON' : 'OFF');
        }

        out += '<tr>'
             + '<td>' + io.ioIdx + '</td>'
             + '<td><input type="text" value="' + escHtml(io.name) + '" class="io-name-input" onchange="' + sif('name','this.value') + '"/></td>'
             + '<td style="text-align:center"><input type="checkbox"' + (io.active?' checked':'') + ' onchange="' + sif('active','this.checked') + '"/></td>'
             + '<td><input type="number" step="0.01" value="' + (io.scale??1.0) + '" style="width:100%;box-sizing:border-box" onchange="' + sif('scale','Number(this.value)') + '"/></td>'
             + '<td id="val_' + sIdx + '_' + t + '_' + io.ioIdx + '" class="' + (io.changed?'val-changed':'') + '">' + escHtml(valDisplay) + '</td>'
             + '<td>' + wctrl + '</td>'
             + '<td><button class="cfg-btn" onclick="scToggleExtraDetails(' + sIdx + ",'" + t + "'," + io.ioIdx + ')">' + (showExtra?'&#9650;':'&#9660;') + '</button></td>'
             + '<td><button class="danger" onclick="scDeleteIO(' + sIdx + ",'" + t + "'," + io.ioIdx + ')">&#x2715;</button></td>'
             + '</tr>';

        if (showExtra) {
          out += '<tr class="detail-row"><td colspan="8"><div class="extra-card"><div class="extra-grid">' + extra + '</div></div></td></tr>';
        }
      });

      out += '</tbody></table></div></div>'; // close tbody, table, scroll-div, type-block
    }

    out += '</div>'; // close card
  });

  return out;
}

// ===== HARDWARE MODAL =====
function scShowHardware() {
  openFsModal('Hardware Config', `
    <div class="hw-form-grid">
      <div class="hw-section-title">Modbus RS-485</div>
      <label>Enabled</label>   <input type="checkbox" id="mb-enabled">
      <label>RX Pin</label>    <input type="number" id="mb-rx" inputmode="numeric">
      <label>TX Pin</label>    <input type="number" id="mb-tx" inputmode="numeric">
      <label>DE/RE Pin</label> <input type="number" id="mb-dere" inputmode="numeric">
      <label>Baud Rate</label> <input type="number" id="mb-baud" inputmode="numeric">
      <label>RTU Role</label>
      <select id="mb-rtu-role"><option value="master">Master</option><option value="slave">Slave</option></select>
      <div class="hw-section-title">I2C</div>
      <label>Enabled</label>   <input type="checkbox" id="i2c-enabled">
      <label>SDA Pin</label>   <input type="number" id="i2c-sda" inputmode="numeric">
      <label>SCL Pin</label>   <input type="number" id="i2c-scl" inputmode="numeric">
      <label>Frequency</label> <input type="number" id="i2c-freq" inputmode="numeric">
    </div>
    <pre class="log-box" id="hw-log"></pre>
    <div class="modal-actions">
      <button onclick="scSaveHw()">Save &amp; Apply</button>
      <button onclick="scLoadHw()">Reload</button>
      <button class="danger" onclick="closeFsModal()">Close</button>
    </div>
  `);
  scLoadHw();
}

function hwLog(msg) { const el=document.getElementById('hw-log'); if(el) el.textContent='['+new Date().toLocaleTimeString()+'] '+msg+'\n'+el.textContent; }

async function scLoadHw() {
  const d=await scFetch('/api/hw'); if(!d){hwLog('Load failed');return;}
  const id=s=>document.getElementById(s), m=d.modbus??{}, i=d.i2c??{};
  if(id('mb-enabled')) id('mb-enabled').checked=!!m.enabled;
  if(id('mb-rx'))      id('mb-rx').value=m.rxPin??16;
  if(id('mb-tx'))      id('mb-tx').value=m.txPin??17;
  if(id('mb-dere'))    id('mb-dere').value=m.deRePin??4;
  if(id('mb-baud'))    id('mb-baud').value=m.baudRate??9600;
  if(id('mb-rtu-role')) id('mb-rtu-role').value=m.rtuRole??'master';
  if(id('i2c-enabled')) id('i2c-enabled').checked=!!i.enabled;
  if(id('i2c-sda'))     id('i2c-sda').value=i.sdaPin??21;
  if(id('i2c-scl'))     id('i2c-scl').value=i.sclPin??22;
  if(id('i2c-freq'))    id('i2c-freq').value=i.freq??100000;
  hwLog('Loaded');
}

async function scSaveHw() {
  const id=s=>document.getElementById(s);
  const body={modbus:{enabled:id('mb-enabled')?.checked??false,rxPin:+id('mb-rx')?.value,txPin:+id('mb-tx')?.value,deRePin:+id('mb-dere')?.value,baudRate:+id('mb-baud')?.value,rtuRole:id('mb-rtu-role')?.value??'master'},i2c:{enabled:id('i2c-enabled')?.checked??false,sdaPin:+id('i2c-sda')?.value,sclPin:+id('i2c-scl')?.value,freq:+id('i2c-freq')?.value}};
  const r=await scFetch('/api/hw','POST',body); hwLog(r?.ok?'Saved OK':'Save failed');
}

// ===== MQTT MODAL =====
function scShowMQTT() {
  openFsModal('MQTT Config', `
    <div class="hw-form-grid">
      <div class="hw-section-title">Broker</div>
      <label>Enabled</label>       <input type="checkbox" id="mqtt-enabled">
      <label>Broker Host</label>   <input type="text" id="mqtt-broker" placeholder="broker.host">
      <label>Port</label>          <input type="number" id="mqtt-port" value="1883" inputmode="numeric">
      <label>Username</label>      <input type="text" id="mqtt-user" autocomplete="off">
      <label>Password</label>      <input type="password" id="mqtt-pass" autocomplete="off">
      <div class="hw-section-title">Publishing</div>
      <label>Heartbeat (s)</label> <input type="number" id="mqtt-hb" value="30" min="5" max="3600" inputmode="numeric">
    </div>
    <pre class="log-box" id="mqtt-log"></pre>
    <div class="modal-actions">
      <button onclick="scSaveMQTT()">Save &amp; Apply</button>
      <button onclick="scLoadMQTT()">Reload</button>
      <button class="danger" onclick="closeFsModal()">Close</button>
    </div>
  `);
  scLoadMQTT();
}

function mqttLog(msg) { const el=document.getElementById('mqtt-log'); if(el) el.textContent='['+new Date().toLocaleTimeString()+'] '+msg+'\n'+el.textContent; }

async function scLoadMQTT() {
  const d=await scFetch('/api/mqtt'); if(!d){mqttLog('Load failed');return;}
  const id=s=>document.getElementById(s);
  if(id('mqtt-enabled')) id('mqtt-enabled').checked=!!d.enabled;
  if(id('mqtt-broker'))  id('mqtt-broker').value=d.broker??'';
  if(id('mqtt-port'))    id('mqtt-port').value=d.port??1883;
  if(id('mqtt-user'))    id('mqtt-user').value=d.user??'';
  if(id('mqtt-hb'))      id('mqtt-hb').value=d.heartbeat??30;
  mqttLog('Loaded');
}

async function scSaveMQTT() {
  const id=s=>document.getElementById(s);
  const body={enabled:id('mqtt-enabled')?.checked??false,broker:id('mqtt-broker')?.value??'',port:+(id('mqtt-port')?.value??1883),user:id('mqtt-user')?.value??'',pass:id('mqtt-pass')?.value??'',heartbeat:+(id('mqtt-hb')?.value??30)};
  const r=await scFetch('/api/mqtt','POST',body); mqttLog(r?.ok?'Saved OK':'Save failed'); if(r?.ok&&id('mqtt-pass')) id('mqtt-pass').value='';
}
