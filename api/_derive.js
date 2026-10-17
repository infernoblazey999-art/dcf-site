// Turns raw provider data into the page's input fields. Pure math, no network.
// Output units match the page: money in $ millions, shares in millions, rates in percent.

function num(v) {
  var n = Number(v);
  return v == null || v === '' || !isFinite(n) ? NaN : n;
}
function round(v, d) {
  if (!isFinite(v)) return null;
  var f = Math.pow(10, d);
  return Math.round(v * f) / f;
}
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// Statements arrive newest first. Sort to be safe.
function newestFirst(rows) {
  return (Array.isArray(rows) ? rows.slice() : []).sort(function (a, b) {
    return String(b.date).localeCompare(String(a.date));
  });
}

// profile: FMP profile row. income/balance/cashflow: FMP annual statements.
// riskFree: 10-year yield in percent, with its date.
function derive(profile, income, balance, cashflow, riskFree) {
  income = newestFirst(income);
  balance = newestFirst(balance);
  cashflow = newestFirst(cashflow);
  var is0 = income[0] || {};
  var bs0 = balance[0] || {};
  var cf0 = cashflow[0] || {};
  var notes = [];
  var warnings = [];
  var fields = {};

  var revenue = num(is0.revenue);

  fields.name = profile.companyName || profile.symbol || '';
  fields.price = round(num(profile.price), 2);
  var shares = num(is0.weightedAverageShsOutDil);
  if (!(shares > 0)) shares = num(is0.weightedAverageShsOut);
  if (!(shares > 0) && num(profile.marketCap) > 0 && num(profile.price) > 0) {
    shares = num(profile.marketCap) / num(profile.price);
    notes.push('Diluted shares were missing from the statements, so shares are market cap divided by price.');
  }
  fields.shares = round(shares / 1e6, 2);
  fields.revenue = round(revenue / 1e6, 1);

  // Effective tax rate, kept to a sensible band.
  var pretax = num(is0.incomeBeforeTax);
  var tax = num(is0.incomeTaxExpense);
  var taxRate = pretax > 0 && isFinite(tax) ? tax / pretax : NaN;
  if (isFinite(taxRate) && taxRate >= 0.05 && taxRate <= 0.35) {
    fields.taxRate = round(taxRate * 100, 1);
  } else {
    fields.taxRate = 21;
    notes.push('The effective tax rate ' + (isFinite(taxRate) ? 'was ' + (taxRate * 100).toFixed(1) + '%, outside 5% to 35%' : 'could not be computed') + ', so the 21% federal rate is used.');
  }

  var da = num(cf0.depreciationAndAmortization);
  if (!isFinite(da)) da = num(is0.depreciationAndAmortization);
  fields.daPct = revenue > 0 && isFinite(da) ? round(da / revenue * 100, 1) : null;

  var capex = num(cf0.capitalExpenditure);
  fields.capexPct = revenue > 0 && isFinite(capex) ? round(Math.abs(capex) / revenue * 100, 1) : null;

  // Working capital investment as a share of revenue growth, pooled over up to
  // three years because a single year is noisy. Cash flow shows an investment
  // in working capital as a negative number.
  var years = Math.min(3, cashflow.length, income.length - 1);
  var dNwc = 0, dRev = 0;
  for (var i = 0; i < years; i++) {
    var cw = num(cashflow[i].changeInWorkingCapital);
    var r1 = num(income[i].revenue), r0 = num(income[i + 1].revenue);
    if (!isFinite(cw) || !isFinite(r1) || !isFinite(r0)) { years = i; break; }
    dNwc += -cw;
    dRev += r1 - r0;
  }
  if (years > 0 && dRev > 0) {
    var nwc = clamp(dNwc / dRev, -0.3, 0.5);
    fields.nwcPct = round(nwc * 100, 1);
    notes.push('Working capital investment is pooled over the last ' + years + ' year' + (years > 1 ? 's' : '') + (nwc !== dNwc / dRev ? ' and capped to −30% to 50%' : '') + '.');
  } else {
    fields.nwcPct = 10;
    notes.push('Revenue did not grow over the last few years, so working capital investment is set to 10% of growth. Adjust it if you have a better view.');
  }

  fields.debt = round(num(bs0.totalDebt) / 1e6, 1);
  var cash = num(bs0.cashAndShortTermInvestments);
  if (!isFinite(cash)) cash = num(bs0.cashAndCashEquivalents);
  fields.cash = round(cash / 1e6, 1);
  var mi = num(bs0.minorityInterest), pref = num(bs0.preferredStock);
  fields.minority = round(((isFinite(mi) ? mi : 0) + (isFinite(pref) ? pref : 0)) / 1e6, 1);

  fields.riskFree = riskFree && isFinite(riskFree.value) ? round(riskFree.value, 2) : null;
  var beta = num(profile.beta);
  if (isFinite(beta) && beta > 0) fields.beta = round(beta, 2);
  else { fields.beta = 1; notes.push('No beta was available, so beta is set to 1.0.'); }

  // Pre-tax cost of debt: interest expense over average debt, kept to a sensible band.
  var interest = Math.abs(num(is0.interestExpense));
  var debt0 = num(bs0.totalDebt), debt1 = balance[1] ? num(balance[1].totalDebt) : NaN;
  var avgDebt = isFinite(debt1) ? (debt0 + debt1) / 2 : debt0;
  var kd = avgDebt > 0 && isFinite(interest) ? interest / avgDebt : NaN;
  var rf = fields.riskFree != null ? fields.riskFree / 100 : 0.042;
  if (isFinite(kd) && kd >= 0.02 && kd <= 0.15) {
    fields.costOfDebt = round(kd * 100, 2);
  } else {
    fields.costOfDebt = round((rf + 0.015) * 100, 2);
    if (avgDebt > 0) notes.push('Interest over average debt was not usable, so the cost of debt is the 10-year yield plus 1.5 points.');
  }

  // The company's recent history, shown next to the scenarios.
  var history = {};
  var n = Math.min(income.length - 1, 3);
  var rOld = n > 0 ? num(income[n].revenue) : NaN;
  if (n > 0 && revenue > 0 && rOld > 0) history.revenueCagr = round((Math.pow(revenue / rOld, 1 / n) - 1) * 100, 1);
  history.cagrYears = n;
  if (revenue > 0) history.ebitMargin = round(num(is0.operatingIncome) / revenue * 100, 1);

  // Starting scenarios from that history, so a lookup never leaves another
  // company's growth and margins in place. Probabilities, WACC and terminal
  // growth stay as the user set them.
  var scenarios = null;
  if (history.ebitMargin != null && isFinite(history.ebitMargin)) {
    var m = history.ebitMargin;
    var g = history.revenueCagr != null ? clamp(history.revenueCagr, -5, 30) : 3;
    var half = function (x) { return Math.round(x * 2) / 2; };
    var fade = function (x) { return half((x + 3) / 2); }; // halfway to 3% by the final year
    scenarios = {
      bear: { growthStart: half(g - 4), growthEnd: fade(g - 4), marginStart: half(m), marginEnd: half(m - 5) },
      base: { growthStart: half(g), growthEnd: fade(g), marginStart: half(m), marginEnd: half(m) },
      bull: { growthStart: half(g + 3), growthEnd: fade(g + 3), marginStart: half(m), marginEnd: half(m + 3) }
    };
    notes.push('Scenario growth and margins start from the company\'s history: normal keeps the last EBIT margin and ' + history.cagrYears + '-year growth, bear is 4 points slower with margins 5 points lower by the final year, bull is 3 points faster with margins 3 points higher. Growth fades halfway to 3% by the final year. These are a starting point for your own view.');
  }
  if (fields.capexPct != null && fields.daPct != null && fields.capexPct > 1.5 * fields.daPct) {
    notes.push('Capex (' + fields.capexPct + '% of revenue) is well above D&A (' + fields.daPct + '%). The model keeps capex at that share of revenue every year and in the terminal value, which lowers the value if today\'s spending is temporary. Consider a lower long-run capex.');
  }

  var currency = is0.reportedCurrency || profile.currency;
  if (currency && currency !== 'USD') {
    warnings.push('Statements are reported in ' + currency + ', not US dollars. Convert the money fields before relying on the result.');
  }
  if (/financial|real estate/i.test(profile.sector || '') || /bank|insurance|reit/i.test(profile.industry || '')) {
    warnings.push('This looks like a ' + (profile.industry || profile.sector) + ' company. A free cash flow DCF does not suit banks, insurers or REITs well.');
  }
  if (!(revenue > 0)) warnings.push('The latest annual revenue is zero or missing.');

  var missing = Object.keys(fields).filter(function (k) { return fields[k] == null; });

  return {
    symbol: profile.symbol,
    fields: fields,
    history: history,
    scenarios: scenarios,
    notes: notes,
    warnings: warnings,
    missing: missing,
    asOf: {
      fiscalYearEnd: is0.date || null,
      riskFreeDate: riskFree ? riskFree.date : null
    }
  };
}

module.exports = { derive: derive };
