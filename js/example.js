/*
 * Example — realistic made-up data so you can explore the hub before
 * entering your own. Nothing here is real.
 */
const Example = (() => {
  // Small deterministic random generator so the example looks the same every time
  function rng(seed) {
    return () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
  }
  const round = n => Math.round(n * 100) / 100;

  function build(categories) {
    const now = Calc.monthKey();
    const start = Calc.addMonths(now, -7);
    const rand = rng(42);
    const cat = name => (categories.find(c => c.name === name) || {}).id;

    const budgets = { Groceries: 400, 'Eating out': 150, Transport: 100, Shopping: 150, Entertainment: 75, Health: 50, Subscriptions: 80 };
    categories.forEach(c => { c.budget = budgets[c.name] ?? null; });

    let id = 0;
    const item = (o) => ({ id: `ex${++id}`, frequency: 'monthly', startMonth: start, endMonth: null, notes: '', subscription: false, categoryId: null, ...o });
    const raiseMonth = Calc.addMonths(start, 5);

    const items = [
      item({ name: 'Salary', type: 'income', amount: 3250, endMonth: Calc.addMonths(raiseMonth, -1), notes: 'Before raise' }),
      item({ name: 'Salary', type: 'income', amount: 3400, startMonth: raiseMonth }),
      item({ name: 'Rent', type: 'expense', amount: 1150, categoryId: cat('Housing') }),
      item({ name: 'Energy & water', type: 'expense', amount: 165, categoryId: cat('Utilities') }),
      item({ name: 'Internet', type: 'expense', amount: 45, categoryId: cat('Utilities') }),
      item({ name: 'Phone plan', type: 'expense', amount: 22, categoryId: cat('Utilities') }),
      item({ name: 'Health insurance', type: 'expense', amount: 142, categoryId: cat('Insurance') }),
      item({ name: 'Contents insurance', type: 'expense', amount: 37.5, frequency: 'quarterly', categoryId: cat('Insurance') }),
      item({ name: 'Netflix', type: 'expense', amount: 13.99, subscription: true, categoryId: cat('Subscriptions') }),
      item({ name: 'Spotify', type: 'expense', amount: 11.99, subscription: true, categoryId: cat('Subscriptions') }),
      item({ name: 'iCloud+', type: 'expense', amount: 2.99, subscription: true, categoryId: cat('Subscriptions') }),
      item({ name: 'Gym', type: 'expense', amount: 34.9, subscription: true, categoryId: cat('Subscriptions') }),
      item({ name: 'Amazon Prime', type: 'expense', amount: 89.9, frequency: 'yearly', subscription: true, startMonth: Calc.addMonths(start, 2), categoryId: cat('Subscriptions') }),
      item({ name: 'Claude Pro', type: 'expense', amount: 20, subscription: true, startMonth: Calc.addMonths(start, 4), categoryId: cat('Subscriptions') }),
      item({ name: 'Disney+', type: 'expense', amount: 9.99, subscription: true, endMonth: Calc.addMonths(start, 3), categoryId: cat('Subscriptions'), notes: 'Cancelled' }),
    ];

    const goals = [
      { id: 'exg1', name: 'Emergency fund', target: 10000, startAmount: 3500, deadline: Calc.addMonths(now, 14) },
      { id: 'exg2', name: 'Trip to Japan', target: 4000, startAmount: 400, deadline: Calc.addMonths(now, 9) },
    ];

    const ranges = {
      Groceries: [360, 470], 'Eating out': [110, 240], Transport: [55, 115],
      Shopping: [40, 270], Entertainment: [25, 95], Health: [0, 65], Other: [0, 40],
    };

    const months = {};
    for (let i = 0; i <= 7; i++) {
      const key = Calc.addMonths(start, i);
      const variable = {};
      for (const [name, [lo, hi]] of Object.entries(ranges)) {
        variable[cat(name)] = round(lo + rand() * (hi - lo));
      }
      const extras = [];
      if (i === 2) extras.push({ id: `exx${i}a`, name: 'Freelance website job', type: 'income', amount: 650 });
      if (i === 5) extras.push({ id: `exx${i}a`, name: 'Tax refund', type: 'income', amount: 420 });
      if (i === 3) extras.push({ id: `exx${i}b`, name: 'New laptop bag', type: 'expense', amount: 89, categoryId: cat('Shopping') });
      if (i === 6) extras.push({ id: `exx${i}b`, name: 'Wedding gift', type: 'expense', amount: 150, categoryId: cat('Other') });
      months[key] = {
        overrides: i === 4 ? { ex4: 205 } : {}, // a cold month: higher energy bill
        variable,
        extras,
        contributions: { exg1: 300, exg2: i >= 3 ? 200 : 100 },
        note: i === 4 ? 'Cold month, energy bill was higher.' : '',
      };
    }

    return { items, goals, months };
  }

  return { build };
})();
