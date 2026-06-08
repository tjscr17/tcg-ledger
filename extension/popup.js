// Popup UI controller. Persists settings to chrome.storage.local; relays
// the Sync button to the background service worker and listens for progress.

const $ = (id) => document.getElementById(id);

const ui = {
  supabaseUrl: $('supabaseUrl'),
  supabaseKey: $('supabaseKey'),
  vaultKey: $('vaultKey'),
  saveBtn: $('saveBtn'),
  syncBtn: $('syncBtn'),
  status: $('status'),
  progressBar: $('progressBar'),
  settingsStatus: $('settingsStatus'),
};

async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) return;
  ui.supabaseUrl.value = settings.supabaseUrl || '';
  ui.supabaseKey.value = settings.supabaseKey || '';
  ui.vaultKey.value = settings.vaultKey || '';
}

async function saveSettings() {
  const settings = {
    supabaseUrl: ui.supabaseUrl.value.trim().replace(/\/$/, ''),
    supabaseKey: ui.supabaseKey.value.trim(),
    vaultKey: ui.vaultKey.value.trim(),
  };
  if (!settings.supabaseUrl || !settings.supabaseKey || !settings.vaultKey) {
    ui.settingsStatus.textContent = 'All three fields required.';
    return;
  }
  await chrome.storage.local.set({ settings });
  ui.settingsStatus.textContent = 'Saved.';
  setTimeout(() => { ui.settingsStatus.textContent = ''; }, 1500);
}

function setStatus(text, kind = '') {
  ui.status.className = 'status' + (kind ? ' ' + kind : '');
  ui.status.textContent = text;
}

function setProgress(done, total) {
  const pct = total > 0 ? (done / total) * 100 : 0;
  ui.progressBar.style.width = `${pct}%`;
}

async function runSync() {
  ui.syncBtn.disabled = true;
  setStatus('Starting sync — pulling your entries from Supabase…');
  setProgress(0, 1);
  try {
    const result = await chrome.runtime.sendMessage({ type: 'RUN_SYNC' });
    if (!result?.ok) {
      throw new Error(result?.error || 'Unknown error');
    }
    const { inserted, errors } = result.result;
    if (errors.length > 0) {
      setStatus(
        `Inserted ${inserted} sales. ${errors.length} cards failed — open the extension's background console (chrome://extensions → details → service worker → Inspect) to see why.`,
        'good'
      );
    } else {
      setStatus(`Inserted ${inserted} sales. All cards processed cleanly.`, 'good');
    }
  } catch (e) {
    setStatus(`Sync failed: ${e.message || e}`, 'bad');
  } finally {
    ui.syncBtn.disabled = false;
  }
}

// Listen for live progress from the background worker.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'SYNC_PROGRESS') return;
  const p = message.payload;
  if (p.phase === 'started') {
    setStatus(`Syncing 0/${p.total} cards…`);
    setProgress(0, p.total);
  } else if (p.phase === 'progress') {
    setStatus(`Synced ${p.done}/${p.total} cards · ${p.inserted} sales inserted · current: ${p.current}`);
    setProgress(p.done, p.total);
  } else if (p.phase === 'done') {
    // Final state is handled by the runSync() resolution path; this is just a
    // backstop in case the popup re-opened mid-flight.
    setProgress(p.done, p.total);
  }
});

ui.saveBtn.addEventListener('click', saveSettings);
ui.syncBtn.addEventListener('click', runSync);

loadSettings();
