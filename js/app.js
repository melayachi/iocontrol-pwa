const TABS = ['scanner', 'irrigengine', 'settings'];

function switchTab(name) {
  TABS.forEach(t => {
    document.getElementById('tab-' + t).classList.toggle('active', t === name);
    document.getElementById('nav-' + t).classList.toggle('active', t === name);
  });
  if (name === 'settings') renderSettings();
  if (name === 'scanner')  scInit();
  if (name === 'irrigengine') ieInit();
  localStorage.setItem('lastTab', name);
}

function setTheme(theme) {
  document.body.classList.toggle('theme-dark',  theme === 'dark');
  document.body.classList.toggle('theme-light', theme === 'light');
  localStorage.setItem('theme', theme);
  document.querySelectorAll('.theme-toggle button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  });
}

function getTheme() { return localStorage.getItem('theme') || 'dark'; }

function escHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function openFsPanel(title, bodyHtml) {
  document.getElementById('fs-panel-title').textContent = title;
  document.getElementById('fs-panel-body').innerHTML = bodyHtml;
  document.getElementById('fs-overlay').classList.remove('hidden');
  requestAnimationFrame(() => {
    document.getElementById('fs-panel').classList.remove('hidden');
    requestAnimationFrame(() => document.getElementById('fs-panel').classList.add('open'));
  });
}

function closeFsPanel() {
  const p = document.getElementById('fs-panel');
  p.classList.remove('open');
  setTimeout(() => {
    p.classList.add('hidden');
    document.getElementById('fs-overlay').classList.add('hidden');
  }, 260);
}

function openFsModal(title, bodyHtml) {
  document.getElementById('fs-modal-title').textContent = title;
  document.getElementById('fs-modal-body').innerHTML = bodyHtml;
  document.getElementById('fs-modal').classList.remove('hidden');
}

function closeFsModal() { document.getElementById('fs-modal').classList.add('hidden'); }
function closeFsOverlay() { closeFsPanel(); }

document.addEventListener('DOMContentLoaded', () => {
  setTheme(getTheme());
  switchTab(localStorage.getItem('lastTab') || 'scanner');
});
