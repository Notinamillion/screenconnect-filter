// ScreenConnect Filter — filters ScreenConnect's OWN machine list. Runs in the
// page (world: MAIN) and wraps SC.service.GetLiveData, which SC.livedata's
// refresh loop calls every ~2s; matching sessions pass through, the rest are
// dropped, and ScreenConnect renders what's left as normal (clickable rows).
// Software filter reads the list the built-in Software tab (Remote Diagnostic
// Toolkit) stores on each session; "Scan" queues that same toolkit command.
// Wrapped in an IIFE: this runs in the page's global scope, and top-level
// names (e.g. $) would clobber ScreenConnect's own globals.
(() => {
// Your instance's top-level session group (the first group in the Access sidebar). Change to match yours.
const ROOT = 'All Machines by Site';
const NEVER = -1e300; // ScreenConnect uses -Double.MaxValue for "never"
const SW_MAX = 1000; // ponytail: software lookups capped per refresh; narrow the view (site/filters) for more
const SCAN_MAX = 500; // ponytail: max machines per Scan click, keeps the blast radius sane
const f = { kind: '', os: '', status: '', off: NaN, sw: '', cmd: '', chk: '' };
const active = () => !!(f.kind || f.os || f.status || f.off >= 0 || f.sw || (f.cmd && f.chk));

const kind = (os) =>
  !os ? 'Unknown' : /server/i.test(os) ? 'Server' : /mac/i.test(os) ? 'Mac'
  : /linux|ubuntu|debian|centos|red hat/i.test(os) ? 'Linux' : 'Desktop';
const isOnline = (s) => (s.ActiveConnections || []).some((c) => c.ProcessType === 2);

function match(s) {
  const os = s.GuestOperatingSystemName || '';
  const online = isOnline(s);
  const gone = s.LastGuestDisconnectedEventTime; // seconds ago
  const offDays = online ? 0 : gone > NEVER ? gone / 86400 : Infinity;
  return (!f.kind || kind(os) === f.kind) && (!f.os || os === f.os) &&
    (!f.status || (f.status === 'on') === online) && (!(f.off >= 0) || offDays > f.off);
}

const post = async (method, body, headers = {}) => {
  const res = await fetch(`/Services/PageService.ashx/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Unauthorized-Status-Code': '403', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${res.status}`);
  return res.json();
};

const liveSessions = async (path, filter) => (await post('GetLiveData', [{ HostSessionInfo: {
  sessionType: 2, sessionGroupPathParts: path, filter, findSessionID: null, sessionLimit: 100000 } }, 0]))
  .ResponseInfoMap.HostSessionInfo.Sessions.filter((s) => s.Name);

// Newest command output (RanCommand, event 70) on a machine matching re, run through
// parse(match); null = none yet. Found results are kept, misses re-checked after 30s.
const outCache = new Map();
async function lastOutput(key, id, re, parse) {
  const k = key + '|' + id, hit = outCache.get(k);
  if (hit && (hit.val !== null || Date.now() - hit.at < 30000)) return hit.val;
  const d = await post('GetSessionDetails', [[ROOT], id, 29]);
  // Event Time is ms-ago, so the smallest is the newest
  const ev = (d.Events || []).filter((e) => e.EventType === 70 && re.test(e.Data || '')).sort((a, b) => a.Time - b.Time)[0];
  const val = ev ? parse(ev.Data.match(re)) : null;
  outCache.set(k, { at: Date.now(), val });
  return val;
}

// Software list ("name\nvendor..." lowercased) from the Software tab's inventory.
const software = (id) => lastOutput('sw', id, /^DIAGNOSTIC-RESPONSE\/2\s+Command: GetSoftware[\s\S]*/,
  ([data]) => [...data.matchAll(/<Property Name="(?:Name|Vendor)"[^>]*>([^<]*)</g)].map((m) => m[1]).join('\n').toLowerCase());

// Custom check: output is our marker line, then True/False. The marker carries a hash
// of the command, so changing the command never reads an older command's answers.
const hash = (t) => [...t].reduce((h, c) => (h * 33 + c.charCodeAt(0)) >>> 0, 5381).toString(36);
const marker = () => 'SCFCHECK:' + hash(f.cmd);
const check = (id) => lastOutput(marker(), id, new RegExp(marker() + '\\s+(True|False)\\b', 'i'), (m) => /true/i.test(m[1]));

// Keep machines whose looked-up value passes keep(); value null = no result yet.
async function narrow(list, what, lookup, keep) {
  const todo = list.slice(0, SW_MAX);
  let i = 0, done = 0, none = 0;
  const hits = new Set();
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (i < todo.length) {
      const s = todo[i++];
      const v = await lookup(s.SessionID).catch(() => null);
      if (v === null) none++;
      if (keep(v)) hits.add(s);
      if (++done % 25 === 0) status(`Checking ${what}… ${done}/${todo.length}`);
    }
  }));
  status(`${hits.size} match ${what} · ${none} no result yet` + (list.length > SW_MAX ? ` · only first ${SW_MAX} checked` : ''));
  return todo.filter((s) => hits.has(s));
}

// SC.service may not exist yet when this runs; wait for it rather than throw
// (a throw here used to kill the script before the Filter button was added).
const hook = () => {
if (!(window.SC && SC.service && SC.service.GetLiveData)) return setTimeout(hook, 250);
const original = SC.service.GetLiveData;
SC.service.GetLiveData = function (map, version, onSuccess, ...rest) {
  const req = map && map.HostSessionInfo;
  if (!req || !active()) return original.call(this, map, version, onSuccess, ...rest);
  // Fetch everything so the filter sees the whole estate, then hand the page
  // back no more rows than it originally asked for.
  const limit = req.sessionLimit;
  map.HostSessionInfo = { ...req, sessionLimit: 100000 };
  return original.call(this, map, version, async (result) => {
    try {
      const info = result && result.ResponseInfoMap && result.ResponseInfoMap.HostSessionInfo;
      if (info && info.Sessions) {
        let list = info.Sessions.filter(match);
        if (f.sw) list = await narrow(list, `software "${f.sw}"`, software, (t) => t !== null && t.includes(f.sw));
        if (f.cmd && f.chk) list = await narrow(list, `check = ${f.chk}`, check,
          (v) => (f.chk === 'none' ? v === null : v === (f.chk === 'True')));
        info.Sessions = list.slice(0, limit || Infinity);
      }
    } finally { onSuccess(result); }
  }, ...rest);
};
};
hook();

// Exactly what the Software tab queues (built-in Remote Diagnostic Toolkit,
// "GetSoftware/Windows"), so results show in that tab and in our filter.
const GET_SOFTWARE = "$registryPath = if ([Environment]::Is64BitOperatingSystem) { 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' } else { 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' } Get-ItemProperty $registryPath | Where-Object{![string]::IsNullOrEmpty($_.DisplayName)} | Select @{N='IdentifyingNumber';E={$_.PSChildName}}, @{N='Name';E={$_.DisplayName}}, @{N='Vendor';E={$_.Publisher}}, @{N='Version';E={$_.DisplayVersion}}, @{N='UninstallString';E={$_.UninstallString}}, @{N='Install Date';E={If ($_.InstallDate) { [datetime]::ParseExact($_.InstallDate, 'yyyyMMdd', $null).ToString('yyyy-MM-dd') } Else { $null }}}, @{N='UnavailableCommands';E={$(If (![string]::IsNullOrEmpty($_.UninstallString) -and $_.UninstallString.ToLower() -like 'msiexec*') {''} Else {'|UninstallSoftware|'})}} | Sort 'Name' | ConvertTo-Xml -As Stream";
const SCAN_DATA = ['#!ps', '#maxlength=50000000', '#timeout=900000', '#DIAGNOSTIC-REQUEST/2', '#Command: GetSoftware',
  '#CommandKeyIndices: ', '#CommandKey: ', '#AvailableCommands: ', '#InvalidatesCommand: ', '#HiddenColumnIndices: ',
  'echo "DIAGNOSTIC-RESPONSE/2"', 'echo "Command: GetSoftware"', 'echo "CommandKeyIndices: "', 'echo "CommandKey: "',
  'echo "ContentType: xml"', 'echo "AvailableCommands: UninstallSoftware"', 'echo "InvalidatesCommand: "',
  'echo "HiddenColumnIndices: 0,4,6"', 'echo ""', GET_SOFTWARE].join('\n');

// Queue a command on the online Windows machines in the view the user is looking at:
// current group + search box + our basic filters (not software/check). Returns the batch.
async function runOnView(what, data) {
  const all = await liveSessions(window.getSessionGroupUrlPart().length ? window.getSessionGroupUrlPart() : [ROOT], window.getSearchUrlPart() || '');
  const targets = all.filter((s) => match(s) && isOnline(s) && /windows/i.test(s.GuestOperatingSystemName || ''));
  if (!targets.length) return status('No online Windows machines in this view.');
  const n = Math.min(targets.length, SCAN_MAX);
  if (!confirm(`Run ${what} on ${n} online Windows machine(s)` +
    (targets.length > SCAN_MAX ? ` (first ${SCAN_MAX} of ${targets.length})` : '') + '?')) return;
  const batch = targets.slice(0, n);
  for (let i = 0; i < batch.length; i += 50) {
    await post('AddSessionEvents', [[ROOT], batch.slice(i, i + 50).map((s) => ({ SessionID: s.SessionID, EventType: 44, Data: data }))],
      { 'X-Anti-Forgery-Token': SC.context.antiForgeryToken });
    status(`Queued ${Math.min(i + 50, n)}/${n}…`);
  }
  status(`Queued ${n}. Results arrive over the next minute or two; the filter re-checks automatically.`);
  return batch;
}

async function scan() {
  const batch = await runOnView("ScreenConnect's Software inventory (the Software tab's PowerShell)", SCAN_DATA);
  (batch || []).forEach((s) => outCache.delete('sw|' + s.SessionID));
}

async function runCheck() {
  apply();
  if (!f.cmd) return status('Type a PowerShell check first, e.g. [bool](Get-Process notepad -ErrorAction SilentlyContinue)');
  // Our marker line first, then the check; its True/False lands on the next line of output.
  const data = ['#!ps', '#timeout=120000', '#maxlength=100000', `'${marker()}'`, f.cmd].join('\n');
  const batch = await runOnView(`this check:\n\n${f.cmd}\n\n`, data);
  (batch || []).forEach((s) => outCache.delete(marker() + '|' + s.SessionID));
}

const host = document.createElement('div');
const ui = host.attachShadow({ mode: 'open' });
ui.innerHTML = `
<style>
  * { font: 13px Segoe UI, sans-serif; }
  #btn { position: fixed; right: 16px; bottom: 16px; z-index: 99999; padding: 8px 14px;
    background: #444; color: #fff; border: 0; border-radius: 6px; cursor: pointer; }
  #btn.on { background: #e76f51; }
  #panel { position: fixed; right: 16px; bottom: 60px; z-index: 99999; display: none; gap: 6px;
    flex-wrap: wrap; align-items: center; max-width: calc(100vw - 32px); padding: 10px;
    background: #1b2229; color: #ddd; border: 1px solid #444; border-radius: 8px; box-shadow: 0 8px 30px #0008; }
  #panel.open { display: flex; }
  input, select, button { background: #0f1418; color: #ddd; border: 1px solid #444; border-radius: 4px; padding: 4px 6px; }
  #off { width: 60px; }
  #os { max-width: 260px; }
  #cmd { flex: 1 1 360px; font: 12px Consolas, monospace; }
  #msg { flex-basis: 100%; color: #aaa; }
  #msg:empty { display: none; }
</style>
<button id="btn">Filter</button>
<div id="panel">
  <select id="kind"><option value="">All types</option><option>Server</option><option>Desktop</option>
    <option>Mac</option><option>Linux</option><option>Unknown</option></select>
  <select id="os"><option value="">All OS</option></select>
  <select id="status"><option value="">Any status</option><option value="on">Online</option><option value="off">Offline</option></select>
  <label>Offline &gt; <input id="off" type="number" min="0" placeholder="days"></label>
  <input id="sw" placeholder="Software contains… (Enter)">
  <button id="scan" title="Run the Software tab's inventory on online Windows machines in this view">Scan software</button>
  <input id="cmd" placeholder="PowerShell check that outputs True/False">
  <button id="run" title="Run the check on online Windows machines in this view">Run check</button>
  <select id="chk"><option value="">Check: off</option><option>True</option><option>False</option><option value="none">No result</option></select>
  <button id="clear">Clear</button>
  <div id="msg"></div>
</div>`;
document.body.append(host);
// Stop ScreenConnect's global type-to-search handler stealing our keystrokes.
['keydown', 'keypress', 'keyup'].forEach((t) => host.addEventListener(t, (e) => e.stopPropagation()));
const $ = (id) => ui.getElementById(id);
const status = (t) => ($('msg').textContent = t);

function apply() {
  f.kind = $('kind').value; f.os = $('os').value; f.status = $('status').value;
  f.off = parseFloat($('off').value); f.sw = $('sw').value.trim().toLowerCase();
  f.cmd = $('cmd').value.trim(); f.chk = $('chk').value;
  $('btn').textContent = active() ? 'Filter (on)' : 'Filter';
  $('btn').classList.toggle('on', active());
  if (!f.sw && !(f.cmd && f.chk)) status('');
  SC.livedata.notifyDirty(window._dirtyLevels.SessionList); // forces a full (version 0) refresh through our wrapper
}

// OS dropdown: one read of every machine, just to list the distinct OS names.
async function loadOsList() {
  const oses = [...new Set((await liveSessions([ROOT], '')).map((s) => s.GuestOperatingSystemName).filter(Boolean))].sort();
  $('os').innerHTML = '<option value="">All OS</option>' + oses.map((o) => `<option>${o.replace(/</g, '&lt;')}</option>`).join('');
}

$('btn').onclick = () => {
  $('panel').classList.toggle('open');
  if ($('os').options.length === 1) loadOsList().catch(() => {});
};
$('clear').onclick = () => { ['kind', 'os', 'status', 'off', 'sw', 'chk'].forEach((id) => ($(id).value = '')); apply(); };
$('scan').onclick = () => scan().catch((e) => status(`Scan failed: ${e.message}`));
$('run').onclick = () => runCheck().catch((e) => status(`Check failed: ${e.message}`));
['kind', 'os', 'status', 'off', 'sw', 'cmd', 'chk'].forEach((id) => $(id).addEventListener('change', apply));
})();
