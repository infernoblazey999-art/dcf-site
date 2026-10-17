// Ticker lookup. Runs on the server (a Vercel function) so the data key never reaches the browser.
// GET /api/lookup?ticker=MSFT  ->  { fields, history, notes, warnings, asOf }
var derive = require('./_derive').derive;

var FMP = 'https://financialmodelingprep.com/stable/';
var FRED_CSV = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10';
var DAY = 86400;

function LookupError(status, code, message) {
  this.status = status; this.code = code; this.message = message;
}

async function fmp(fetchFn, key, path, params) {
  var qs = Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
  var res = await fetchFn(FMP + path + '?' + qs + '&apikey=' + encodeURIComponent(key));
  var text = await res.text();
  var body;
  try { body = JSON.parse(text); } catch (e) { body = null; }
  if (res.status === 401 || res.status === 403 || (body && body['Error Message'] && /api ?key/i.test(body['Error Message']))) {
    throw new LookupError(502, 'bad_key', 'The data provider rejected the API key. Check FMP_API_KEY in Vercel.');
  }
  if (res.status === 429 || /limit reach/i.test(text)) {
    throw new LookupError(503, 'rate_limited', 'The data provider\'s daily request limit was reached. Try again later or enter the numbers by hand.');
  }
  if (res.status === 402 || (!Array.isArray(body) && /premium|subscription|upgrade/i.test(text))) {
    var said = String(body && body['Error Message'] || text).replace(/\s+/g, ' ').slice(0, 200);
    throw new LookupError(502, 'plan_limit', 'This ticker or data set is not included in the current data plan (' + path + ': ' + said + ').');
  }
  if (!res.ok || !Array.isArray(body)) {
    throw new LookupError(502, 'provider_error', 'The data provider returned an unexpected response (' + res.status + ').');
  }
  return body;
}

// 10-year Treasury yield in percent. FRED first (no key needed), FMP as backup.
async function riskFree(fetchFn, key) {
  try {
    var res = await fetchFn(FRED_CSV);
    if (res.ok) {
      var lines = (await res.text()).trim().split(/\r?\n/);
      for (var i = lines.length - 1; i > 0; i--) {
        var p = lines[i].split(',');
        var v = Number(p[1]);
        if (p[1] && p[1] !== '.' && isFinite(v)) return { value: v, date: p[0], source: 'FRED DGS10' };
      }
    }
  } catch (e) { /* fall through to FMP */ }
  try {
    var rows = await fmp(fetchFn, key, 'treasury-rates', {});
    var r = rows.filter(function (x) { return isFinite(Number(x.year10)); })
      .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); })[0];
    if (r) return { value: Number(r.year10), date: r.date, source: 'FMP treasury rates' };
  } catch (e) { /* leave it blank for the user */ }
  return null;
}

// Some plans reject the history-length setting. If so, ask again with the provider's default length.
async function statements(fetchFn, key, path, params) {
  try {
    return await fmp(fetchFn, key, path, params);
  } catch (e) {
    if (e.code !== 'plan_limit' || params.limit == null) throw e;
    var rest = Object.assign({}, params);
    delete rest.limit;
    return fmp(fetchFn, key, path, rest);
  }
}

async function lookup(ticker, key, fetchFn) {
  if (!key) throw new LookupError(503, 'not_configured', 'Ticker lookup is not switched on yet: the site has no data provider key.');
  var symbol = String(ticker || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(symbol)) throw new LookupError(400, 'bad_ticker', 'Enter a ticker such as MSFT or BRK-B.');

  var q = { symbol: symbol };
  var qa = { symbol: symbol, period: 'annual', limit: 5 };
  var results = await Promise.all([
    fmp(fetchFn, key, 'profile', q),
    statements(fetchFn, key, 'income-statement', qa),
    statements(fetchFn, key, 'balance-sheet-statement', { symbol: symbol, period: 'annual', limit: 2 }),
    statements(fetchFn, key, 'cash-flow-statement', qa),
    riskFree(fetchFn, key)
  ]);
  var profile = results[0][0];
  if (!profile) throw new LookupError(404, 'not_found', 'No company found for ' + symbol + '.');
  if (profile.isEtf || profile.isFund) throw new LookupError(422, 'not_company', symbol + ' is a fund, not an operating company.');
  if (!results[1].length || !results[2].length || !results[3].length) {
    throw new LookupError(404, 'no_statements', 'No annual financial statements were found for ' + symbol + '.');
  }
  var out = derive(profile, results[1], results[2], results[3], results[4]);
  out.sources = {
    statements: 'Financial Modeling Prep',
    riskFree: results[4] ? results[4].source : null
  };
  out.fetchedAt = new Date().toISOString();
  return out;
}

async function handler(req, res) {
  var ticker = req.query && req.query.ticker;
  try {
    var out = await lookup(ticker, process.env.FMP_API_KEY, fetch);
    // Cache each ticker at Vercel's edge for a day, then refresh in the background.
    res.setHeader('Cache-Control', 'public, s-maxage=' + DAY + ', stale-while-revalidate=' + DAY);
    res.status(200).json(out);
  } catch (e) {
    var known = e instanceof LookupError;
    if (!known) console.error(e);
    res.setHeader('Cache-Control', 'no-store');
    res.status(known ? e.status : 500).json({
      error: known ? e.code : 'server_error',
      message: known ? e.message : 'Something went wrong while looking up the ticker.'
    });
  }
}

module.exports = handler;
module.exports.lookup = lookup;
module.exports.LookupError = LookupError;
