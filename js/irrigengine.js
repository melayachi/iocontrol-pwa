// ===== IRRIGENGINE — irrigengine.js =====

const STATUS_NAMES = ['STOPPED','PENDING','RUNNING','PAUSED','FINISHED','ALARM','CANCELLED'];
const STATUS_CSS   = ['stopped','pending','running','paused','finished','alarm','cancelled'];

let ieState = { zones: [], systems: [] };
let ieEs = null;
let ieInited = false;

function ieApi(path) {
  const base = getDeviceUrl();
  return base ? base + path : null;
}

async function ieFetch(path, method = 'GET', body = null) {
  const url = ieApi(path);
  if (!url) return null;
  try {
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const txt = await r.text();
    try { return JSON.parse(txt); } catch { return { raw: txt }; }
  } catch { return null; }
}

function ieBadgeClass(status) { return 'badge badge-' + (STATUS_CSS[status] ?? 'stopped'); }
function ieStatusName(status) { return STATUS_NAMES[status] ?? 'UNKNOWN'; }

function ieSetLive(connected) {
  const el = document.getElementById('ie-live-dot');
  if (el) { el.className = 'dot ' + (connected ? 'dot-green' : 'dot-grey'); el.title = connected ? 'Live' : 'Offline'; }
}

function ieSetMqttDot(connected) {
  const el = document.getElementById('ie-mqtt-dot');
  if (el) { el.className = 'dot ' + (connected ? 'dot-green' : 'dot-grey'); el.title = 'MQTT ' + (connected ? 'connected' : 'disconnected'); }
}

function ieUpdateClock(ts) {
  const el = document.getElementById('ie-clock');
  if (el && ts) el.textContent = new Date(ts * 1000).toLocaleTimeString();
}

function ieZoneCardHtml(z, zi) {
  const statusName = ieStatusName(z.status);
  const badgeCls   = ieBadgeClass(z.status);
  return `
    <div class="ie-card" onclick="ieOpenZoneConfig(${zi})">
      <div><span class="ie-card-name">${escHtml(z.name)}</span></div>
      <div><span class="${badgeCls}">${statusName}</span></div>
      ${z.currentSchedule ? `<div class="ie-card-sub">${escHtml(z.currentSchedule)}</div>` : ''}
      <div class="ie-card-actions" onclick="event.stopPropagation()">
        <button onclick="ieZoneManual(${zi},1)">&#9654; Run</button>
        <button onclick="ieZoneManual(${zi},0)">&#9646;&#9646; Stop</button>
        <button onclick="ieZoneHistory(${zi})">History</button>
      </div>
    </div>`;
}

function ieSysCardHtml(s, si) {
  const statusName = ieStatusName(s.status);
  const badgeCls   = ieBadgeClass(s.status);
  return `
    <div class="ie-card" onclick="ieOpenSysConfig(${si})">
      <div><span class="ie-card-name">${escHtml(s.name)}</span></div>
      <div><span class="${badgeCls}">${statusName}</span></div>
      ${s.currentZone !== undefined ? `<div class="ie-card-sub">Zone: ${escHtml(String(s.currentZone))}</div>` : ''}
      <div class="ie-card-actions" onclick="event.stopPropagation()">
        <button onclick="ieSysManual(${si},1)">&#9654; Run</button>
        <button onclick="ieSysManual(${si},0)">&#9646;&#9646; Stop</button>
        <button onclick="ieSysHistory(${si})">History</button>
      </div>
    </div>`;
}

function ieRenderZones() {
  const grid = document.getElementById('ie-zones-grid');
  if (!grid) return;
  grid.innerHTML = ieState.zones.map((z, i) => ieZoneCardHtml(z, i)).join('') ||
    '<p class="muted">No zones configured.</p>';
}

function ieRenderSystems() {
  const grid = document.getElementById('ie-systems-grid');
  if (!grid) return;
  grid.innerHTML = ieState.systems.map((s, i) => ieSysCardHtml(s, i)).join('') ||
    '<p class="muted">No systems configured.</p>';
}

async function ieZoneManual(zi, run) { await ieFetch('/api/zones/' + zi + '/manual', 'POST', { run: !!run }); }
async function ieSysManual(si, run)  { await ieFetch('/api/systems/' + si + '/manual', 'POST', { run: !!run }); }

function ieConnectSSE() {
  const url = ieApi('/events');
  if (!url) { ieSetLive(false); return; }
  if (ieEs) { ieEs.close(); ieEs = null; }
  try {
    ieEs = new EventSource(url);
    ieEs.addEventListener('status', ev => {
      try {
        const data = JSON.parse(ev.data);
        ieState.zones   = data.zones   ?? [];
        ieState.systems = data.systems ?? [];
        ieRenderZones();
        ieRenderSystems();
        ieUpdateClock(data.ts);
        ieSetLive(true);
        if (data.mqtt) ieSetMqttDot(data.mqtt.connected);
      } catch {}
    });
    ieEs.onerror = () => ieSetLive(false);
  } catch { ieSetLive(false); }
}

function ieInit() {
  if (!getDeviceUrl()) {
    document.getElementById('ie-zones-grid').innerHTML = '<p class="muted">Configure device IP in Settings first.</p>';
    document.getElementById('ie-systems-grid').innerHTML = '';
    return;
  }
  if (!ieInited) { ieInited = true; ieConnectSSE(); }
}

// Stubs for Tasks 10 and 11 — replaced below
function ieOpenZoneConfig(zi) { openFsPanel('Zone Config', '<p class="muted" style="padding:14px">Loading...</p>'); ieLoadZoneConfig(zi); }
function ieOpenSysConfig(si)  { openFsPanel('System Config', '<p class="muted" style="padding:14px">Loading...</p>'); ieLoadSysConfig(si); }
function ieZoneHistory(zi)    { openFsPanel('Zone History', '<p class="muted" style="padding:14px">Loading...</p>'); ieFetch('/api/zones/'+zi+'/history').then(r=>{ const b=document.getElementById('fs-panel-body'); if(b) b.innerHTML=ieRenderHistory(r); }); }
function ieSysHistory(si)     { openFsPanel('System History', '<p class="muted" style="padding:14px">Loading...</p>'); ieFetch('/api/systems/'+si+'/history').then(r=>{ const b=document.getElementById('fs-panel-body'); if(b) b.innerHTML=ieRenderHistory(r); }); }
function ieShowWifi()         { openFsModal('Device Settings', '<p class="muted" style="padding:14px">Loading...</p>'); ieLoadWifiModal(); }

// ===== ZONE CONFIG (Task 10) =====
async function ieLoadZoneConfig(zi) {
  const z = await ieFetch('/api/zones/' + zi);
  if (!z) { const b=document.getElementById('fs-panel-body'); if(b) b.innerHTML='<p class="muted" style="padding:14px">Load failed.</p>'; return; }
  const body = `
    <div class="ie-tab-bar">
      <button class="ie-tab-btn active" onclick="ieZoneTab(${zi},this,'general')">General</button>
      <button class="ie-tab-btn" onclick="ieZoneTab(${zi},this,'schedule')">Schedule</button>
      <button class="ie-tab-btn" onclick="ieZoneTab(${zi},this,'outputs')">Outputs</button>
      <button class="ie-tab-btn" onclick="ieZoneTab(${zi},this,'sensors')">Sensors</button>
      <button class="ie-tab-btn" onclick="ieZoneTab(${zi},this,'conditions')">Conditions</button>
    </div>
    <div id="ie-zone-tab-body" style="padding:14px"></div>`;
  const panel = document.getElementById('fs-panel-body');
  if (panel) { panel.innerHTML = body; ieShowZoneGeneral(zi, z); }
}

function ieZoneTab(zi, btn, tab) {
  document.querySelectorAll('.ie-tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  if (tab === 'general') ieFetch('/api/zones/'+zi).then(z => z && ieShowZoneGeneral(zi, z));
  else { const b=document.getElementById('ie-zone-tab-body'); if(b) b.innerHTML='<p class="muted">'+tab.charAt(0).toUpperCase()+tab.slice(1)+' — configure via the device web UI at <a href="#" onclick="openOriginalUI(\'irrigengine\')" style="color:var(--accent)">'+ieApi('/')+' &#8599;</a></p>'; }
}

function ieShowZoneGeneral(zi, z) {
  const b = document.getElementById('ie-zone-tab-body');
  if (!b) return;
  b.innerHTML = `
    <div class="form-row"><label>Zone Name</label><input type="text" id="z-name" value="${escHtml(z.name ?? '')}"></div>
    <div class="form-row"><label>Control Mode</label><select id="z-mode">
      <option value="0" ${z.mode===0?'selected':''}>TIME</option>
      <option value="1" ${z.mode===1?'selected':''}>HUMIDITY</option>
      <option value="2" ${z.mode===2?'selected':''}>INTERVAL</option>
    </select></div>
    <div class="modal-actions"><button onclick="ieSaveZoneGeneral(${zi})">Save</button></div>`;
}

async function ieSaveZoneGeneral(zi) {
  const r = await ieFetch('/api/zones/'+zi, 'POST', { name: document.getElementById('z-name')?.value??'', mode: +(document.getElementById('z-mode')?.value??0) });
  if (r?.ok !== false) { const b=document.getElementById('ie-zone-tab-body'); if(b){ const msg=document.createElement('p'); msg.className='muted'; msg.textContent='Saved.'; b.appendChild(msg); setTimeout(()=>msg.remove(),2000); } }
}

// ===== SYSTEM CONFIG (Task 10) =====
async function ieLoadSysConfig(si) {
  const s = await ieFetch('/api/systems/' + si);
  if (!s) { const b=document.getElementById('fs-panel-body'); if(b) b.innerHTML='<p class="muted" style="padding:14px">Load failed.</p>'; return; }
  const body = `
    <div class="ie-tab-bar">
      <button class="ie-tab-btn active" onclick="ieSysTab(${si},this,'general')">General</button>
      <button class="ie-tab-btn" onclick="ieSysTab(${si},this,'schedule')">Schedule</button>
    </div>
    <div id="ie-sys-tab-body" style="padding:14px"></div>`;
  const panel = document.getElementById('fs-panel-body');
  if (panel) { panel.innerHTML = body; ieShowSysGeneral(si, s); }
}

function ieSysTab(si, btn, tab) {
  document.querySelectorAll('.ie-tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  if (tab === 'general') ieFetch('/api/systems/'+si).then(s => s && ieShowSysGeneral(si, s));
  else { const b=document.getElementById('ie-sys-tab-body'); if(b) b.innerHTML='<p class="muted">'+tab.charAt(0).toUpperCase()+tab.slice(1)+' — configure via the device web UI at <a href="#" onclick="openOriginalUI(\'irrigengine\')" style="color:var(--accent)">'+ieApi('/')+' &#8599;</a></p>'; }
}

function ieShowSysGeneral(si, s) {
  const b = document.getElementById('ie-sys-tab-body');
  if (!b) return;
  b.innerHTML = `
    <div class="form-row"><label>System Name</label><input type="text" id="sys-name" value="${escHtml(s.name ?? '')}"></div>
    <div class="modal-actions"><button onclick="ieSaveSysGeneral(${si})">Save</button></div>`;
}

async function ieSaveSysGeneral(si) {
  await ieFetch('/api/systems/'+si, 'POST', { name: document.getElementById('sys-name')?.value??'' });
}

// ===== WIFI / SYSTEM SETTINGS (Task 10) =====
async function ieLoadWifiModal() {
  openFsModal('Device Settings', `
    <div class="form-row"><label>WiFi Status</label><p class="muted" id="ie-wifi-status">Loading...</p></div>
    <div class="form-row"><label>New SSID</label><input type="text" id="ie-new-ssid"></div>
    <div class="form-row"><label>New Password</label><input type="password" id="ie-new-pass"></div>
    <div class="modal-actions">
      <button onclick="ieSaveWifi()">Save &amp; Restart</button>
      <button class="danger" onclick="ieClearWifi()">Forget WiFi</button>
    </div>
    <hr style="margin:14px 0;border:none;border-top:1px solid var(--border)">
    <div class="form-row"><label>Zone Count (1–16)</label><input type="number" id="ie-cfg-zones" min="1" max="16" inputmode="numeric"></div>
    <div class="form-row"><label>System Count (1–8)</label><input type="number" id="ie-cfg-systems" min="1" max="8" inputmode="numeric"></div>
    <div class="form-row"><label>Max Concurrent Zones</label><input type="number" id="ie-cfg-maxopen" min="1" max="16" inputmode="numeric"></div>
    <div class="modal-actions">
      <button onclick="ieSaveCfg()">Save Config</button>
      <button class="danger" onclick="closeFsModal()">Close</button>
    </div>
  `);
  const [wifi, cfg] = await Promise.all([ieFetch('/api/wifi'), ieFetch('/api/config')]);
  const el = id => document.getElementById(id);
  if (el('ie-wifi-status')) el('ie-wifi-status').textContent = wifi ? (wifi.ssid ?? 'Not connected') : 'Load failed';
  if (cfg) {
    if (el('ie-cfg-zones'))   el('ie-cfg-zones').value   = cfg.zones   ?? 8;
    if (el('ie-cfg-systems')) el('ie-cfg-systems').value = cfg.systems  ?? 4;
    if (el('ie-cfg-maxopen')) el('ie-cfg-maxopen').value = cfg.maxOpen  ?? 2;
  }
}

async function ieSaveWifi() {
  const ssid=document.getElementById('ie-new-ssid')?.value.trim()??'';
  const pass=document.getElementById('ie-new-pass')?.value??'';
  if (!ssid) return;
  await ieFetch('/api/wifi','POST',{ssid,pass});
}

async function ieClearWifi() {
  if (!confirm('Forget WiFi and restart in AP mode?')) return;
  await ieFetch('/api/wifi','DELETE');
}

async function ieSaveCfg() {
  const el=id=>document.getElementById(id);
  await ieFetch('/api/config','POST',{zones:+(el('ie-cfg-zones')?.value??8),systems:+(el('ie-cfg-systems')?.value??4),maxOpen:+(el('ie-cfg-maxopen')?.value??2)});
}

// ===== RUN HISTORY (Task 11) =====
function fmtTs(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
}

function fmtDur(secs) {
  if (!secs && secs !== 0) return '—';
  if (secs < 60) return secs + 's';
  return Math.floor(secs/60)+'m '+(secs%60)+'s';
}

function ieRenderHistory(records) {
  if (!Array.isArray(records) || !records.length)
    return '<p class="muted" style="margin-top:10px">No history recorded yet.</p>';
  return '<div class="history-list">' +
    records.map(r => `
      <div class="history-item">
        <div>
          <div class="history-dt">${fmtTs(r.startTs)}</div>
          <div class="history-reason">${escHtml(r.schedName ?? '—')}</div>
        </div>
        <div class="history-dur">${fmtDur(r.duration)}</div>
      </div>`).join('') +
    '</div>';
}
