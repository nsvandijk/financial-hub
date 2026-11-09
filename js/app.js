/*
 * App — screens, user actions and saving.
 *
 * Data shape (this is exactly what ends up in finance-data.json):
 * {
 *   categories: [{ id, name, kind: 'fixed'|'variable', budget }],
 *   items:      [{ id, name, type: 'income'|'expense', amount, frequency, categoryId,
 *                  subscription, startMonth, endMonth, notes }],   // recurring things
 *   months: { "2026-11": { overrides: {itemId: amount},             // "this month it was different"
 *                          variable:  {categoryId: amount},          // monthly totals (groceries…)
 *                          extras:    [{id, name, type, categoryId, amount}], // one-offs
 *                          contributions: {goalId: amount},
 *                          note } },
 *   goals: [{ id, name, target, startAmount, deadline }],
 * }
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------- helpers
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  const num = Calc.num;

  const money = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR' });
  const money0 = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  const compact = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR', notation: 'compact', maximumFractionDigits: 1 });
  const plainInt = new Intl.NumberFormat(undefined, { useGrouping: false, maximumFractionDigits: 0 });
  const plainDec = new Intl.NumberFormat(undefined, { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const plain = { format: n => (Number.isInteger(Number(n)) ? plainInt : plainDec).format(n) }; // 1150 / 34,90
  const fmt = n => money.format(n || 0);
  const fmt0 = n => money0.format(Math.round(n || 0));
  const pct = r => (r == null || !Number.isFinite(r) ? '—' : `${Math.round(r * 100)}%`);
  const toInput = n => (n === '' || n == null ? '' : plain.format(n));
  const monthName = key => Calc.label(key, { month: 'long' });
  const monthShort = key => Calc.label(key, { month: 'short' }).replace(/\.$/, '');

  /** Accepts "1.234,56", "1,234.56", "13,99", "€ 20" … returns NaN if not a number. */
  function parseAmount(str) {
    let s = String(str ?? '').replace(/[€\s]/g, '');
    if (!s) return NaN;
    if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  }

  const ICONS = { good: '✓', warn: '!', bad: '✕', info: 'i' };
  const icon = tone => `<span class="status-icon ${tone}" aria-hidden="true">${ICONS[tone]}</span>`;

  // ------------------------------------------------------------ data model
  const DEFAULT_CATEGORIES = [
    ['Housing', 'fixed'], ['Utilities', 'fixed'], ['Insurance', 'fixed'], ['Subscriptions', 'fixed'],
    ['Groceries', 'variable'], ['Eating out', 'variable'], ['Transport', 'variable'], ['Shopping', 'variable'],
    ['Entertainment', 'variable'], ['Health', 'variable'], ['Other', 'variable'],
  ];
  const makeCategories = () => DEFAULT_CATEGORIES.map(([name, kind]) => ({
    id: 'c-' + name.toLowerCase().replace(/[^a-z]+/g, '-'), name, kind, budget: null,
  }));

  function emptyData() {
    return { schema: 1, currency: 'EUR', categories: makeCategories(), items: [], months: {}, goals: [], accounts: [], settings: {}, updatedAt: new Date().toISOString() };
  }
  function exampleData() {
    const d = emptyData();
    Object.assign(d, Example.build(d.categories));
    d.isExample = true;
    return d;
  }
  function isValid(d) {
    return d && typeof d === 'object' && Array.isArray(d.items) && Array.isArray(d.categories);
  }
  function normalize(d) {
    return {
      schema: 1,
      currency: 'EUR',
      categories: Array.isArray(d.categories) ? d.categories : makeCategories(),
      items: Array.isArray(d.items) ? d.items : [],
      months: d.months && typeof d.months === 'object' ? d.months : {},
      goals: Array.isArray(d.goals) ? d.goals : [],
      accounts: Array.isArray(d.accounts) ? d.accounts : [],
      settings: d.settings && typeof d.settings === 'object' ? d.settings : {},
      isExample: !!d.isExample,
      updatedAt: d.updatedAt || new Date().toISOString(),
    };
  }
  function ensureMonth(key) {
    const e = (state.data.months[key] ||= {});
    e.overrides ||= {};
    e.variable ||= {};
    e.extras ||= [];
    e.contributions ||= {};
    e.balances ||= {};
    return e;
  }
  const catName = id => (state.data.categories.find(c => c.id === id) || {}).name || 'Uncategorized';

  // ----------------------------------------------------------------- state
  const TAB_KEY = 'financialHub.tab';
  const HOME_MODE_KEY = 'financialHub.homeMode';
  const state = {
    data: null,
    tab: (() => { try { return localStorage.getItem(TAB_KEY) || 'overview'; } catch (e) { return 'overview'; } })(),
    month: Calc.monthKey(),
    homeMode: (() => { try { return localStorage.getItem(HOME_MODE_KEY) === 'year' ? 'year' : 'month'; } catch (e) { return 'month'; } })(),
    year: new Date().getFullYear(),
    backups: null, // the list of Drive backups shown in Settings (loaded when you open it)
    // 'drive'  = signed in, changes go to Google Drive
    // 'signin' = not signed in (yet): working from the copy on this device
    // 'local'  = Google sign-in not set up (no client ID in js/config.js)
    conn: 'local',
    saveState: 'idle', // 'saving' | 'saved' | 'error'
  };
  let writeTimer = null;

  // ------------------------------------------------------------- persistence
  function commit(message) {
    state.data.updatedAt = new Date().toISOString();
    DataStore.saveLocal(state.data);
    if (state.conn !== 'local') DataStore.markDirty();
    if (state.conn === 'drive') {
      state.saveState = 'saving';
      clearTimeout(writeTimer);
      writeTimer = setTimeout(flush, 600);
    }
    scheduleRender();
    if (message) toast(message);
  }

  async function flush() {
    writeTimer = null;
    try {
      await DataStore.upload(state.data);
      state.saveState = 'saved';
    } catch (e) {
      handleSyncError(e);
    }
    renderStatus();
  }

  function handleSyncError(e) {
    console.error(e);
    if (e && e.auth) {
      // Google's sign-in token expired (they last ~1 hour). Changes stay on this device until you sign in again.
      state.conn = 'signin';
      state.saveState = 'idle';
    } else {
      state.saveState = 'error';
      toast("Couldn't reach Google Drive. Your changes are kept on this device and will sync later.");
    }
    scheduleRender();
  }

  /**
   * Bring this device and Google Drive in line after signing in.
   * - Only Drive changed  -> take Drive's version
   * - Only this device changed -> send it to Drive
   * - Both changed -> keep whichever was edited most recently
   */
  async function syncNow() {
    state.saveState = 'saving';
    renderStatus();
    try {
      const info = await DataStore.remoteInfo();
      const s = DataStore.getSync();
      if (!info) {
        if (state.data) await DataStore.upload(state.data); // first time: create the file in Drive
      } else {
        const remoteChanged = info.id !== s.fileId || String(info.version) !== s.version;
        const localChanged = !!s.dirty && !!state.data && !state.data.isExample;
        if (!localChanged) {
          if (remoteChanged || !state.data) await takeRemote(info);
        } else if (!remoteChanged) {
          await DataStore.upload(state.data);
        } else {
          const localData = state.data;
          const remote = await DataStore.download(info);
          if (isValid(remote) && String(remote.updatedAt || '') > String(localData.updatedAt || '')) {
            useData(remote);
            toast('This device and Google Drive both had changes. Kept the newest version (from Google Drive).');
          } else {
            state.data = localData;
            await DataStore.upload(localData);
            toast('This device and Google Drive both had changes. Kept the newest version (from this device).');
          }
        }
      }
      state.conn = 'drive';
      state.saveState = 'saved';
      autoBackup();
    } catch (e) {
      handleSyncError(e);
    }
    render();
  }

  /** Once a month, keep a copy of your data in the "Financial Hub backups" folder in Drive. */
  async function autoBackup() {
    if (!state.data || state.data.isExample) return;
    try {
      if (await DataStore.ensureMonthlyBackup(Calc.monthKey())) state.backups = null; // refresh the list in Settings
    } catch (e) {
      console.warn('Monthly backup failed', e);
    }
  }

  async function takeRemote(info) {
    const d = await DataStore.download(info);
    if (isValid(d)) useData(d);
  }
  function useData(d) {
    state.data = normalize(d);
    DataStore.saveLocal(state.data);
  }

  /** When you come back to the app, pick up changes made on your other devices. */
  async function checkForOutsideChanges() {
    if (state.conn !== 'drive' || writeTimer) return;
    if (!DataStore.hasToken()) { state.conn = 'signin'; scheduleRender(); return; }
    const s = DataStore.getSync();
    if (s.dirty) return;
    try {
      const info = await DataStore.remoteInfo();
      if (info && (info.id !== s.fileId || String(info.version) !== s.version)) {
        await takeRemote(info);
        scheduleRender();
        toast('Loaded the latest changes from Google Drive.');
      }
    } catch (e) {
      if (e.auth) { state.conn = 'signin'; scheduleRender(); } else console.warn('Could not check Google Drive', e);
    }
  }

  async function signIn() {
    try {
      await DataStore.signIn();
    } catch (e) {
      return toast(e.message);
    }
    await syncNow();
    if (state.conn === 'drive') toast('Signed in. Your data syncs with Google Drive.');
  }

  // -------------------------------------------------------------- rendering
  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  function render() {
    const focusId = document.activeElement && document.activeElement.id;
    renderStatus();
    const main = $('#view');
    const tabs = $('#tabs');

    if (!state.data) {
      tabs.hidden = true;
      main.innerHTML = welcomeView();
      return;
    }

    tabs.hidden = false;
    tabs.querySelectorAll('button').forEach(b => {
      const on = b.dataset.tab === state.tab;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });

    const mounts = [];
    const view = VIEWS[state.tab] || VIEWS.overview;
    main.innerHTML = (state.data.isExample ? exampleBanner() : '') + syncBanner() + view(mounts);
    mounts.forEach(fn => fn());

    if (focusId) {
      const el = document.getElementById(focusId);
      if (el) el.focus();
    }
  }

  function renderStatus() {
    const el = $('#status');
    if (!state.data) { el.innerHTML = ''; return; }
    if (state.conn === 'drive') {
      const label = state.saveState === 'saving' ? 'Syncing…' : state.saveState === 'error' ? 'Sync problem' : 'Synced';
      el.innerHTML = `<button class="status-chip ${state.saveState === 'error' ? 'bad' : 'good'}" data-click="tab" data-tab="data" title="Your data is saved in Google Drive">
        <span class="dot"></span>${label}</button>`;
    } else if (state.conn === 'signin') {
      el.innerHTML = `<button class="status-chip warn" data-click="sign-in"><span class="dot"></span>Sign in to sync</button>`;
    } else {
      el.innerHTML = `<button class="status-chip" data-click="tab" data-tab="data" title="Google sign-in isn't set up yet">
        <span class="dot"></span>This device only</button>`;
    }
  }

  const card = (title, body, cls = '', actions = '') => `
    <section class="card ${cls}">
      ${title ? `<div class="card-head"><h2>${title}</h2>${actions}</div>` : ''}
      ${body}
    </section>`;

  function exampleBanner() {
    return `<div class="banner info">${icon('info')}<div><b>You're looking at example data.</b> Explore everything freely, then start with your own numbers.</div>
      <button class="btn primary small" data-click="start-fresh">Start with my own data</button></div>`;
  }
  function syncBanner() {
    if (state.conn !== 'signin') return '';
    const dirty = DataStore.getSync().dirty;
    return `<div class="banner warn">${icon('warn')}<div>${dirty
      ? "<b>Not synced yet.</b> You have changes on this device that aren't in Google Drive. Sign in to sync them."
      : '<b>Showing the copy saved on this device.</b> Sign in to get the latest from your other devices.'}</div>
      <button class="btn primary small" data-click="sign-in">Sign in</button></div>`;
  }

  // ---------------------------------------------------------------- welcome
  const exampleChoice = `<div class="choice">
      <div><h3>Try it with example data</h3><p>Explore with made-up numbers first. You can start fresh any time.</p></div>
      <button class="btn" data-click="load-example">Show example</button>
    </div>`;

  function welcomeView() {
    const intro = `<h1>Welcome to your Financial Hub</h1>
      <p class="lead">See where your money goes each month: income, fixed costs, subscriptions, budgets and savings goals.</p>`;

    if (!DataStore.configured()) {
      return `<section class="welcome card">${intro}
        <div class="banner warn">${icon('warn')}<div><b>Google sign-in isn't set up yet.</b> Add your Google client ID to <code>js/config.js</code> to sync between devices. Until then, data is only saved on this device.</div></div>
        <div class="choices">${exampleChoice}
          <div class="choice subtle"><div><h3>Use on this device only</h3><p>Start without syncing. Your data stays in this browser.</p></div>
          <button class="btn ghost" data-click="start-empty">Start</button></div>
        </div></section>`;
    }

    if (state.conn === 'drive') {
      return `<section class="welcome card">${intro}
        <div class="banner info">${icon('good')}<div><b>You're signed in.</b> There's no Financial Hub data in your Google Drive yet. How would you like to start?</div></div>
        <div class="choices">
          <div class="choice"><div><h3>Import my existing data</h3><p>Choose your <code>finance-data.json</code> (or a backup file). It will be copied into Google Drive.</p></div>
          <button class="btn primary" data-click="import">Import file</button></div>
          <div class="choice"><div><h3>Start fresh</h3><p>Begin with empty categories and add your own numbers.</p></div>
          <button class="btn" data-click="start-empty">Start fresh</button></div>
          ${exampleChoice}
        </div></section>`;
    }

    return `<section class="welcome card">${intro}
      <div class="choice primary-choice">
        <div><h3>Sign in with Google</h3>
        <p>Your data is saved as one file in your own Google Drive, so it's the same on your PC, Mac and phone.
        The app can only see the file it creates, not the rest of your Drive.</p></div>
        <button class="btn primary" data-click="sign-in">Sign in with Google</button>
      </div>
    </section>`;
  }

  // --------------------------------------------------------------- overview
  function kpi(label, value, sub = '', opts = {}) {
    const sw = opts.color ? `<span class="swatch" style="background:${opts.color}"></span>` : '';
    const link = opts.tab ? ` link" data-click="tab" data-tab="${opts.tab}" role="button" tabindex="0` : '';
    return `<div class="kpi${link}"><div class="kpi-label">${sw}${label}</div><div class="kpi-value">${value}</div><div class="kpi-sub">${sub}</div></div>`;
  }

  /** The month picker shown at the top of month-based pages. */
  function monthSwitch() {
    const isNow = state.month === Calc.monthKey();
    return `<div class="month-switch" role="group" aria-label="Choose month">
      <button class="icon-btn" data-click="prev-month" aria-label="Previous month">‹</button>
      <span class="label">${Calc.label(state.month)}</span>
      <button class="icon-btn" data-click="next-month" aria-label="Next month">›</button>
      ${isNow ? '' : '<button class="btn ghost small today" data-click="this-month">Today</button>'}
    </div>`;
  }
  function pageHead(title, sub = '', withMonth = true, cls = 'page-title') {
    return `<header class="page-head"><div><h1 class="${cls}">${title}</h1>${sub ? `<p class="page-sub">${sub}</p>` : ''}</div>
      ${withMonth ? monthSwitch() : ''}</header>`;
  }
  function greeting() {
    const h = new Date().getHours();
    const part = h < 6 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    const name = (state.data.settings.name || '').trim();
    return name ? `${part}, ${esc(name)}` : part;
  }
  function delta(cur, prev, upIsGood, prevKey, formatter = fmt0) {
    if (!prev) return '';
    const d = cur - prev;
    if (Math.abs(d) < 0.5) return `<span class="delta">Same as ${monthShort(prevKey)}</span>`;
    const good = (d > 0) === upIsGood;
    return `<span class="delta ${good ? 'good' : 'bad'}">${d > 0 ? '▲' : '▼'} ${formatter(Math.abs(d))} vs ${monthShort(prevKey)}</span>`;
  }

  // Home has two modes: one month, or a whole year.
  function homeHead(title, sub, switcher) {
    const toggle = `<div class="segmented" role="group" aria-label="Show one month or a whole year">
      ${['month', 'year'].map(m => `<button data-click="home-mode" data-mode="${m}" class="${state.homeMode === m ? 'active' : ''}" aria-pressed="${state.homeMode === m}">${m === 'month' ? 'Month' : 'Year'}</button>`).join('')}
    </div>`;
    return `<header class="page-head"><div><h1 class="greeting">${title}</h1>${sub ? `<p class="page-sub">${sub}</p>` : ''}</div>
      <div class="head-controls">${toggle}${switcher}</div></header>`;
  }
  function yearSwitch() {
    const thisYear = Number(Calc.monthKey().slice(0, 4));
    return `<div class="month-switch" role="group" aria-label="Choose year">
      <button class="icon-btn" data-click="prev-year" aria-label="Previous year">‹</button>
      <span class="label">${state.year}</span>
      <button class="icon-btn" data-click="next-year" aria-label="Next year" ${state.year >= thisYear ? 'disabled' : ''}>›</button>
      ${state.year === thisYear ? '' : '<button class="btn ghost small today" data-click="this-year">This year</button>'}
    </div>`;
  }

  function yearView(mounts) {
    const d = state.data;
    const today = Calc.monthKey();
    const y = state.year;
    const Y = Calc.year(d, y, today);
    const isCurrent = y === Number(today.slice(0, 4));

    if (!Y.count) {
      return homeHead(`${y} at a glance`, '', yearSwitch()) +
        card('', `<p class="muted">There's no data for ${y}. Your overview starts in ${Calc.label(Calc.firstMonth(d, today))}.</p>`);
    }

    const firstKey = Y.months[0].key, lastKey = Y.months[Y.count - 1].key;
    const span = Y.count === 12 ? 'all 12 months' : Y.count === 1 ? monthName(firstKey) : `${monthShort(firstKey)}–${monthShort(lastKey)}`;
    // Compare with the same months of the year before, but only if those months all have data.
    const P = Calc.year(d, y - 1, today, Number(lastKey.slice(5)));
    const comparable = P.count === Y.count;
    const prevLabel = Y.count === 12 ? String(y - 1) : `${span} ${y - 1}`;
    const yDelta = (cur, prev, upIsGood, formatter = fmt0) => {
      if (!comparable) return '';
      const diff = cur - prev;
      if (Math.abs(diff) < 0.5) return `<span class="delta">Same as ${prevLabel}</span>`;
      return `<span class="delta ${(diff > 0) === upIsGood ? 'good' : 'bad'}">${diff > 0 ? '▲' : '▼'} ${formatter(Math.abs(diff))} vs ${prevLabel}</span>`;
    };

    let html = homeHead(`${y} at a glance`,
      isCurrent ? `${y} so far: ${span}. Future months aren't counted yet.` : `Looking back at ${y} (${span}).`, yearSwitch());

    html += `<section class="kpis">
      ${kpi('Income', fmt0(Y.income), yDelta(Y.income, P.income, true), { color: 'var(--series-1)' })}
      ${kpi('Expenses', fmt0(Y.expenses), yDelta(Y.expenses, P.expenses, false), { color: 'var(--series-2)' })}
      ${kpi(Y.saved >= 0 ? 'Saved' : 'Overspent', fmt0(Math.abs(Y.saved)), comparable ? yDelta(Y.saved, P.saved, true) : `${fmt0(Y.avgSaved)} per month on average`, { color: 'var(--series-4)' })}
      ${kpi('Savings rate', pct(Y.rate), comparable && Y.rate != null && P.rate != null ? yDelta(Y.rate * 100, P.rate * 100, true, v => `${Math.round(v)} pts`) : '')}
    </section>`;

    // Highlights
    const best = Y.months.reduce((a, b) => (b.saved > a.saved ? b : a));
    const worst = Y.months.reduce((a, b) => (b.saved < a.saved ? b : a));
    const cats = Object.entries(Y.byCategory).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    const notes = [];
    notes.push({ tone: 'info', text: `On average you saved <b>${fmt0(Y.avgSaved)}</b> and spent <b>${fmt0(Y.expenses / Y.count)}</b> per month.` });
    if (Y.count > 1) {
      notes.push({ tone: 'good', text: `Best month: <b>${monthName(best.key)}</b>, ${best.saved >= 0 ? 'saved' : 'overspent'} ${fmt0(Math.abs(best.saved))}.` });
      if (worst.key !== best.key) notes.push({ tone: worst.saved < 0 ? 'bad' : 'warn', text: `Toughest month: <b>${monthName(worst.key)}</b>, ${worst.saved >= 0 ? `saved only ${fmt0(worst.saved)}` : `overspent ${fmt0(-worst.saved)}`}.` });
    }
    if (cats.length && Y.expenses > 0) notes.push({ tone: 'info', text: `Your biggest cost was <b>${esc(catName(cats[0][0]))}</b>: ${fmt0(cats[0][1])}, or ${Math.round((cats[0][1] / Y.expenses) * 100)}% of everything you spent.` });
    const unlogged = Y.months.filter(m => !m.logged && m.key < today).length;
    if (unlogged) notes.push({ tone: 'warn', text: `${unlogged} month${unlogged > 1 ? 's have' : ' has'} only fixed items, no variable spending logged. The real spending was probably a bit higher.` });
    const notesHtml = `<ul class="insights">${notes.map(i => `<li class="insight ${i.tone}">${icon(i.tone)}<span>${i.text}</span></li>`).join('')}</ul>`;

    // Spending per category for the year
    const maxCat = cats.length ? cats[0][1] : 1;
    const catHtml = cats.length ? `<div class="cat-list">${cats.map(([id, v]) => `<div class="cat-row">
        <div class="row-between"><span>${esc(catName(id))} <span class="muted small">${Math.round((v / (Y.expenses || 1)) * 100)}%</span></span>
          <span class="num">${fmt0(v)} <span class="muted small">· ${fmt0(v / Y.count)}/mo</span></span></div>
        <div class="meter" title="${esc(catName(id))}: ${fmt(v)}"><div class="meter-fill" style="width:${(v / maxCat) * 100}%"></div></div>
      </div>`).join('')}</div>` : `<p class="muted">Nothing spent in ${y}.</p>`;

    html += `<div class="grid-2">${card('Highlights', notesHtml)}${card(`Where your money went in ${y}`, catHtml)}</div>`;

    // Month by month
    const labels = Y.months.map(m => monthShort(m.key));
    const full = Y.months.map(m => Calc.label(m.key));
    html += card(`Month by month in ${y}`, `
      <div id="chart-year"></div>
      <h3 class="chart-title">Saved per month</h3>
      <div id="chart-year-saved"></div>
      <details class="table-toggle"><summary>Show as table</summary>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Month</th><th class="num">Income</th><th class="num">Expenses</th><th class="num">Saved</th><th class="num">Rate</th></tr></thead>
          <tbody>${Y.months.map(m => `<tr><td>${Calc.label(m.key)}</td><td class="num">${fmt(m.income)}</td><td class="num">${fmt(m.expenses)}</td><td class="num">${fmt(m.saved)}</td><td class="num">${pct(m.rate)}</td></tr>`).join('')}</tbody>
          <tfoot><tr><th>Total</th><th class="num">${fmt(Y.income)}</th><th class="num">${fmt(Y.expenses)}</th><th class="num">${fmt(Y.saved)}</th><th class="num">${pct(Y.rate)}</th></tr></tfoot>
        </table></div>
      </details>`);
    mounts.push(() => {
      Charts.bars($('#chart-year'), {
        labels, fullLabels: full, format: fmt, axisFormat: v => compact.format(v),
        series: [
          { name: 'Income', color: 'var(--series-1)', values: Y.months.map(m => m.income) },
          { name: 'Expenses', color: 'var(--series-2)', values: Y.months.map(m => m.expenses) },
        ],
      });
      Charts.bars($('#chart-year-saved'), {
        labels, fullLabels: full, format: fmt, axisFormat: v => compact.format(v), height: 170,
        series: [{ name: 'Saved', color: 'var(--series-4)', values: Y.months.map(m => m.saved) }],
        tooltipExtra: i => `Savings rate: ${pct(Y.months[i].rate)}`,
      });
    });

    // All years side by side
    const all = Calc.years(d, today).map(yy => Calc.year(d, yy, today)).filter(x => x.count).reverse();
    if (all.length > 1) {
      html += card('All years', `<div class="table-wrap"><table class="table">
        <thead><tr><th>Year</th><th class="num">Months</th><th class="num">Income</th><th class="num">Expenses</th><th class="num">Saved</th><th class="num">Rate</th><th class="num">Saved / month</th></tr></thead>
        <tbody>${all.map(x => `<tr class="${x.year === y ? 'current-row' : ''}">
          <td><button class="link-btn" data-click="set-year" data-year="${x.year}">${x.year}</button></td>
          <td class="num">${x.count}</td><td class="num">${fmt0(x.income)}</td><td class="num">${fmt0(x.expenses)}</td>
          <td class="num">${fmt0(x.saved)}</td><td class="num">${pct(x.rate)}</td><td class="num">${fmt0(x.avgSaved)}</td></tr>`).join('')}</tbody>
      </table></div>`);
    }
    return html;
  }

  function overviewView(mounts) {
    if (state.homeMode === 'year') return yearView(mounts);
    const d = state.data;
    const key = state.month;
    const m = Calc.month(d, key);
    const prevKey = Calc.addMonths(key, -1);
    const p = Calc.month(d, prevKey);
    let html = '';

    if (!d.items.length && !Object.keys(d.months).length) {
      html += card('Get started in 3 steps', `
        <ol class="steps">
          <li><b>Add your fixed items</b>: salary, rent, insurance, subscriptions. They fill in automatically every month.
            <button class="btn small" data-click="tab" data-tab="recurring">Add fixed items</button></li>
          <li><b>Set budgets</b> for variable categories like groceries and eating out.
            <button class="btn small" data-click="tab" data-tab="budgets">Set budgets</button></li>
          <li><b>Once a month</b>, log rough totals for your variable spending, plus any one-offs.
            <button class="btn small" data-click="tab" data-tab="month">Log this month</button></li>
        </ol>`, 'onboarding');
    }

    const isNow = key === Calc.monthKey();
    html = homeHead(greeting(), isNow ? `Here's how ${monthName(key)} is going.` : `Looking back at ${Calc.label(key)}.`, monthSwitch()) + html;

    // Hero: what you saved this month, with the last 6 months as small bars
    const recent = Calc.history(d, key, 6);
    const maxAbs = Math.max(1, ...recent.map(h => Math.abs(h.saved)));
    const spark = recent.length >= 2 ? `<div class="spark" aria-hidden="true">${recent.map(h => `
        <div class="spark-col ${h.key === key ? 'current' : ''}" title="${Calc.label(h.key)}: ${fmt0(h.saved)}">
          <div class="spark-bar ${h.saved < 0 ? 'neg' : ''}" style="--f:${Math.max(0.04, Math.abs(h.saved) / maxAbs).toFixed(3)}"></div>
          <span>${monthShort(h.key)}</span></div>`).join('')}</div>` : '';
    const rateDelta = (m.rate != null && p.rate != null)
      ? delta(m.rate * 100, p.rate * 100, true, prevKey, v => `${Math.round(v)} pts`) : '';
    const nw = Calc.netWorth(d, key);
    const nwPrev = Calc.netWorth(d, prevKey);
    const thirdKpi = nw.has
      ? kpi('Net worth', fmt0(nw.total), nwPrev.has ? delta(nw.total, nwPrev.total, true, prevKey) : '', { color: 'var(--series-4)', tab: 'networth' })
      : kpi('Savings rate', pct(m.rate), rateDelta);
    html += `<section class="hero-grid">
      <div class="hero">
        <div class="hero-label">${m.saved >= 0 ? 'Saved' : 'Overspent'} in ${monthName(key)}</div>
        <div class="hero-value">${fmt0(Math.abs(m.saved))}</div>
        <div class="hero-meta">${m.rate != null ? `<span>${pct(m.rate)} of your income</span>` : ''}${delta(m.saved, p.saved, true, prevKey)}</div>
        ${spark}
      </div>
      <div class="kpi-stack">
        ${kpi('Income', fmt(m.income), delta(m.income, p.income, true, prevKey), { color: 'var(--series-1)' })}
        ${kpi('Expenses', fmt(m.expenses), delta(m.expenses, p.expenses, false, prevKey), { color: 'var(--series-2)' })}
        ${thirdKpi}
      </div>
    </section>`;

    if (!m.logged && m.income + m.expenses > 0) {
      html += `<div class="banner info">${icon('info')}<div>Only fixed items are counted for ${monthName(key)} so far. Log your variable spending to complete the picture.</div>
        <button class="btn small" data-click="tab" data-tab="month">Log ${monthName(key)}</button></div>`;
    }

    html += `<div class="grid-2">
      ${card(`Where your money went in ${monthName(key)}`, breakdownHtml(m))}
      ${card('Insights', insightsHtml(key))}
    </div>`;

    const hist = Calc.history(d, key, 12);
    if (hist.length >= 2) {
      const labels = hist.map(h => monthShort(h.key));
      const full = hist.map(h => Calc.label(h.key));
      html += card(`Last ${hist.length} months`, `
        <div id="chart-trend"></div>
        <h3 class="chart-title">Saved per month</h3>
        <div id="chart-saved"></div>
        <details class="table-toggle"><summary>Show as table</summary>
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Month</th><th class="num">Income</th><th class="num">Expenses</th><th class="num">Saved</th><th class="num">Rate</th></tr></thead>
            <tbody>${hist.slice().reverse().map(h => `<tr><td>${Calc.label(h.key)}</td><td class="num">${fmt(h.income)}</td><td class="num">${fmt(h.expenses)}</td><td class="num">${fmt(h.saved)}</td><td class="num">${pct(h.rate)}</td></tr>`).join('')}</tbody>
          </table></div>
        </details>`);
      mounts.push(() => {
        Charts.bars($('#chart-trend'), {
          labels, fullLabels: full, format: fmt, axisFormat: v => compact.format(v),
          series: [
            { name: 'Income', color: 'var(--series-1)', values: hist.map(h => h.income) },
            { name: 'Expenses', color: 'var(--series-2)', values: hist.map(h => h.expenses) },
          ],
        });
        Charts.bars($('#chart-saved'), {
          labels, fullLabels: full, format: fmt, axisFormat: v => compact.format(v), height: 170,
          series: [{ name: 'Saved', color: 'var(--series-4)', values: hist.map(h => h.saved) }],
          tooltipExtra: i => `Savings rate: ${pct(hist[i].rate)}`,
        });
      });
    } else {
      html += card('Trends', `<p class="muted">Your month-by-month trend chart appears once you have two months of data.</p>`);
    }

    if (d.goals.length) {
      html += card('Savings goals', `<div class="goal-mini-list">${d.goals.map(g => {
        const gp = Calc.goalProgress(d, g, key);
        return `<div class="goal-mini">
          <div class="row-between"><b>${esc(g.name)}</b><span class="num">${fmt0(gp.saved)} <span class="muted">of ${fmt0(gp.target)}</span></span></div>
          <div class="progress"><div style="width:${gp.pct * 100}%"></div></div>
        </div>`;
      }).join('')}</div>`, '', `<button class="btn ghost small" data-click="tab" data-tab="goals">All goals</button>`);
    }
    return html;
  }

  function breakdownHtml(m) {
    const d = state.data;
    const rows = d.categories.map(c => ({ name: c.name, actual: m.byCategory[c.id] || 0, budget: num(c.budget) }));
    if (m.byCategory.uncategorized) rows.push({ name: 'Uncategorized', actual: m.byCategory.uncategorized, budget: 0 });
    const shown = rows.filter(r => r.actual > 0 || r.budget > 0).sort((a, b) => b.actual - a.actual);
    if (!shown.length) return `<p class="muted">Nothing spent yet this month.</p>`;
    const max = Math.max(...shown.map(r => Math.max(r.actual, r.budget)));
    const total = m.expenses || 1;
    return `<div class="cat-list">${shown.map(r => {
      const over = r.budget > 0 && r.actual > r.budget;
      return `<div class="cat-row">
        <div class="row-between"><span>${esc(r.name)} <span class="muted small">${Math.round((r.actual / total) * 100)}%</span></span>
          <span class="num">${fmt(r.actual)}${r.budget ? ` <span class="muted">/ ${fmt0(r.budget)}</span>` : ''}</span></div>
        <div class="meter" title="${esc(r.name)}: ${fmt(r.actual)}${r.budget ? ` of ${fmt(r.budget)} budget` : ''}">
          <div class="meter-fill ${over ? 'over' : ''}" style="width:${(r.actual / max) * 100}%"></div>
          ${r.budget ? `<div class="meter-budget" style="left:${(r.budget / max) * 100}%"></div>` : ''}
        </div>
        ${over ? `<div class="status-line bad">${icon('bad')} Over budget by ${fmt(r.actual - r.budget)}</div>` : ''}
      </div>`;
    }).join('')}</div>
    <p class="muted small legend-note"><span class="budget-tick"></span> = your budget</p>`;
  }

  // --------------------------------------------------------------- insights
  function insights(key) {
    const d = state.data;
    const out = [];
    const m = Calc.month(d, key);
    const prevKey = Calc.addMonths(key, -1);
    const p = Calc.month(d, prevKey);
    const isCurrentOrPast = key <= Calc.monthKey();

    // 1. Savings rate vs your recent average
    const recent = Calc.history(d, prevKey, 3).filter(h => h.logged && h.rate != null);
    if (m.income > 0 && m.logged) {
      const avg = recent.length ? recent.reduce((s, h) => s + h.rate, 0) / recent.length : null;
      let text = m.saved >= 0
        ? `You saved <b>${pct(m.rate)}</b> of your income (${fmt0(m.saved)})`
        : `You spent <b>${fmt0(-m.saved)} more</b> than you earned`;
      if (avg != null) text += `. Your average over the previous ${recent.length} month${recent.length > 1 ? 's' : ''} is ${pct(avg)}.`;
      const tone = m.saved < 0 ? 'bad' : (avg != null && m.rate < avg - 0.05) ? 'warn' : 'good';
      out.push({ tone, text });
    }

    // 2. Budgets
    for (const c of d.categories) {
      const b = num(c.budget);
      const a = m.byCategory[c.id] || 0;
      if (b <= 0) continue;
      if (a > b) out.push({ tone: 'bad', text: `<b>${esc(c.name)}</b> is ${fmt0(a - b)} over budget (${fmt0(a)} of ${fmt0(b)}).` });
      else if (a >= b * 0.9 && a > 0) out.push({ tone: 'warn', text: `<b>${esc(c.name)}</b> is close to its budget (${fmt0(a)} of ${fmt0(b)}).` });
    }

    // 3. Biggest change vs last month (variable categories)
    if (m.logged && p.logged) {
      const changes = d.categories.filter(c => c.kind === 'variable').map(c => {
        const a = m.byCategory[c.id] || 0, b = p.byCategory[c.id] || 0;
        return { c, a, b, d: a - b };
      });
      const up = changes.filter(x => x.d >= 25 && x.b > 0 && x.d / x.b >= 0.2).sort((x, y) => y.d - x.d)[0];
      const down = changes.filter(x => x.d <= -25 && x.b > 0 && -x.d / x.b >= 0.2).sort((x, y) => x.d - y.d)[0];
      if (up) out.push({ tone: 'warn', text: `<b>${esc(up.c.name)}</b> went up ${fmt0(up.d)} (+${Math.round((up.d / up.b) * 100)}%) compared to ${monthName(prevKey)}.` });
      if (down) out.push({ tone: 'good', text: `<b>${esc(down.c.name)}</b> went down ${fmt0(-down.d)} (−${Math.round((-down.d / down.b) * 100)}%) compared to ${monthName(prevKey)}.` });
    }

    // 4. Biggest cost
    const top = Object.entries(m.byCategory).sort((a, b) => b[1] - a[1])[0];
    if (top && m.expenses > 0) {
      out.push({ tone: 'info', text: `Your biggest cost is <b>${esc(catName(top[0]))}</b>: ${Math.round((top[1] / m.expenses) * 100)}% of everything you spent.` });
    }

    // 5. Subscriptions
    const subs = d.items.filter(i => i.subscription && i.type === 'expense' && Calc.isActive(i, key));
    if (subs.length) {
      const perMonth = subs.reduce((s, i) => s + Calc.perMonth(i), 0);
      const share = m.income > 0 ? ` (${pct(perMonth / m.income)} of your income)` : '';
      out.push({ tone: 'info', text: `You have <b>${subs.length} subscriptions</b> costing ${fmt(perMonth)}/month, or <b>${fmt0(perMonth * 12)} a year</b>${share}.` });
      const fresh = subs.filter(i => i.startMonth && Calc.diff(i.startMonth, key) >= 0 && Calc.diff(i.startMonth, key) <= 1);
      if (fresh.length) out.push({ tone: 'warn', text: `New subscription${fresh.length > 1 ? 's' : ''}: ${fresh.map(i => `<b>${esc(i.name)}</b>`).join(', ')}. Still worth it?` });
    }

    // 6. Upcoming non-monthly charges
    const nextKey = Calc.addMonths(key, 1);
    const upcoming = d.items.filter(i => i.type === 'expense' && i.frequency !== 'monthly' && Calc.isDue(i, nextKey));
    if (upcoming.length) {
      out.push({ tone: 'info', text: `Coming up in ${monthName(nextKey)}: ${upcoming.map(i => `<b>${esc(i.name)}</b> ${fmt(i.amount)} (${i.frequency})`).join(', ')}.` });
    }

    // 7. Goals
    for (const g of d.goals) {
      const gp = Calc.goalProgress(d, g, key);
      if (gp.done) { out.push({ tone: 'good', text: `Goal reached: <b>${esc(g.name)}</b>! 🎉` }); continue; }
      if (gp.neededPerMonth == null || !g.deadline) continue;
      if (gp.avgRecent >= gp.neededPerMonth * 0.95) {
        out.push({ tone: 'good', text: `<b>${esc(g.name)}</b> is on track. You need ${fmt0(gp.neededPerMonth)}/month and you've been adding ${fmt0(gp.avgRecent)}/month.` });
      } else {
        out.push({ tone: 'warn', text: `<b>${esc(g.name)}</b> needs ${fmt0(gp.neededPerMonth)}/month to finish by ${Calc.label(g.deadline)}. Recently you've added ${fmt0(gp.avgRecent)}/month.` });
      }
    }

    // 8. Reminder
    if (!m.logged && isCurrentOrPast && d.items.length) {
      out.unshift({ tone: 'info', text: `You haven't logged variable spending for ${monthName(key)} yet.` });
    }
    return out;
  }

  function insightsHtml(key) {
    const list = insights(key);
    if (!list.length) return `<p class="muted">Insights appear here once you've added some income and expenses.</p>`;
    return `<ul class="insights">${list.map(i => `<li class="insight ${i.tone}">${icon(i.tone)}<span>${i.text}</span></li>`).join('')}</ul>`;
  }

  // ------------------------------------------------------------ month entry
  function monthView() {
    const d = state.data;
    const key = state.month;
    const m = Calc.month(d, key);
    const entry = d.months[key] || {};
    const prevEntry = d.months[Calc.addMonths(key, -1)];
    const variableCats = d.categories.filter(c => c.kind === 'variable');

    const lineRow = l => {
      const id = `ov-${l.item.id}`;
      return `<div class="line-row">
        <label for="${id}">${esc(l.item.name)}
          ${l.item.frequency !== 'monthly' ? `<span class="pill">${l.item.frequency}</span>` : ''}
          ${l.item.subscription ? `<span class="pill">subscription</span>` : ''}
          ${l.overridden ? `<span class="pill changed">changed this month · usually ${fmt(l.usual)}</span>` : ''}</label>
        <div class="amount-input"><span>€</span><input id="${id}" inputmode="decimal" autocomplete="off" data-change="override" data-id="${l.item.id}" value="${toInput(l.amount)}"></div>
        ${l.overridden ? `<button class="icon-btn" data-click="reset-override" data-id="${l.item.id}" title="Back to usual amount" aria-label="Reset ${esc(l.item.name)} to usual amount">↺</button>` : '<span class="icon-spacer"></span>'}
        <button class="icon-btn" data-click="edit-item" data-id="${l.item.id}" title="Edit ${esc(l.item.name)} (amount, start or end month)" aria-label="Edit ${esc(l.item.name)}">✎</button>
      </div>`;
    };

    const summary = `<section class="kpis compact">
      ${kpi('Income', fmt(m.income))}${kpi('Expenses', fmt(m.expenses))}
      ${kpi(m.saved >= 0 ? 'Saved' : 'Overspent', fmt(Math.abs(m.saved)))}${kpi('Savings rate', pct(m.rate))}
    </section>`;

    const income = card('Income', m.incomeLines.length
      ? `<p class="hint">Filled in from your fixed items. Earned a different amount this month? Just change the number.</p>${m.incomeLines.map(lineRow).join('')}`
      : `<p class="muted">No fixed income yet. <button class="btn small" data-click="add-item" data-type="income">Add your salary</button></p>`);

    const fixed = card('Fixed costs & subscriptions', m.expenseLines.length
      ? `<p class="hint">These fill in automatically. Change a number only if it was different this month.</p>${m.expenseLines.map(lineRow).join('')}`
      : `<p class="muted">No fixed costs yet. <button class="btn small" data-click="tab" data-tab="recurring">Add fixed costs</button></p>`);

    const canCopy = prevEntry && prevEntry.variable && Object.keys(prevEntry.variable).length && !Object.keys(entry.variable || {}).length;
    const variable = card('Variable spending (monthly totals)', `
      <p class="hint">A rough total per category is enough. Check your banking app for the month's numbers.</p>
      ${variableCats.map(c => {
        const id = `var-${c.id}`;
        const v = entry.variable && entry.variable[c.id];
        const b = num(c.budget);
        const a = num(v);
        const over = b > 0 && a > b;
        return `<div class="line-row">
          <label for="${id}">${esc(c.name)} ${b ? `<span class="muted small">budget ${fmt0(b)}</span>` : ''}
            ${b && v != null ? `<span class="pill ${over ? 'bad' : 'good'}">${over ? `${fmt0(a - b)} over` : `${fmt0(b - a)} left`}</span>` : ''}</label>
          <div class="amount-input"><span>€</span><input id="${id}" inputmode="decimal" autocomplete="off" placeholder="0" data-change="variable" data-id="${c.id}" value="${toInput(v)}"></div>
          <span class="icon-spacer"></span>
        </div>`;
      }).join('')}
      ${!variableCats.length ? `<p class="muted">No variable categories. Add some under Budgets.</p>` : ''}`,
      '', canCopy ? `<button class="btn ghost small" data-click="copy-last-month">Copy last month's numbers</button>` : '');

    const extras = card('One-off items', `
      <p class="hint">Anything unusual: a tax refund, a freelance job, a holiday, a big purchase.</p>
      ${(entry.extras || []).map(x => `<div class="extra-row">
          <span class="pill ${x.type === 'income' ? 'good' : ''}">${x.type === 'income' ? 'income' : esc(catName(x.categoryId))}</span>
          <span class="grow">${esc(x.name)}</span><span class="num">${x.type === 'income' ? '+' : '−'}${fmt(x.amount)}</span>
          <button class="icon-btn" data-click="delete-extra" data-id="${x.id}" aria-label="Remove ${esc(x.name)}">✕</button>
        </div>`).join('')}
      <form class="inline-form" data-submit="extra">
        <input name="name" placeholder="What was it?" required aria-label="Description">
        <select name="type" aria-label="Type"><option value="expense">Expense</option><option value="income">Income</option></select>
        <select name="categoryId" aria-label="Category">${d.categories.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
        <input name="amount" inputmode="decimal" placeholder="Amount" required aria-label="Amount" class="short">
        <button class="btn">Add</button>
      </form>`);

    const goals = d.goals.length ? card('Put towards savings goals', `
      <p class="hint">How much did you move to each goal this month?</p>
      ${d.goals.map(g => {
        const id = `contrib-${g.id}`;
        const v = entry.contributions && entry.contributions[g.id];
        return `<div class="line-row"><label for="${id}">${esc(g.name)}</label>
          <div class="amount-input"><span>€</span><input id="${id}" inputmode="decimal" autocomplete="off" placeholder="0" data-change="contribution" data-id="${g.id}" value="${toInput(v)}"></div>
          <span class="icon-spacer"></span></div>`;
      }).join('')}`) : '';

    const note = card('Notes', `<textarea id="month-note" data-change="note" rows="2" placeholder="Anything special this month?">${esc(entry.note || '')}</textarea>`);

    const nw = Calc.netWorth(d, key);
    const openAccounts = (d.accounts || []).filter(a => !a.closedMonth || key <= a.closedMonth);
    const balances = card('Account balances', openAccounts.length ? `
      <p class="hint">What's in each account at the end of the month. Estimates are fine for investments and collectibles.
      Leave an account empty to keep its last value.</p>
      ${openAccounts.map(a => balanceRow(a, entry, nw)).join('')}` :
      `<p class="muted">Track your net worth by adding your accounts. <button class="btn small" data-click="tab" data-tab="networth">Set up net worth</button></p>`);

    return `${pageHead('Log your month', 'A few minutes once a month keeps everything up to date.')}${summary}
      <div class="grid-2"><div>${income}${variable}${balances}</div><div>${fixed}${extras}${goals}${note}</div></div>`;
  }

  // ------------------------------------------------------------- recurring
  function recurringView() {
    const d = state.data;
    const key = state.month;
    const active = d.items.filter(i => Calc.isActive(i, key));
    const inactive = d.items.filter(i => !Calc.isActive(i, key));
    const incomeItems = active.filter(i => i.type === 'income');
    const fixedItems = active.filter(i => i.type === 'expense' && !i.subscription);
    const subs = active.filter(i => i.type === 'expense' && i.subscription);
    const sum = list => list.reduce((s, i) => s + Calc.perMonth(i), 0);
    const inc = sum(incomeItems), fix = sum(fixedItems), sub = sum(subs);

    const table = (list, emptyText) => list.length ? `<div class="table-wrap"><table class="table">
      <thead><tr><th>Name</th><th>Category</th><th class="num">Amount</th><th class="num">Per month</th><th class="num">Per year</th><th>Since</th><th></th></tr></thead>
      <tbody>${list.map(i => `<tr>
        <td><b>${esc(i.name)}</b>${i.notes ? `<div class="muted small">${esc(i.notes)}</div>` : ''}</td>
        <td>${i.type === 'income' ? '<span class="muted">Income</span>' : esc(catName(i.categoryId))}</td>
        <td class="num">${fmt(i.amount)} <span class="muted small">${i.frequency === 'monthly' ? '/mo' : i.frequency === 'quarterly' ? '/qtr' : '/yr'}</span></td>
        <td class="num">${fmt(Calc.perMonth(i))}</td>
        <td class="num">${fmt0(Calc.perMonth(i) * 12)}</td>
        <td class="small">${i.startMonth ? Calc.label(i.startMonth, { month: 'short', year: 'numeric' }) : ''}${i.endMonth ? ` – ${Calc.label(i.endMonth, { month: 'short', year: 'numeric' })}` : ''}</td>
        <td class="actions">
          <button class="btn ghost small" data-click="edit-item" data-id="${i.id}">Edit</button>
          ${Calc.isActive(i, key) && !i.endMonth ? `<button class="btn ghost small" data-click="stop-item" data-id="${i.id}" title="Stop after ${monthName(key)}, keeping history">Stop</button>` : ''}
          <button class="btn ghost small danger" data-click="delete-item" data-id="${i.id}" aria-label="Delete ${esc(i.name)}">Delete</button>
        </td></tr>`).join('')}</tbody></table></div>` : `<p class="muted">${emptyText}</p>`;

    return `${pageHead('Fixed &amp; subscriptions', 'Everything that comes back regularly. These are counted automatically each month, so you only enter them once.')}
      <section class="kpis">
        ${kpi('Fixed income', `${fmt0(inc)}<small>/mo</small>`)}
        ${kpi('Fixed costs', `${fmt0(fix)}<small>/mo</small>`)}
        ${kpi('Subscriptions', `${fmt0(sub)}<small>/mo</small>`, `${fmt0(sub * 12)} per year`)}
        ${kpi('Left for everything else', fmt0(inc - fix - sub), inc > 0 ? `${pct((inc - fix - sub) / inc)} of your income` : '')}
      </section>
      ${card('Income', table(incomeItems, 'No fixed income yet.'), '', `<button class="btn primary small" data-click="add-item" data-type="income">+ Add income</button>`)}
      ${card('Fixed costs', table(fixedItems, 'No fixed costs yet. Think rent, energy, insurance, phone, internet.'), '', `<button class="btn primary small" data-click="add-item" data-type="expense">+ Add fixed cost</button>`)}
      ${card('Subscriptions', table(subs, 'No subscriptions yet. Think streaming, music, cloud storage, apps, gym.'), '', `<button class="btn primary small" data-click="add-item" data-type="subscription">+ Add subscription</button>`)}
      ${inactive.length ? `<details class="card"><summary><b>Stopped or not started yet (${inactive.length})</b></summary>${table(inactive, '')}</details>` : ''}`;
  }

  function openItemDialog(item, preset) {
    const d = state.data;
    const editing = !!item;
    const subsCat = (d.categories.find(c => c.name === 'Subscriptions') || d.categories[0] || {}).id;
    const it = item || {
      name: '', amount: '', frequency: 'monthly', startMonth: state.month, endMonth: null, notes: '',
      type: preset === 'income' ? 'income' : 'expense',
      subscription: preset === 'subscription',
      categoryId: preset === 'subscription' ? subsCat : (d.categories[0] || {}).id,
    };
    const what = it.type === 'income' ? 'income' : it.subscription ? 'subscription' : 'fixed cost';
    const modal = $('#modal');
    modal.innerHTML = `<form class="modal-form" data-submit="item" data-type="${it.type}">
      <h2>${editing ? `Edit ${esc(it.name)}` : `Add ${what}`}</h2>
      <input type="hidden" name="id" value="${esc(item ? item.id : '')}">
      <label>Name <input name="name" required value="${esc(it.name)}" placeholder="${it.type === 'income' ? 'e.g. Salary' : it.subscription ? 'e.g. Netflix' : 'e.g. Rent'}"></label>
      <div class="row2">
        <label>Type <select name="type" data-change="item-type">
          <option value="expense" ${it.type === 'expense' ? 'selected' : ''}>Expense</option>
          <option value="income" ${it.type === 'income' ? 'selected' : ''}>Income</option></select></label>
        <label>Amount (€) <input name="amount" inputmode="decimal" required value="${toInput(it.amount)}" placeholder="0,00"></label>
      </div>
      <div class="row2">
        <label>How often <select name="frequency">
          ${['monthly', 'quarterly', 'yearly'].map(f => `<option value="${f}" ${it.frequency === f ? 'selected' : ''}>${f[0].toUpperCase() + f.slice(1)}</option>`).join('')}</select></label>
        <label class="expense-only">Category <select name="categoryId">
          ${d.categories.map(c => `<option value="${c.id}" ${it.categoryId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      </div>
      <label class="check expense-only"><input type="checkbox" name="subscription" ${it.subscription ? 'checked' : ''}> This is a subscription (streaming, apps, gym…)</label>
      <div class="row2">
        <label>Starts <input type="month" name="startMonth" required value="${esc(it.startMonth || state.month)}"></label>
        <label>Ends <span class="muted small">(optional, last month it counts)</span> <input type="month" name="endMonth" value="${esc(it.endMonth || '')}"></label>
      </div>
      ${editing ? `<label>A new amount or frequency applies from <input type="month" name="applyFrom" value="${esc(state.month > it.startMonth ? state.month : it.startMonth)}">
        <span class="muted small">Earlier months keep the old amount, so your history stays correct (handy for a raise or price increase).</span></label>` : ''}
      <label>Notes <span class="muted small">(optional)</span> <input name="notes" value="${esc(it.notes || '')}"></label>
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-click="close-modal">Cancel</button>
        <button class="btn primary">Save</button>
      </div>
    </form>`;
    modal.showModal();
    modal.querySelector('input[name=name]').focus();
  }

  function saveItem(form) {
    const d = state.data;
    const f = new FormData(form);
    const amount = parseAmount(f.get('amount'));
    if (!(amount >= 0)) return toast('Please enter a valid amount, like 13,99');
    const type = f.get('type');
    const vals = {
      name: String(f.get('name')).trim(),
      type,
      amount,
      frequency: f.get('frequency'),
      categoryId: type === 'expense' ? f.get('categoryId') : null,
      subscription: type === 'expense' && f.get('subscription') === 'on',
      startMonth: f.get('startMonth') || state.month,
      endMonth: f.get('endMonth') || null,
      notes: String(f.get('notes') || '').trim(),
    };
    if (vals.endMonth && vals.endMonth < vals.startMonth) return toast('The end month is before the start month.');

    const id = f.get('id');
    let message = `Saved ${vals.name}`;
    if (id) {
      const item = d.items.find(i => i.id === id);
      const applyFrom = f.get('applyFrom');
      const moneyChanged = item.amount !== vals.amount || item.frequency !== vals.frequency;
      if (moneyChanged && applyFrom && applyFrom > item.startMonth && vals.startMonth === item.startMonth) {
        // Split: the old version ends the month before, the new version starts at applyFrom.
        d.items.push({ ...item, ...vals, id: uid(), startMonth: applyFrom });
        Object.assign(item, { name: vals.name, categoryId: vals.categoryId, subscription: vals.subscription, endMonth: Calc.addMonths(applyFrom, -1) });
        message = `${vals.name} updated. The new amount counts from ${Calc.label(applyFrom)}.`;
      } else {
        Object.assign(item, vals);
      }
    } else {
      d.items.push({ id: uid(), ...vals });
    }
    $('#modal').close();
    commit(message);
  }

  // ---------------------------------------------------------------- budgets
  function budgetsView() {
    const d = state.data;
    const key = state.month;
    const m = Calc.month(d, key);
    const hist = Calc.history(d, Calc.addMonths(key, -1), 3).filter(h => h.logged);
    const avg = id => hist.length ? hist.reduce((s, h) => s + (h.byCategory[id] || 0), 0) / hist.length : null;
    const totalBudget = d.categories.reduce((s, c) => s + num(c.budget), 0);
    const fixedIncome = d.items.filter(i => i.type === 'income' && Calc.isActive(i, key)).reduce((s, i) => s + Calc.perMonth(i), 0);
    const used = new Set([...d.items.map(i => i.categoryId), ...Object.values(d.months).flatMap(e => [...Object.keys(e.variable || {}), ...(e.extras || []).map(x => x.categoryId)])]);

    const rows = d.categories.map(c => {
      const a = m.byCategory[c.id] || 0;
      const b = num(c.budget);
      const av = avg(c.id);
      const status = !b ? '' : a > b ? `<span class="status-line bad">${icon('bad')} ${fmt0(a - b)} over</span>`
        : a >= b * 0.9 ? `<span class="status-line warn">${icon('warn')} Close</span>`
        : `<span class="status-line good">${icon('good')} ${fmt0(b - a)} left</span>`;
      return `<tr>
        <td><input id="cn-${c.id}" class="plain-input" data-change="cat-name" data-id="${c.id}" value="${esc(c.name)}" aria-label="Category name"></td>
        <td><select id="ck-${c.id}" data-change="cat-kind" data-id="${c.id}" aria-label="Kind">
          <option value="variable" ${c.kind === 'variable' ? 'selected' : ''}>Variable (log monthly)</option>
          <option value="fixed" ${c.kind === 'fixed' ? 'selected' : ''}>Fixed (from fixed items)</option></select></td>
        <td class="num"><div class="amount-input"><span>€</span><input id="cb-${c.id}" inputmode="decimal" autocomplete="off" placeholder="none" data-change="budget" data-id="${c.id}" value="${toInput(c.budget)}"></div></td>
        <td class="num">${fmt(a)}</td>
        <td class="num">${av == null ? '—' : fmt0(av)}</td>
        <td>${status}</td>
        <td class="actions">${used.has(c.id) ? '' : `<button class="btn ghost small danger" data-click="delete-category" data-id="${c.id}" aria-label="Delete ${esc(c.name)}">Delete</button>`}</td>
      </tr>`;
    }).join('');

    return `${pageHead('Budgets', 'Set a monthly limit for the categories you want to keep an eye on. The 3-month average shows what you <i>actually</i> spend, a good starting point for a realistic budget.')}
      <section class="kpis">
        ${kpi('Total budgeted', fmt0(totalBudget))}
        ${kpi('Fixed income', fmt0(fixedIncome))}
        ${kpi('Unbudgeted income', fmt0(fixedIncome - totalBudget), fixedIncome > 0 ? 'available to save or spend' : '')}
      </section>
      ${card(`Categories in ${monthName(key)}`, `<div class="table-wrap"><table class="table budgets">
        <thead><tr><th>Category</th><th>Kind</th><th class="num">Monthly budget</th><th class="num">This month</th><th class="num">3-mo avg</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>
        <form class="inline-form" data-submit="category">
          <input name="name" placeholder="New category name" required aria-label="New category name">
          <select name="kind" aria-label="Kind"><option value="variable">Variable</option><option value="fixed">Fixed</option></select>
          <button class="btn">Add category</button>
        </form>
        <p class="muted small">Categories that are in use can't be deleted, but you can rename them.</p>`)}`;
  }

  // ------------------------------------------------------------------ goals
  function goalsView() {
    const d = state.data;
    const key = state.month;
    const cards = d.goals.map(g => {
      const gp = Calc.goalProgress(d, g, key);
      let status = '';
      if (gp.done) status = `<div class="status-line good">${icon('good')} Goal reached!</div>`;
      else if (gp.neededPerMonth != null) {
        const onTrack = gp.avgRecent >= gp.neededPerMonth * 0.95;
        status = `<div class="status-line ${onTrack ? 'good' : 'warn'}">${icon(onTrack ? 'good' : 'warn')} ${onTrack ? 'On track' : 'Behind schedule'}: need ${fmt0(gp.neededPerMonth)}/month, recently ${fmt0(gp.avgRecent)}/month</div>`;
      }
      return `<section class="card goal-card">
        <div class="card-head"><h2>${esc(g.name)}</h2>
          <div><button class="btn ghost small" data-click="edit-goal" data-id="${g.id}">Edit</button>
          <button class="btn ghost small danger" data-click="delete-goal" data-id="${g.id}">Delete</button></div></div>
        <div class="goal-amount"><span class="big">${fmt0(gp.saved)}</span> <span class="muted">of ${fmt0(gp.target)}</span></div>
        <div class="progress large"><div style="width:${gp.pct * 100}%"></div></div>
        <div class="row-between small"><span>${pct(gp.pct)} done</span><span>${fmt0(gp.remaining)} to go${g.deadline ? ` · by ${Calc.label(g.deadline)}` : ''}</span></div>
        ${status}
      </section>`;
    }).join('');
    return `${pageHead('Savings goals', 'Give your savings a purpose. Log how much you put towards each goal in <b>Log</b>.')}
      <div class="toolbar"><button class="btn primary" data-click="add-goal">+ New goal</button></div>
      ${d.goals.length ? `<div class="grid-2">${cards}</div>` : card('', `<p class="muted">No goals yet. Ideas: an emergency fund (3–6 months of expenses), a holiday, a new laptop.</p>`)}`;
  }

  function openGoalDialog(goal) {
    const g = goal || { name: '', target: '', startAmount: '', deadline: '' };
    const modal = $('#modal');
    modal.innerHTML = `<form class="modal-form" data-submit="goal">
      <h2>${goal ? 'Edit goal' : 'New savings goal'}</h2>
      <input type="hidden" name="id" value="${esc(goal ? goal.id : '')}">
      <label>Name <input name="name" required value="${esc(g.name)}" placeholder="e.g. Emergency fund"></label>
      <div class="row2">
        <label>Target (€) <input name="target" inputmode="decimal" required value="${toInput(g.target)}"></label>
        <label>Already saved (€) <input name="startAmount" inputmode="decimal" value="${toInput(g.startAmount)}" placeholder="0"></label>
      </div>
      <label>Target date <span class="muted small">(optional)</span> <input type="month" name="deadline" value="${esc(g.deadline || '')}"></label>
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-click="close-modal">Cancel</button>
        <button class="btn primary">Save</button>
      </div>
    </form>`;
    modal.showModal();
    modal.querySelector('input[name=name]').focus();
  }

  // ------------------------------------------------------------------- data
  function dataView() {
    let conn;
    if (state.conn === 'drive') {
      const url = DataStore.fileUrl();
      conn = `<div class="status-line good">${icon('good')} Signed in. Every change is saved to <b>${DataStore.FILE_NAME}</b> in your Google Drive.</div>
        <div class="button-row">
          <button class="btn" data-click="sync-now">Sync now</button>
          ${url ? `<a class="btn" href="${url}" target="_blank" rel="noopener">View file in Google Drive</a>` : ''}
          <button class="btn ghost" data-click="sign-out">Sign out on this device</button>
        </div>`;
    } else if (state.conn === 'signin') {
      conn = `<div class="status-line warn">${icon('warn')} Not signed in. You're seeing the copy saved on this device${DataStore.getSync().dirty ? ', which has changes that are not in Google Drive yet' : ''}.</div>
        <div class="button-row"><button class="btn primary" data-click="sign-in">Sign in with Google</button></div>`;
    } else {
      conn = `<div class="status-line warn">${icon('warn')} Google sign-in isn't set up yet, so data is only saved on this device. Add your client ID to <code>js/config.js</code>.</div>`;
    }

    const theme = getTheme();
    return `${pageHead('Settings', '', false)}
      <div class="grid-2">
        ${card('You', `<div class="setting-row"><div><b>Your first name</b><p>Used for the greeting on the home page.</p></div>
          <input id="set-name" data-change="set-name" value="${esc(state.data.settings.name || '')}" placeholder="e.g. Nick" autocomplete="given-name"></div>`)}
        ${card('Appearance', `<div class="setting-row"><div><b>Theme</b><p>Auto follows your device's light/dark setting.</p></div>
          <div class="segmented" role="group" aria-label="Theme">
            ${['auto', 'light', 'dark'].map(t => `<button data-click="set-theme" data-theme="${t}" class="${theme === t ? 'active' : ''}" aria-pressed="${theme === t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
          </div></div>`)}
      </div>
      ${card('Google Drive sync', `${conn}
        <div class="explain">
          <h3>How it works on all your devices</h3>
          <ol>
            <li>Open the Financial Hub's web address on any device (PC, Mac or phone) and sign in with the same Google account.</li>
            <li>Changes are saved to Google Drive automatically. When you come back to the app, it picks up changes from your other devices.</li>
            <li>For privacy, Google sign-ins only last about an hour. After that, tap <b>Sign in</b> once (no password needed if you're already logged in to Google).</li>
            <li>Avoid editing on two devices at the same moment. If that happens, the most recent edit wins.</li>
          </ol>
          <h3>Put it on your phone's home screen</h3>
          <ul>
            <li><b>iPhone:</b> open the address in Safari → Share button → <i>Add to Home Screen</i>.</li>
            <li><b>Android:</b> open it in Chrome → ⋮ menu → <i>Add to Home screen</i>.</li>
          </ul>
        </div>`)}
      ${card('Backups in Google Drive', state.conn === 'drive' ? `
        <p>Once a month a copy of your data is saved in the <b>Financial Hub backups</b> folder in your Drive. The newest 12 are kept.
          Made a mistake? Restore an earlier copy here.</p>
        <div id="backup-list">${backupListHtml()}</div>
        <div class="button-row">
          <button class="btn" data-click="backup-now">Back up now</button>
          ${DataStore.backupFolderUrl() ? `<a class="btn ghost" href="${DataStore.backupFolderUrl()}" target="_blank" rel="noopener">Open backups folder</a>` : ''}
        </div>` : `<p class="muted">Sign in to see and restore your backups.</p>`)}
      ${card('Backup file', `<p>Download a copy of everything as a JSON file, or restore from one.</p>
        <div class="button-row"><button class="btn" data-click="export">Export backup</button><button class="btn" data-click="import">Import backup…</button></div>`)}
      ${card('Example data & reset', `
        <div class="button-row">
          <button class="btn" data-click="load-example">Load example data</button>
          <button class="btn danger" data-click="reset-all">Erase all data</button>
        </div>
        <p class="muted small">Both of these replace your current data${state.conn !== 'local' ? ', including the copy in Google Drive' : ''}. Export a backup first if you want to keep it.</p>`)}`;
  }

  // state.backups: null = not loaded yet, 'loading', 'error', or the list from Drive.
  function backupListHtml() {
    const b = state.backups;
    if (b == null || b === 'loading') {
      if (b == null) loadBackups();
      return `<p class="muted small">Loading backups…</p>`;
    }
    if (b === 'error') return `<p class="muted small">Couldn't load your backups. <button class="btn ghost small" data-click="reload-backups">Try again</button></p>`;
    if (!b.length) return `<p class="muted small">No backups yet. The first one is made automatically, or tap <b>Back up now</b>.</p>`;
    const when = t => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    return `<div class="table-wrap"><table class="table">
      <thead><tr><th>Backup</th><th>Made on</th><th></th></tr></thead>
      <tbody>${b.map(x => `<tr>
        <td>${x.kind === 'auto' && x.month ? `Monthly · ${esc(Calc.label(x.month))}` : 'Made by hand'}</td>
        <td class="small">${esc(when(x.createdTime))}</td>
        <td class="actions"><button class="btn ghost small" data-click="restore-backup" data-id="${esc(x.id)}" data-when="${esc(when(x.createdTime))}">Restore</button></td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  async function loadBackups() {
    state.backups = 'loading';
    try {
      state.backups = await DataStore.listBackups();
    } catch (e) {
      console.warn(e);
      state.backups = 'error';
      if (e.auth) { state.backups = null; state.conn = 'signin'; }
    }
    if (state.tab === 'data') scheduleRender();
  }

  // -------------------------------------------------------------- theme
  const THEME_KEY = 'financialHub.theme';
  function getTheme() {
    try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch (e) { return 'auto'; }
  }
  function setTheme(t) {
    try { if (t === 'auto') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, t); } catch (e) { /* ignore */ }
    if (t === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
  }

  // ------------------------------------------------------------- net worth
  // Each type has a fixed chart color slot, in the order the palette was validated for
  // (so neighbours in the composition bar are always easy to tell apart).
  const ACCOUNT_TYPES = [
    { id: 'bank', label: 'Bank account', plural: 'Bank accounts', color: 'var(--series-1)' },
    { id: 'collectible', label: 'Collectibles', plural: 'Collectibles', color: 'var(--series-2)' },
    { id: 'investment', label: 'Investments', plural: 'Investments', color: 'var(--series-3)' },
    { id: 'savings', label: 'Savings account', plural: 'Savings', color: 'var(--series-4)' },
    { id: 'other', label: 'Other asset', plural: 'Other', color: 'var(--series-5)' },
    { id: 'debt', label: 'Debt / loan', plural: 'Debts', color: 'var(--muted)' },
  ];
  const typeOf = id => ACCOUNT_TYPES.find(t => t.id === id) || ACCOUNT_TYPES[4];

  function balanceRow(a, entry, nw) {
    const id = `bal-${a.id}`;
    const t = typeOf(a.type);
    const logged = entry.balances && Object.prototype.hasOwnProperty.call(entry.balances, a.id);
    const row = nw.rows.find(r => r.account.id === a.id);
    const carried = !logged && row ? row.value : null;
    return `<div class="line-row">
      <span class="swatch" style="background:${t.color}"></span>
      <label for="${id}">${esc(a.name)} <span class="muted small">${t.label}</span>
        ${carried != null ? `<span class="pill">last: ${fmt0(carried)} (${monthShort(row.updated)})</span>` : ''}</label>
      <div class="amount-input"><span>€</span><input id="${id}" inputmode="decimal" autocomplete="off" placeholder="${carried != null ? esc(toInput(carried)) : '0'}"
        data-change="balance" data-id="${a.id}" value="${logged ? toInput(entry.balances[a.id]) : ''}"></div>
    </div>`;
  }

  function networthView(mounts) {
    const d = state.data;
    const key = state.month;
    const prevKey = Calc.addMonths(key, -1);
    const nw = Calc.netWorth(d, key);
    const prev = Calc.netWorth(d, prevKey);
    const hist = Calc.netWorthHistory(d, key, 12);
    const entry = d.months[key] || {};
    const head = pageHead('Net worth', 'Everything you own minus what you owe. Update your balances once a month.');

    if (!d.accounts.length) {
      return `${head}${card('', `<div class="welcome-inline">
        <h2>Start tracking your net worth</h2>
        <p class="page-sub">Add the things you own: bank and savings accounts, investments, and collectibles like your Pokémon cards.
        Each month you note the balances, and the hub shows how your wealth grows over time.</p>
        <div class="button-row"><button class="btn primary" data-click="add-account">+ Add your first account</button></div></div>`)}`;
    }

    const first = hist[0];
    const sinceFirst = first && hist.length > 1 ? nw.total - first.total : null;
    const m = Calc.month(d, key);
    const change = prev.has ? nw.total - prev.total : null;
    let explainer = '';
    if (change != null && m.logged) {
      const other = change - m.saved;
      explainer = `<p class="muted small">This month you saved ${fmt0(m.saved)} from your income.
        ${Math.abs(other) >= 1 ? `The other ${other > 0 ? '+' : '−'}${fmt0(Math.abs(other))} came from things like investment returns, value changes or moving money in or out.` : ''}</p>`;
    }

    const hero = `<section class="hero nw-hero-card">
      <div class="nw-hero">
        <div>
          <div class="hero-label">Net worth · end of ${monthName(key)}</div>
          <div class="hero-value">${fmt0(nw.total)}</div>
          <div class="hero-meta">${change != null ? delta(nw.total, prev.total, true, prevKey) : ''}
            ${sinceFirst != null ? `<span>${sinceFirst >= 0 ? '+' : '−'}${fmt0(Math.abs(sinceFirst))} since ${monthShort(first.key)}</span>` : ''}</div>
          ${explainer}
        </div>
        <div>${hist.length >= 2 ? '<div id="chart-networth"></div>' : '<p class="muted small">Your net worth chart appears after two months of balances.</p>'}</div>
      </div>
    </section>`;
    if (hist.length >= 2) {
      mounts.push(() => Charts.line($('#chart-networth'), {
        labels: hist.map(h => monthShort(h.key)), fullLabels: hist.map(h => Calc.label(h.key)),
        values: hist.map(h => h.total), color: 'var(--series-4)', name: 'Net worth',
        format: fmt0, axisFormat: v => compact.format(v), height: 210,
      }));
    }

    // Composition: assets only, in fixed palette order
    const assetTypes = ACCOUNT_TYPES.filter(t => t.id !== 'debt' && (nw.byType[t.id] || 0) > 0);
    const composition = nw.assets > 0 ? `
      <div class="composition" role="img" aria-label="Assets by type">
        ${assetTypes.map(t => `<div class="comp-seg" style="flex:${nw.byType[t.id]};background:${t.color}" title="${t.plural}: ${fmt0(nw.byType[t.id])}"></div>`).join('')}
      </div>
      <div class="comp-legend">
        ${assetTypes.map(t => `<div class="comp-row"><span class="swatch" style="background:${t.color}"></span>
          <span class="grow">${t.plural}</span><span class="num">${fmt0(nw.byType[t.id])}</span>
          <span class="num muted" style="width:44px">${pct(nw.byType[t.id] / nw.assets)}</span></div>`).join('')}
        ${nw.debts > 0 ? `<div class="comp-row"><span class="swatch" style="background:var(--muted)"></span>
          <span class="grow">Debts</span><span class="num">−${fmt0(nw.debts)}</span><span class="num muted" style="width:44px"></span></div>` : ''}
      </div>` : '<p class="muted">Log your balances to see what your net worth is made of.</p>';

    const open = d.accounts.filter(a => !a.closedMonth || key <= a.closedMonth);
    const closed = d.accounts.filter(a => a.closedMonth && key > a.closedMonth);
    const accounts = `${open.map(a => {
      const t = typeOf(a.type);
      const row = nw.rows.find(r => r.account.id === a.id);
      const logged = entry.balances && Object.prototype.hasOwnProperty.call(entry.balances, a.id);
      const id = `nwbal-${a.id}`;
      return `<div class="account-row">
        <span class="swatch" style="background:${t.color}"></span>
        <div class="account-name"><b>${esc(a.name)}</b><span class="small">${t.label}${a.note ? ` · ${esc(a.note)}` : ''}${row && !logged ? ` · last updated ${Calc.label(row.updated, { month: 'short', year: 'numeric' })}` : ''}</span></div>
        <div class="amount-input"><span>€</span><input id="${id}" inputmode="decimal" autocomplete="off" aria-label="${esc(a.name)} balance in ${monthName(key)}"
          placeholder="${row ? esc(toInput(row.value)) : '0'}" data-change="balance" data-id="${a.id}" value="${logged ? toInput(entry.balances[a.id]) : ''}"></div>
        <button class="icon-btn" data-click="edit-account" data-id="${a.id}" aria-label="Edit ${esc(a.name)}" title="Edit">⋯</button>
      </div>`;
    }).join('')}
    ${closed.length ? `<p class="muted small" style="margin-top:12px">Closed or sold: ${closed.map(a => esc(a.name)).join(', ')}</p>` : ''}`;

    return `${head}${hero}
      <div class="grid-2">
        ${card('What it\'s made of', composition)}
        ${card(`Balances at end of ${monthName(key)}`, `<p class="hint">Type this month's balance. Empty fields keep the last known value.</p>${accounts}`,
          '', '<button class="btn primary small" data-click="add-account">+ Add account</button>')}
      </div>`;
  }

  function openAccountDialog(acc) {
    const a = acc || { name: '', type: 'bank', note: '' };
    const modal = $('#modal');
    modal.innerHTML = `<form class="modal-form" data-submit="account">
      <h2>${acc ? `Edit ${esc(a.name)}` : 'Add an account'}</h2>
      <input type="hidden" name="id" value="${esc(acc ? acc.id : '')}">
      <label>Name <input name="name" required value="${esc(a.name)}" placeholder="e.g. ING savings, DEGIRO, Pokémon cards"></label>
      <label>Type <select name="type">${ACCOUNT_TYPES.map(t => `<option value="${t.id}" ${a.type === t.id ? 'selected' : ''}>${t.label}</option>`).join('')}</select></label>
      ${acc ? '' : `<label>Balance at end of ${monthName(state.month)} (€) <input name="balance" inputmode="decimal" placeholder="0"></label>`}
      <label>Note <span class="muted small">(optional)</span> <input name="note" value="${esc(a.note || '')}" placeholder="e.g. value from Cardmarket"></label>
      ${acc ? `<label class="check"><input type="checkbox" name="closed" ${a.closedMonth ? 'checked' : ''}> Closed or sold (stops counting after ${a.closedMonth ? Calc.label(a.closedMonth) : Calc.label(state.month)})</label>` : ''}
      <div class="modal-actions">
        ${acc ? `<button type="button" class="btn ghost danger left" data-click="delete-account" data-id="${acc.id}">Delete</button>` : ''}
        <button type="button" class="btn ghost" data-click="close-modal">Cancel</button>
        <button class="btn primary">Save</button>
      </div>
    </form>`;
    modal.showModal();
    modal.querySelector('input[name=name]').focus();
  }

  const VIEWS = { overview: overviewView, month: monthView, networth: networthView, recurring: recurringView, budgets: budgetsView, goals: goalsView, data: dataView };

  // --------------------------------------------------------------- dialogs
  function confirmDialog(title, text, okLabel = 'OK', danger = false) {
    return new Promise(resolve => {
      const modal = $('#modal');
      modal.innerHTML = `<form class="modal-form" method="dialog">
        <h2>${title}</h2><p>${text}</p>
        <div class="modal-actions">
          <button value="cancel" class="btn ghost">Cancel</button>
          <button value="ok" class="btn ${danger ? 'danger-solid' : 'primary'}">${okLabel}</button>
        </div></form>`;
      modal.returnValue = '';
      modal.addEventListener('close', () => resolve(modal.returnValue === 'ok'), { once: true });
      modal.showModal();
    });
  }

  let toastTimer;
  function toast(message) {
    const t = $('#toast');
    t.textContent = message;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3800);
  }

  // --------------------------------------------------------------- events
  const clicks = {
    'tab': el => {
      state.tab = el.dataset.tab;
      try { localStorage.setItem(TAB_KEY, state.tab); } catch (e) { /* ignore */ }
      render();
      window.scrollTo(0, 0);
    },
    'prev-month': () => { state.month = Calc.addMonths(state.month, -1); render(); },
    'next-month': () => { state.month = Calc.addMonths(state.month, 1); render(); },
    'this-month': () => { state.month = Calc.monthKey(); render(); },
    'home-mode': el => {
      state.homeMode = el.dataset.mode;
      if (state.homeMode === 'year') state.year = Number(state.month.slice(0, 4));
      try { localStorage.setItem(HOME_MODE_KEY, state.homeMode); } catch (e) { /* ignore */ }
      render();
    },
    'prev-year': () => { state.year -= 1; render(); },
    'next-year': () => { state.year = Math.min(state.year + 1, Number(Calc.monthKey().slice(0, 4))); render(); },
    'this-year': () => { state.year = Number(Calc.monthKey().slice(0, 4)); render(); },
    'set-year': el => { state.year = Number(el.dataset.year); render(); window.scrollTo(0, 0); },

    'sign-in': signIn,
    'sync-now': syncNow,
    'sign-out': async () => {
      const dirty = DataStore.getSync().dirty;
      if (dirty && DataStore.hasToken()) { try { await DataStore.upload(state.data); } catch (e) { console.error(e); } }
      const stillDirty = DataStore.getSync().dirty;
      if (!(await confirmDialog('Sign out on this device?',
        `This removes the copy of your data from this device. Everything stays safe in Google Drive.${stillDirty ? ' <b>Warning: some changes on this device are not synced yet and will be lost.</b>' : ''}`,
        'Sign out', stillDirty))) return;
      DataStore.signOut();
      DataStore.clearLocal();
      state.data = null;
      state.conn = 'signin';
      render();
    },
    'start-empty': () => { state.data = emptyData(); state.tab = 'recurring'; commit('All set. Start by adding your income and fixed costs.'); },
    'load-example': async () => {
      if (state.data && (state.data.items.length || Object.keys(state.data.months).length) &&
        !(await confirmDialog('Load example data?', 'This replaces all your current data with example numbers.', 'Replace with example', true))) return;
      state.data = exampleData();
      state.month = Calc.monthKey();
      state.tab = 'overview';
      commit('Example data loaded.');
    },
    'start-fresh': async () => {
      if (!(await confirmDialog('Start with your own data?', 'This removes the example data so you can enter your own numbers.', 'Start fresh'))) return;
      state.data = emptyData();
      state.tab = 'recurring';
      commit('All clear. Start by adding your income and fixed costs.');
    },
    'export': () => DataStore.downloadBackup(state.data, `financial-hub-backup-${new Date().toISOString().slice(0, 10)}.json`),
    'import': () => $('#import-file').click(),
    'reload-backups': () => { state.backups = null; render(); },
    'backup-now': async el => {
      el.disabled = true;
      try {
        if (DataStore.getSync().dirty) await DataStore.upload(state.data); // back up what you see, not an older copy
        await DataStore.createBackup('manual', Calc.monthKey());
        toast('Backup saved in your Google Drive.');
      } catch (e) {
        console.error(e);
        toast(e.auth ? 'Please sign in again first.' : "Couldn't make a backup. Try again in a moment.");
      }
      state.backups = null;
      render();
    },
    'restore-backup': async el => {
      if (!(await confirmDialog('Restore this backup?',
        `Your data goes back to how it was on <b>${esc(el.dataset.when)}</b>. A copy of your current data is saved as a backup first, so you can undo this.`,
        'Restore'))) return;
      try {
        if (DataStore.getSync().dirty) await DataStore.upload(state.data);
        await DataStore.createBackup('manual', Calc.monthKey()); // safety copy of the current data
        const data = await DataStore.readBackup(el.dataset.id);
        if (!isValid(data)) return toast("That backup couldn't be read.");
        useData(data);
        state.backups = null;
        commit(`Restored the backup from ${el.dataset.when}.`);
      } catch (e) {
        console.error(e);
        toast(e.auth ? 'Please sign in again first.' : "Couldn't restore the backup. Nothing was changed.");
      }
    },
    'reset-all': async () => {
      if (!(await confirmDialog('Erase all data?', 'This deletes all income, expenses, budgets and goals. It cannot be undone (unless you have a backup).', 'Erase everything', true))) return;
      state.data = emptyData();
      commit('All data erased.');
    },

    'reset-override': el => {
      const e = ensureMonth(state.month);
      delete e.overrides[el.dataset.id];
      commit();
    },
    'copy-last-month': () => {
      const prev = state.data.months[Calc.addMonths(state.month, -1)];
      ensureMonth(state.month).variable = { ...(prev.variable || {}) };
      commit("Copied last month's numbers. Adjust them to this month's.");
    },
    'delete-extra': el => {
      const e = ensureMonth(state.month);
      e.extras = e.extras.filter(x => x.id !== el.dataset.id);
      commit();
    },

    'add-item': el => openItemDialog(null, el.dataset.type),
    'edit-item': el => openItemDialog(state.data.items.find(i => i.id === el.dataset.id)),
    'stop-item': el => {
      const item = state.data.items.find(i => i.id === el.dataset.id);
      item.endMonth = state.month;
      commit(`${item.name} stopped. ${Calc.label(state.month)} is the last month it's counted.`);
    },
    'delete-item': async el => {
      const item = state.data.items.find(i => i.id === el.dataset.id);
      if (!(await confirmDialog(`Delete ${esc(item.name)}?`, 'It will also disappear from all past months. To keep your history, use <b>Stop</b> instead.', 'Delete', true))) return;
      state.data.items = state.data.items.filter(i => i.id !== item.id);
      for (const e of Object.values(state.data.months)) if (e.overrides) delete e.overrides[item.id];
      commit(`${item.name} deleted.`);
    },

    'delete-category': el => {
      state.data.categories = state.data.categories.filter(c => c.id !== el.dataset.id);
      commit();
    },

    'add-goal': () => openGoalDialog(null),
    'edit-goal': el => openGoalDialog(state.data.goals.find(g => g.id === el.dataset.id)),
    'delete-goal': async el => {
      const g = state.data.goals.find(x => x.id === el.dataset.id);
      if (!(await confirmDialog(`Delete goal "${esc(g.name)}"?`, 'Its logged contributions will be removed too.', 'Delete', true))) return;
      state.data.goals = state.data.goals.filter(x => x.id !== g.id);
      for (const e of Object.values(state.data.months)) if (e.contributions) delete e.contributions[g.id];
      commit();
    },

    'add-account': () => openAccountDialog(null),
    'edit-account': el => openAccountDialog(state.data.accounts.find(a => a.id === el.dataset.id)),
    'delete-account': async el => {
      const a = state.data.accounts.find(x => x.id === el.dataset.id);
      $('#modal').close();
      if (!(await confirmDialog(`Delete ${esc(a.name)}?`, 'All its logged balances are removed too, so your net worth history changes. If you sold it or closed it, tick <b>Closed or sold</b> instead to keep the history.', 'Delete', true))) return;
      state.data.accounts = state.data.accounts.filter(x => x.id !== a.id);
      for (const e of Object.values(state.data.months)) if (e.balances) delete e.balances[a.id];
      commit(`${a.name} deleted.`);
    },
    'set-theme': el => { setTheme(el.dataset.theme); render(); },

    'close-modal': () => $('#modal').close(),
  };

  /** Inputs with an amount: empty = remove, invalid = warn. Returns undefined (remove), a number, or null (invalid). */
  function readAmount(el) {
    if (!el.value.trim()) return undefined;
    const v = parseAmount(el.value);
    if (Number.isNaN(v)) { toast('Please enter a number, like 412,50'); render(); return null; }
    return v;
  }

  const changes = {
    'override': el => {
      const v = readAmount(el);
      if (v === null) return;
      const e = ensureMonth(state.month);
      const item = state.data.items.find(i => i.id === el.dataset.id);
      if (v === undefined || v === num(item.amount)) delete e.overrides[item.id];
      else e.overrides[item.id] = v;
      commit();
    },
    'variable': el => {
      const v = readAmount(el);
      if (v === null) return;
      const e = ensureMonth(state.month);
      if (v === undefined) delete e.variable[el.dataset.id];
      else e.variable[el.dataset.id] = v;
      commit();
    },
    'contribution': el => {
      const v = readAmount(el);
      if (v === null) return;
      const e = ensureMonth(state.month);
      if (v === undefined) delete e.contributions[el.dataset.id];
      else e.contributions[el.dataset.id] = v;
      commit();
    },
    'note': el => { ensureMonth(state.month).note = el.value; commit(); },
    'balance': el => {
      const v = readAmount(el);
      if (v === null) return;
      const e = ensureMonth(state.month);
      e.balances ||= {};
      if (v === undefined) delete e.balances[el.dataset.id];
      else e.balances[el.dataset.id] = v;
      commit();
    },
    'set-name': el => { state.data.settings.name = el.value.trim(); commit(); },
    'budget': el => {
      const v = readAmount(el);
      if (v === null) return;
      state.data.categories.find(c => c.id === el.dataset.id).budget = v === undefined ? null : v;
      commit();
    },
    'cat-name': el => {
      const name = el.value.trim();
      if (!name) return render();
      state.data.categories.find(c => c.id === el.dataset.id).name = name;
      commit();
    },
    'cat-kind': el => { state.data.categories.find(c => c.id === el.dataset.id).kind = el.value; commit(); },
    'item-type': el => { el.form.dataset.type = el.value; },
  };

  const submits = {
    'item': saveItem,
    'account': form => {
      const f = new FormData(form);
      const id = f.get('id');
      const vals = { name: String(f.get('name')).trim(), type: f.get('type'), note: String(f.get('note') || '').trim() };
      if (id) {
        const a = state.data.accounts.find(x => x.id === id);
        const closed = f.get('closed') === 'on';
        Object.assign(a, vals, { closedMonth: closed ? (a.closedMonth || state.month) : null });
      } else {
        const balance = f.get('balance') ? parseAmount(f.get('balance')) : null;
        if (Number.isNaN(balance)) return toast('Please enter a valid balance, like 1250,00');
        const acc = { id: uid(), ...vals, closedMonth: null };
        state.data.accounts.push(acc);
        if (balance != null) {
          const e = ensureMonth(state.month);
          e.balances ||= {};
          e.balances[acc.id] = balance;
        }
      }
      $('#modal').close();
      commit(`${vals.name} saved.`);
    },
    'goal': form => {
      const f = new FormData(form);
      const target = parseAmount(f.get('target'));
      const startAmount = f.get('startAmount') ? parseAmount(f.get('startAmount')) : 0;
      if (!(target > 0) || Number.isNaN(startAmount)) return toast('Please enter valid amounts.');
      const vals = { name: String(f.get('name')).trim(), target, startAmount, deadline: f.get('deadline') || null };
      const id = f.get('id');
      if (id) Object.assign(state.data.goals.find(g => g.id === id), vals);
      else state.data.goals.push({ id: uid(), ...vals });
      $('#modal').close();
      commit(`Goal "${vals.name}" saved.`);
    },
    'extra': form => {
      const f = new FormData(form);
      const amount = parseAmount(f.get('amount'));
      if (!(amount > 0)) return toast('Please enter a valid amount.');
      const type = f.get('type');
      ensureMonth(state.month).extras.push({
        id: uid(), name: String(f.get('name')).trim(), type, amount,
        categoryId: type === 'expense' ? f.get('categoryId') : null,
      });
      commit();
      setTimeout(() => { const i = document.querySelector('form[data-submit=extra] input[name=name]'); if (i) i.focus(); }, 50);
    },
    'category': form => {
      const f = new FormData(form);
      const name = String(f.get('name')).trim();
      if (!name) return;
      state.data.categories.push({ id: 'c-' + uid(), name, kind: f.get('kind'), budget: null });
      commit(`Category "${name}" added.`);
    },
  };

  document.addEventListener('click', e => {
    const el = e.target.closest('[data-click]');
    if (el && clicks[el.dataset.click]) {
      e.preventDefault();
      clicks[el.dataset.click](el, e);
    }
  });
  document.addEventListener('change', e => {
    const el = e.target.closest('[data-change]');
    if (el && changes[el.dataset.change]) changes[el.dataset.change](el, e);
  });
  // Enter in an amount field saves it right away
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.matches('input[data-change]')) e.target.blur();
  });
  document.addEventListener('submit', e => {
    const form = e.target.closest('form[data-submit]');
    if (!form) return;
    e.preventDefault();
    submits[form.dataset.submit](form);
  });
  // Clicking the dark area around a dialog closes it
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') e.target.close(); });

  $('#import-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = await DataStore.readUpload(file);
      if (!isValid(data)) return toast("That file doesn't look like Financial Hub data.");
      const hasRealData = state.data && !state.data.isExample && (state.data.items.length || Object.keys(state.data.months).length);
      if (hasRealData && !(await confirmDialog('Import this file?', `This replaces your current data with the contents of <b>${esc(file.name)}</b>.`, 'Import', true))) return;
      state.data = normalize(data);
      state.data.isExample = false;
      state.tab = 'overview';
      commit(state.conn === 'drive' ? 'Imported and saved to Google Drive.' : 'Imported.');
    } catch (err) {
      toast('Could not read that file.');
    }
  });

  window.addEventListener('focus', checkForOutsideChanges);
  // While the app is open on screen, look for changes from your other devices every minute.
  setInterval(() => { if (!document.hidden) checkForOutsideChanges(); }, 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForOutsideChanges(); });

  let lastWidth = window.innerWidth;
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (window.innerWidth !== lastWidth && ['overview', 'networth'].includes(state.tab)) { lastWidth = window.innerWidth; render(); }
    }, 150);
  });

  // ---------------------------------------------------------------- start
  function boot() {
    // Show the copy saved on this device straight away; syncing starts when you sign in.
    const local = DataStore.loadLocal();
    state.data = isValid(local) ? normalize(local) : null;
    if (DataStore.configured()) {
      state.conn = 'signin';
      DataStore.loadGoogle().catch(e => console.warn(e.message));
    } else {
      state.conn = 'local';
    }
    render();
    // Still signed in from before the refresh? Sync straight away, no sign-in needed.
    if (state.conn === 'signin' && DataStore.hasToken()) syncNow();
  }

  boot();
})();
