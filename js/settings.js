function getDeviceUrl() {
  const mode = localStorage.getItem('netMode') || 'local';
  const ip   = localStorage.getItem(mode === 'local' ? 'localIp' : 'remoteIp') || '';
  if (!ip) return null;
  return 'http://' + ip;
}

function saveSettings() {
  localStorage.setItem('localIp',  document.getElementById('s-local-ip').value.trim());
  localStorage.setItem('remoteIp', document.getElementById('s-remote-ip').value.trim());
}

function loadSettings() {
  const el = id => document.getElementById(id);
  if (el('s-local-ip'))  el('s-local-ip').value  = localStorage.getItem('localIp')  || '';
  if (el('s-remote-ip')) el('s-remote-ip').value = localStorage.getItem('remoteIp') || '';
  setNetMode(localStorage.getItem('netMode') || 'local', false);
}

function setNetMode(mode, save) {
  if (save !== false) localStorage.setItem('netMode', mode);
  document.querySelectorAll('.net-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
}

async function testConnection() {
  const url = getDeviceUrl();
  const el = document.getElementById('s-conn-status');
  if (!url) { el.textContent = 'No IP configured'; return; }
  el.textContent = 'Testing...';
  try {
    const r = await fetch(url + '/api/zones', { signal: AbortSignal.timeout(4000) });
    el.innerHTML = r.ok
      ? '<span class="dot dot-green" style="display:inline-block"></span> Connected (' + r.status + ')'
      : '<span class="dot dot-orange" style="display:inline-block"></span> HTTP ' + r.status;
  } catch {
    el.innerHTML = '<span class="dot dot-grey" style="display:inline-block"></span> Unreachable';
  }
}

function renderSettings() {
  const mode = localStorage.getItem('netMode') || 'local';
  document.getElementById('settings-body').innerHTML = `
    <div class="settings-section">
      <h3>Appearance</h3>
      <div class="theme-toggle">
        <button data-theme="dark"  onclick="setTheme('dark')"  class="${getTheme()==='dark'?'active':''}">Dark</button>
        <button data-theme="light" onclick="setTheme('light')" class="${getTheme()==='light'?'active':''}">Light</button>
      </div>
    </div>
    <div class="settings-section">
      <h3>Device Connection</h3>
      <div class="form-row">
        <label>Local IP Address</label>
        <input type="text" id="s-local-ip" placeholder="192.168.1.100" inputmode="url" onchange="saveSettings()">
      </div>
      <div class="form-row">
        <label>Remote IP / Hostname (optional)</label>
        <input type="text" id="s-remote-ip" placeholder="mysite.duckdns.org" inputmode="url" onchange="saveSettings()">
      </div>
      <div class="form-row">
        <label>Active Network</label>
        <div class="theme-toggle">
          <button class="net-mode-btn ${mode==='local'?'active':''}" data-mode="local"
                  onclick="setNetMode('local');renderSettings()">Local</button>
          <button class="net-mode-btn ${mode==='remote'?'active':''}" data-mode="remote"
                  onclick="setNetMode('remote');renderSettings()">Remote</button>
        </div>
      </div>
      <button onclick="testConnection()">Test Connection</button>
      <div class="conn-status" id="s-conn-status"></div>
    </div>
    <div class="settings-section">
      <h3>About</h3>
      <p class="muted" style="margin-bottom:8px">IOControl v1.0</p>
      <p class="muted"><a href="#" onclick="openOriginalUI('scanner')" style="color:var(--accent)">Open IOScanner web UI &#8599;</a></p>
      <p class="muted" style="margin-top:4px"><a href="#" onclick="openOriginalUI('irrigengine')" style="color:var(--accent)">Open IrrigEngine web UI &#8599;</a></p>
    </div>
  `;
  loadSettings();
}

function openOriginalUI(which) {
  const url = getDeviceUrl();
  if (!url) { alert('Configure device IP in Settings first.'); return; }
  window.open(url + (which === 'scanner' ? '/Scanner/dashboard.html' : '/'), '_blank');
}
