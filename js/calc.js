/*
 * Calc — all the money math, with no UI code.
 *
 * Months are strings like "2026-11". A recurring item (salary, rent,
 * Netflix…) counts in a month if it has started, hasn't ended, and is due
 * that month (monthly = every month, quarterly = every 3rd month from its
 * start, yearly = once a year in its start month).
 */
const Calc = (() => {
  const FREQ_MONTHS = { monthly: 1, quarterly: 3, yearly: 12 };

  const num = v => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  // ---- month helpers ----
  function monthKey(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }
  function parse(key) {
    const [y, m] = key.split('-').map(Number);
    return { y, m };
  }
  function addMonths(key, n) {
    const { y, m } = parse(key);
    return monthKey(new Date(y, m - 1 + n, 1));
  }
  /** Number of months from a to b (b - a). */
  function diff(a, b) {
    const A = parse(a), B = parse(b);
    return (B.y - A.y) * 12 + (B.m - A.m);
  }
  function label(key, opts = { month: 'long', year: 'numeric' }) {
    const { y, m } = parse(key);
    const s = new Date(y, m - 1, 1).toLocaleDateString(undefined, opts);
    return s.charAt(0).toUpperCase() + s.slice(1); // "november 2026" -> "November 2026"
  }

  // ---- recurring items ----
  function isActive(item, key) {
    if (item.startMonth && key < item.startMonth) return false;
    if (item.endMonth && key > item.endMonth) return false;
    return true;
  }
  function isDue(item, key) {
    if (!isActive(item, key)) return false;
    const step = FREQ_MONTHS[item.frequency] || 1;
    return diff(item.startMonth || key, key) % step === 0;
  }
  /** What an item costs (or earns) per month on average. */
  function perMonth(item) {
    return num(item.amount) / (FREQ_MONTHS[item.frequency] || 1);
  }

  // ---- one month ----
  function month(data, key) {
    const entry = data.months[key] || {};
    const overrides = entry.overrides || {};
    const variable = entry.variable || {};
    const extras = entry.extras || [];
    const contributions = entry.contributions || {};

    const byCategory = {};
    const add = (cat, amt) => {
      const k = cat || 'uncategorized';
      byCategory[k] = (byCategory[k] || 0) + amt;
    };

    const incomeLines = [];
    const expenseLines = [];
    let income = 0;
    let expenses = 0;

    for (const item of data.items) {
      if (!isDue(item, key)) continue;
      const overridden = Object.prototype.hasOwnProperty.call(overrides, item.id);
      const amount = overridden ? num(overrides[item.id]) : num(item.amount);
      const line = { item, amount, overridden, usual: num(item.amount) };
      if (item.type === 'income') {
        incomeLines.push(line);
        income += amount;
      } else {
        expenseLines.push(line);
        expenses += amount;
        add(item.categoryId, amount);
      }
    }

    let variableTotal = 0;
    for (const [cat, amt] of Object.entries(variable)) {
      variableTotal += num(amt);
      add(cat, num(amt));
    }
    expenses += variableTotal;

    for (const x of extras) {
      if (x.type === 'income') income += num(x.amount);
      else {
        expenses += num(x.amount);
        add(x.categoryId, num(x.amount));
      }
    }

    const saved = income - expenses;
    const contributed = Object.values(contributions).reduce((s, v) => s + num(v), 0);

    return {
      key, income, expenses, saved,
      rate: income > 0 ? saved / income : null,
      byCategory, incomeLines, expenseLines, extras, variable, variableTotal, contributed,
      logged: Object.keys(variable).length > 0 || extras.length > 0,
    };
  }

  /** The first month that has any data. */
  function firstMonth(data, fallback) {
    let first = null;
    for (const it of data.items) if (it.startMonth && (!first || it.startMonth < first)) first = it.startMonth;
    for (const k of Object.keys(data.months)) if (!first || k < first) first = k;
    return first || fallback;
  }

  /** Up to n months ending at key (oldest first), never before the first month with data. */
  function history(data, key, n = 12) {
    const first = firstMonth(data, key);
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const k = addMonths(key, -i);
      if (k < first) continue;
      out.push(month(data, k));
    }
    return out;
  }

  // ---- goals ----
  function goalProgress(data, goal, key) {
    let saved = num(goal.startAmount);
    const recent = [];
    for (const [k, entry] of Object.entries(data.months)) {
      const c = entry.contributions && entry.contributions[goal.id];
      if (c != null) saved += num(c);
    }
    for (let i = 1; i <= 3; i++) {
      const e = data.months[addMonths(key, -i)];
      recent.push(num(e && e.contributions && e.contributions[goal.id]));
    }
    const target = num(goal.target);
    const remaining = Math.max(0, target - saved);
    const monthsLeft = goal.deadline ? Math.max(0, diff(key, goal.deadline)) : null;
    const neededPerMonth = monthsLeft ? remaining / monthsLeft : (monthsLeft === 0 ? remaining : null);
    const avgRecent = recent.reduce((s, v) => s + v, 0) / recent.length;
    return {
      saved, target, remaining,
      pct: target > 0 ? Math.min(1, saved / target) : 0,
      monthsLeft, neededPerMonth, avgRecent,
      done: target > 0 && saved >= target,
    };
  }

  // ---- net worth ----
  // Balances are logged per month in months[key].balances = { accountId: amount }.
  // An account keeps its last logged balance until you log a new one
  // (handy for things you only re-value now and then, like collectibles).
  function netWorth(data, key) {
    const accounts = data.accounts || [];
    const keys = Object.keys(data.months).filter(k => k <= key).sort();
    const rows = [];
    for (const account of accounts) {
      if (account.closedMonth && key > account.closedMonth) continue;
      let value = null;
      let updated = null;
      for (const k of keys) {
        const b = data.months[k].balances;
        if (b && Object.prototype.hasOwnProperty.call(b, account.id)) { value = num(b[account.id]); updated = k; }
      }
      if (value != null) rows.push({ account, value, updated });
    }
    let assets = 0, debts = 0;
    const byType = {};
    for (const r of rows) {
      if (r.account.type === 'debt') debts += r.value;
      else assets += r.value;
      byType[r.account.type] = (byType[r.account.type] || 0) + r.value;
    }
    return { key, total: assets - debts, assets, debts, byType, rows, has: rows.length > 0 };
  }

  /** The first month with any logged balance. */
  function firstBalanceMonth(data) {
    const ks = Object.keys(data.months).filter(k => {
      const b = data.months[k].balances;
      return b && Object.keys(b).length;
    }).sort();
    return ks[0] || null;
  }

  function netWorthHistory(data, key, n = 12) {
    const first = firstBalanceMonth(data);
    if (!first) return [];
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const k = addMonths(key, -i);
      if (k >= first) out.push(netWorth(data, k));
    }
    return out;
  }

  return {
    FREQ_MONTHS, num, monthKey, addMonths, diff, label, isActive, isDue, perMonth, month, firstMonth, history, goalProgress,
    netWorth, netWorthHistory, firstBalanceMonth,
  };
})();
