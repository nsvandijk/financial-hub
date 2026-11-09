/*
 * DataStore — where your data lives.
 *
 * 1. A copy in this browser's localStorage, so the app opens instantly and
 *    keeps working when you're offline or not signed in.
 * 2. One file in your Google Drive ("financial-hub-data.json"), which is the copy
 *    that your PC, Mac and phone all share.
 *
 * Sign-in uses Google Identity Services. The app asks for the "drive.file"
 * permission: it can only see files it created itself, never the rest of your Drive.
 * Google gives the app a temporary access token (valid ~1 hour). It's kept in this
 * browser's localStorage, so refreshing the page doesn't ask you to sign in again.
 * After the hour is up, one tap on "Sign in" gets a fresh one.
 */
const DataStore = (() => {
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const FILE_NAME = 'financial-hub-data.json';
  const LS_DATA = 'financialHub.data.v1';
  const LS_SYNC = 'financialHub.sync.v1';
  const LS_TOKEN = 'financialHub.token.v1';
  const API = 'https://www.googleapis.com/drive/v3/files';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

  let token = null;
  let tokenExpiry = 0;
  let gisPromise = null;
  restoreToken();

  // ---- sync bookkeeping (per device) ----
  // fileId: the Drive file; version: Drive's version number we last saw;
  // dirty: this device has changes Drive doesn't have yet; signedInBefore: skip the consent screen next time.
  let sync = readJson(LS_SYNC) || {};
  function readJson(key) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }
  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { console.warn('localStorage save failed', e); }
  }
  function setSync(patch) {
    sync = { ...sync, ...patch };
    writeJson(LS_SYNC, sync);
  }

  // ---- access token (survives a page refresh until it expires) ----
  function restoreToken() {
    const t = readJson(LS_TOKEN);
    if (t && t.token && Date.now() < t.expiry) { token = t.token; tokenExpiry = t.expiry; }
  }
  function saveToken() { writeJson(LS_TOKEN, { token, expiry: tokenExpiry }); }
  function forgetToken() {
    token = null;
    tokenExpiry = 0;
    try { localStorage.removeItem(LS_TOKEN); } catch (e) { /* ignore */ }
  }

  // ---- local copy ----
  const loadLocal = () => readJson(LS_DATA);
  const saveLocal = data => writeJson(LS_DATA, data);
  function clearLocal() {
    try { localStorage.removeItem(LS_DATA); localStorage.removeItem(LS_SYNC); } catch (e) { /* ignore */ }
    forgetToken();
    sync = {};
  }

  // ---- Google sign-in ----
  const configured = () => typeof CONFIG !== 'undefined' && !!CONFIG.GOOGLE_CLIENT_ID;

  /** Loads Google's sign-in script (done at startup so a tap on "Sign in" opens the popup immediately). */
  function loadGoogle() {
    if (gisPromise) return gisPromise;
    gisPromise = new Promise((resolve, reject) => {
      if (window.google && google.accounts && google.accounts.oauth2) return resolve();
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { gisPromise = null; reject(new Error('Could not load Google sign-in. Are you online?')); };
      document.head.appendChild(s);
    });
    return gisPromise;
  }

  const hasToken = () => !!token && Date.now() < tokenExpiry;

  /** Opens Google's sign-in popup. Call this directly from a tap/click, or the browser may block the popup. */
  function signIn() {
    return new Promise((resolve, reject) => {
      if (!(window.google && google.accounts && google.accounts.oauth2)) {
        loadGoogle().catch(() => {});
        return reject(new Error('Google sign-in is still loading. Try again in a moment.'));
      }
      const client = google.accounts.oauth2.initTokenClient({
        client_id: CONFIG.GOOGLE_CLIENT_ID,
        scope: SCOPE,
        callback: resp => {
          if (resp.error) return reject(new Error(resp.error_description || resp.error));
          if (!google.accounts.oauth2.hasGrantedAllScopes(resp, SCOPE)) {
            return reject(new Error('Please allow access to Google Drive. The app needs it to save your data.'));
          }
          token = resp.access_token;
          tokenExpiry = Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000;
          saveToken();
          setSync({ signedInBefore: true });
          resolve();
        },
        error_callback: err => {
          const e = new Error(err && err.type === 'popup_closed' ? 'Sign-in was cancelled.' :
            err && err.type === 'popup_failed_to_open' ? 'The sign-in popup was blocked. Allow popups for this site and try again.' :
            (err && err.message) || 'Sign-in failed.');
          e.type = err && err.type;
          reject(e);
        },
      });
      client.requestAccessToken({ prompt: sync.signedInBefore ? '' : 'consent' });
    });
  }

  function signOut() {
    if (token && window.google && google.accounts && google.accounts.oauth2) {
      try { google.accounts.oauth2.revoke(token, () => {}); } catch (e) { /* ignore */ }
    }
    forgetToken();
  }

  // ---- Google Drive API ----
  function authError() {
    const e = new Error('Not signed in');
    e.auth = true;
    return e;
  }

  async function api(url, opts = {}) {
    if (!hasToken()) throw authError();
    const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } });
    if (res.status === 401) { forgetToken(); throw authError(); }
    if (!res.ok) {
      const e = new Error(`Google Drive error ${res.status}`);
      e.status = res.status;
      e.detail = (await res.text()).slice(0, 300);
      throw e;
    }
    return res;
  }

  /** Info about our Drive file ({id, version, modifiedTime}) or null if there isn't one. */
  async function remoteInfo() {
    if (sync.fileId) {
      try {
        const res = await api(`${API}/${sync.fileId}?fields=id,version,modifiedTime,trashed`);
        const f = await res.json();
        if (!f.trashed) return f;
      } catch (e) {
        if (e.auth) throw e;
        if (e.status !== 404) throw e;
      }
    }
    const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
    const res = await api(`${API}?q=${q}&spaces=drive&orderBy=modifiedTime desc&fields=files(id,version,modifiedTime)`);
    const { files } = await res.json();
    return files && files.length ? files[0] : null;
  }

  async function download(info) {
    const res = await api(`${API}/${info.id}?alt=media`);
    const text = await res.text();
    setSync({ fileId: info.id, version: String(info.version), dirty: false });
    return text.trim() ? JSON.parse(text) : null;
  }

  async function upload(data) {
    const body = JSON.stringify(data, null, 2);
    let res;
    if (sync.fileId) {
      res = await api(`${UPLOAD}/${sync.fileId}?uploadType=media&fields=id,version`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body,
      }).catch(async e => {
        if (e.status === 404) { setSync({ fileId: null }); return null; } // file was deleted: create a new one
        throw e;
      });
    }
    if (!res) {
      const boundary = 'fh' + Math.random().toString(36).slice(2);
      const meta = { name: FILE_NAME, mimeType: 'application/json', description: 'Data for Financial Hub' };
      const multipart =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
        `--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
      res = await api(`${UPLOAD}?uploadType=multipart&fields=id,version`, {
        method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart,
      });
    }
    const f = await res.json();
    setSync({ fileId: f.id, version: String(f.version), dirty: false });
  }

  // ---- manual backup ----
  function downloadBackup(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const readUpload = async file => JSON.parse(await file.text());

  return {
    FILE_NAME,
    configured, loadGoogle, signIn, signOut, hasToken,
    loadLocal, saveLocal, clearLocal,
    remoteInfo, download, upload,
    getSync: () => ({ ...sync }),
    markDirty: () => setSync({ dirty: true }),
    fileUrl: () => (sync.fileId ? `https://drive.google.com/file/d/${sync.fileId}/view` : null),
    downloadBackup, readUpload,
  };
})();
