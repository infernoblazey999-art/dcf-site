// Run with: node --test
// Uses a fake data provider, so no API key or network is needed.
const test = require('node:test');
const assert = require('node:assert');
const { lookup } = require('../api/lookup');

const income = [
  { date: '2025-09-27', reportedCurrency: 'USD', revenue: 400e9, operatingIncome: 128e9, incomeBeforeTax: 125e9, incomeTaxExpense: 20e9, interestExpense: 3e9, weightedAverageShsOutDil: 15e9 },
  { date: '2024-09-28', reportedCurrency: 'USD', revenue: 380e9, operatingIncome: 120e9 },
  { date: '2023-09-30', reportedCurrency: 'USD', revenue: 370e9 },
  { date: '2022-09-24', reportedCurrency: 'USD', revenue: 350e9 },
];
const balance = [
  { date: '2025-09-27', totalDebt: 100e9, cashAndShortTermInvestments: 60e9, minorityInterest: 0, preferredStock: 0 },
  { date: '2024-09-28', totalDebt: 110e9 },
];
const cashflow = [
  { date: '2025-09-27', depreciationAndAmortization: 12e9, capitalExpenditure: -10e9, changeInWorkingCapital: -4e9 },
  { date: '2024-09-28', changeInWorkingCapital: -1e9 },
  { date: '2023-09-30', changeInWorkingCapital: 0 },
];
const profile = [{ symbol: 'TEST', companyName: 'Test Corp', price: 250.5, beta: 1.21, currency: 'USD', sector: 'Technology', industry: 'Consumer Electronics' }];

function fakeFetch(overrides = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const reply = (status, body) => ({ ok: status < 400, status, text: async () => typeof body === 'string' ? body : JSON.stringify(body) });
    if (url.startsWith('https://fred.')) return overrides.fred || reply(200, 'observation_date,DGS10\n2026-10-14,4.10\n2026-10-15,\n');
    const path = new URL(url).pathname.split('/').pop();
    if (overrides[path]) return overrides[path];
    return reply(200, { profile, 'income-statement': income, 'balance-sheet-statement': balance, 'cash-flow-statement': cashflow, 'treasury-rates': [{ date: '2026-10-15', year10: 4.2 }] }[path]);
  };
  fn.calls = calls;
  return fn;
}

test('fills every company input with the expected values', async () => {
  const d = await lookup('test', 'k', fakeFetch());
  assert.deepStrictEqual(d.fields, {
    name: 'Test Corp', price: 250.5, shares: 15000, revenue: 400000,
    taxRate: 16, daPct: 3, capexPct: 2.5,
    nwcPct: 10, // (4 + 1 + 0) / (400 - 350)
    debt: 100000, cash: 60000, minority: 0,
    riskFree: 4.1, // latest non-blank FRED day
    beta: 1.21,
    costOfDebt: 2.86, // 3 / average(100, 110)
  });
  assert.strictEqual(d.history.revenueCagr, 4.6); // (400/350)^(1/3) - 1
  assert.strictEqual(d.history.ebitMargin, 32);
  assert.deepStrictEqual(d.warnings, []);
  assert.deepStrictEqual(d.missing, []);
  assert.strictEqual(d.asOf.fiscalYearEnd, '2025-09-27');
});

test('the key goes only to the data provider', async () => {
  const f = fakeFetch();
  await lookup('TEST', 'secret123', f);
  f.calls.filter((u) => u.includes('fred.')).forEach((u) => assert.ok(!u.includes('secret123')));
  assert.ok(f.calls.some((u) => u.includes('apikey=secret123')));
});

test('falls back to the provider\'s Treasury rate when FRED is down', async () => {
  const d = await lookup('TEST', 'k', fakeFetch({ fred: { ok: false, status: 500, text: async () => '' } }));
  assert.strictEqual(d.fields.riskFree, 4.2);
  assert.strictEqual(d.sources.riskFree, 'FMP treasury rates');
});

test('clear errors for the cases a visitor can hit', async () => {
  await assert.rejects(lookup('MSFT', '', fakeFetch()), { code: 'not_configured' });
  await assert.rejects(lookup('not a ticker', 'k', fakeFetch()), { code: 'bad_ticker' });
  const empty = { ok: true, status: 200, text: async () => '[]' };
  await assert.rejects(lookup('ZZZZ', 'k', fakeFetch({ profile: empty })), { code: 'not_found' });
  const badKey = { ok: false, status: 401, text: async () => '{"Error Message":"Invalid API KEY."}' };
  await assert.rejects(lookup('TEST', 'k', fakeFetch({ profile: badKey })), { code: 'bad_key' });
  const limit = { ok: false, status: 429, text: async () => '{"Error Message":"Limit Reach"}' };
  await assert.rejects(lookup('TEST', 'k', fakeFetch({ profile: limit })), { code: 'rate_limited' });
  const premium = { ok: false, status: 402, text: async () => 'Premium Query Parameter: this symbol requires a paid plan' };
  await assert.rejects(lookup('TEST', 'k', fakeFetch({ profile: premium })), { code: 'plan_limit' });
});

test('warns on banks and on non-USD statements, and uses safe defaults for odd numbers', async () => {
  const bankProfile = [{ ...profile[0], sector: 'Financial Services', industry: 'Banks - Diversified', beta: null }];
  const odd = income.map((r, i) => i ? r : { ...r, reportedCurrency: 'EUR', incomeTaxExpense: -5e9, interestExpense: 0 });
  const p = (b) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) });
  const d = await lookup('TEST', 'k', fakeFetch({ profile: p(bankProfile), 'income-statement': p(odd) }));
  assert.strictEqual(d.warnings.length, 2);
  assert.strictEqual(d.fields.taxRate, 21);
  assert.strictEqual(d.fields.beta, 1);
  assert.strictEqual(d.fields.costOfDebt, 5.6); // 4.1% yield + 1.5 points
});

test('server response: cached a day on success, never cached on error', async () => {
  const handler = require('../api/lookup');
  const realFetch = global.fetch;
  global.fetch = fakeFetch();
  process.env.FMP_API_KEY = 'k';
  const mk = () => { const r = { headers: {} }; r.setHeader = (k, v) => { r.headers[k] = v; }; r.status = (s) => { r.code = s; return r; }; r.json = (b) => { r.body = b; }; return r; };
  try {
    const ok = mk(); await handler({ query: { ticker: 'TEST' } }, ok);
    assert.strictEqual(ok.code, 200);
    assert.match(ok.headers['Cache-Control'], /s-maxage=86400/);
    delete process.env.FMP_API_KEY;
    const bad = mk(); await handler({ query: { ticker: 'TEST' } }, bad);
    assert.strictEqual(bad.code, 503);
    assert.strictEqual(bad.headers['Cache-Control'], 'no-store');
  } finally { global.fetch = realFetch; }
});

test('retries statements without the history limit when the plan rejects it, and passes the provider\'s reason on', async () => {
  const premium = { ok: false, status: 402, text: async () => '{"Error Message":"Premium Query Parameter: limit"}' };
  const base = fakeFetch();
  const f = async (url) => (url.includes('income-statement') && url.includes('limit=') ? premium : base(url));
  const d = await lookup('TEST', 'k', f);
  assert.strictEqual(d.fields.revenue, 400000);
  await assert.rejects(lookup('TEST', 'k', fakeFetch({ profile: premium })), (e) => e.code === 'plan_limit' && /profile: Premium Query Parameter: limit/.test(e.message));
});

test('sets starting scenarios from the company\'s own margin and growth', async () => {
  const d = await lookup('TEST', 'k', fakeFetch());
  // Last EBIT margin 32%, 3-year growth 4.6%
  assert.deepStrictEqual(d.scenarios, {
    bear: { growthStart: 0.5, growthEnd: 2, marginStart: 32, marginEnd: 27 },
    base: { growthStart: 4.5, growthEnd: 4, marginStart: 32, marginEnd: 32 },
    bull: { growthStart: 7.5, growthEnd: 5.5, marginStart: 32, marginEnd: 35 },
  });
});

test('flags capex far above D&A', async () => {
  const heavy = [{ date: '2025-09-27', depreciationAndAmortization: 34e9, capitalExpenditure: -64e9, changeInWorkingCapital: -4e9 }];
  const p = (b) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) });
  const d = await lookup('TEST', 'k', fakeFetch({ 'cash-flow-statement': p(heavy) }));
  assert.ok(d.notes.some((n) => /Capex \(16% of revenue\) is well above D&A \(8\.5%\)/.test(n)));
});
