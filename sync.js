// GitHub state-branch sync
// 数据流：本地变更 → debounce 2s → PUT /repos/{owner}/{repo}/contents/state.json
// 加载流：GET 远端 → 时间戳新于本地则替换本地 state
// 安全：PAT 仅存 localStorage，never committed；建议用 fine-grained token 限定到 Luluda/seed
'use strict';

const SYNC_KEY = 'mb-checklist-sync-v1';
const DEVICE_KEY = 'mb-device-id';

const sync = {
  cfg: {
    enabled: false,
    token: '',
    owner: 'Luluda',
    repo: 'seed',
    branch: 'state',
    path: 'state.json',
  },
  sha: null,
  lastSyncAt: null,
  status: 'idle',   // idle | syncing | synced | error | offline | disabled
  message: '',
  listeners: [],
  _timer: null,
};

// --- 持久化配置（不含 sha/lastSyncAt） ---
try {
  const s = localStorage.getItem(SYNC_KEY);
  if (s) {
    const d = JSON.parse(s);
    Object.assign(sync.cfg, d.cfg || {});
    sync.sha = d.sha || null;
    sync.lastSyncAt = d.lastSyncAt || null;
  }
} catch(e){}

function saveSyncConfig(){
  localStorage.setItem(SYNC_KEY, JSON.stringify({
    cfg: sync.cfg,
    sha: sync.sha,
    lastSyncAt: sync.lastSyncAt,
  }));
}

function deviceId(){
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = 'dev-' + Math.random().toString(36).slice(2, 10);
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

function setStatus(s, msg){
  sync.status = s;
  sync.message = msg || '';
  sync.listeners.forEach(fn => fn());
}

function onStatusChange(fn){ sync.listeners.push(fn); }

// --- base64 (utf-8 safe) ---
function b64encode(str){
  return btoa(unescape(encodeURIComponent(str)));
}
function b64decode(b64){
  return decodeURIComponent(escape(atob(b64.replace(/\n/g, ''))));
}

// --- GitHub API ---
async function ghFetch(method, path, body){
  if (!sync.cfg.token) throw new Error('no token');
  const url = 'https://api.github.com' + path;
  const headers = {
    'Authorization': 'Bearer ' + sync.cfg.token,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

async function ensureBranch(){
  const { owner, repo, branch } = sync.cfg;
  let res = await ghFetch('GET', `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`);
  if (res.ok) return;
  if (res.status !== 404) {
    throw new Error('check branch: ' + res.status + ' ' + (await res.text()));
  }
  // 从 main 派生
  res = await ghFetch('GET', `/repos/${owner}/${repo}/git/refs/heads/main`);
  if (!res.ok) throw new Error('main not found: ' + res.status);
  const main = await res.json();
  res = await ghFetch('POST', `/repos/${owner}/${repo}/git/refs`, {
    ref: 'refs/heads/' + branch,
    sha: main.object.sha,
  });
  if (!res.ok) throw new Error('create branch: ' + res.status + ' ' + (await res.text()));
}

// 测试连接：能 GET 到仓库元数据即认为通过
async function testConnection(){
  const { owner, repo } = sync.cfg;
  const res = await ghFetch('GET', `/repos/${owner}/${repo}`);
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = j.message || ''; } catch(e){}
    throw new Error(`HTTP ${res.status}${detail ? ': ' + detail : ''}`);
  }
  const j = await res.json();
  return { ok: true, fullName: j.full_name, private: j.private };
}

// snapshot — 由调用方传入要保存的对象
function makeSnapshot(extra){
  return Object.assign({
    version: 1,
    updatedAt: new Date().toISOString(),
    deviceId: deviceId(),
  }, extra);
}

// 拉取远端；若有更新则合并到本地（merge 由 onPullApply 回调决定）
async function pull(onPullApply){
  if (!sync.cfg.enabled || !sync.cfg.token) { setStatus('disabled', '未启用'); return; }
  setStatus('syncing', '拉取远端…');
  try {
    const { owner, repo, branch, path } = sync.cfg;
    let res = await ghFetch('GET', `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`);
    if (res.status === 404) {
      // 远端尚无文件，先把本地推上去
      setStatus('syncing', '远端首次同步…');
      sync.sha = null;
      return 'empty';
    }
    if (!res.ok) {
      let m = ''; try { const j = await res.json(); m = j.message || ''; } catch(e){}
      throw new Error(`HTTP ${res.status}${m ? ': ' + m : ''}`);
    }
    const j = await res.json();
    sync.sha = j.sha;
    const remote = JSON.parse(b64decode(j.content));
    // 时间戳比较：远端 > 本地最近同步时间 → 应用
    const localTs = sync.lastSyncAt || '';
    let applied = false;
    if (!remote.updatedAt || remote.updatedAt > localTs) {
      onPullApply && onPullApply(remote);
      applied = true;
    }
    sync.lastSyncAt = remote.updatedAt;
    saveSyncConfig();
    setStatus('synced', applied ? '已拉取远端更新' : '已是最新');
    return applied ? 'applied' : 'skipped';
  } catch (e) {
    setStatus('error', e.message);
    throw e;
  }
}

// 上传（PUT contents），自带冲突重试
async function push(snapshotProvider){
  if (!sync.cfg.enabled || !sync.cfg.token) { setStatus('disabled', '未启用'); return; }
  setStatus('syncing', '上传中…');
  try {
    await ensureBranch();
    const snap = snapshotProvider();
    const json = JSON.stringify(snap, null, 2);
    const { owner, repo, branch, path } = sync.cfg;
    const body = {
      message: `state: ${snap.updatedAt} (${snap.deviceId})`,
      content: b64encode(json),
      branch,
    };
    if (sync.sha) body.sha = sync.sha;
    let res = await ghFetch('PUT', `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, body);
    if (res.status === 409 || res.status === 422) {
      // sha 冲突：拉一次最新 sha 再重试一次
      const r = await ghFetch('GET', `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`);
      if (r.ok) {
        const j = await r.json();
        body.sha = j.sha;
        res = await ghFetch('PUT', `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, body);
      }
    }
    if (!res.ok) {
      let m = ''; try { const j = await res.json(); m = j.message || ''; } catch(e){}
      throw new Error(`HTTP ${res.status}${m ? ': ' + m : ''}`);
    }
    const j = await res.json();
    sync.sha = j.content.sha;
    sync.lastSyncAt = snap.updatedAt;
    saveSyncConfig();
    setStatus('synced', '已同步');
  } catch (e) {
    setStatus('error', e.message);
    throw e;
  }
}

function schedulePush(snapshotProvider, delayMs = 2000){
  if (!sync.cfg.enabled || !sync.cfg.token) return;
  if (sync._timer) clearTimeout(sync._timer);
  setStatus('syncing', `${delayMs/1000}s 后同步…`);
  sync._timer = setTimeout(()=>{
    sync._timer = null;
    push(snapshotProvider).catch(()=>{}); // 错误已 setStatus
  }, delayMs);
}

window.MBSync = {
  sync,
  saveSyncConfig,
  setStatus,
  onStatusChange,
  testConnection,
  pull,
  push,
  schedulePush,
  makeSnapshot,
  deviceId,
};
