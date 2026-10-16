# dcf-site

Three-Case DCF: values a US stock with a bear, normal and bull DCF, weighted by your own probabilities.

- `index.html` is the whole page, including the valuation math.
- `api/lookup.js` is the ticker lookup. It runs on Vercel's servers, pulls statements, price, shares and beta from Financial Modeling Prep, and the 10-year Treasury yield from FRED. Each ticker is cached for a day.

## Turning on the ticker lookup

The lookup needs a Financial Modeling Prep API key, stored in Vercel (never in the page):

1. Get a key at https://site.financialmodelingprep.com/developer/docs.
2. In Vercel, open the project, then Settings, then Environment Variables.
3. Add `FMP_API_KEY` with the key as its value, for all environments, and save.
4. Redeploy (Deployments, then the latest one's menu, then Redeploy).

Without the key, the site still works with manual entry and the lookup says it is not switched on yet.

## Tests

`node --test` checks the lookup against sample data, with no key or network needed.
