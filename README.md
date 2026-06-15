# BTC Cowen ATC

Interactive GitHub Pages site for visualizing BTC/USD daily closes against the asymmetric quadratic quantile bands from Benjamin Cowen's working paper, [_Asymmetric Tail Curvature in Bitcoin Price Quantiles_](https://benjamincowen.com/reports/asymmetric-tail-curvature-in-bitcoin-price-quantiles).

## Details

`BTC Cowen ATC` is a Vite + React + TypeScript dashboard that overlays Bitcoin daily close prices with conditional quantile bands from Cowen's working paper _Asymmetric Tail Curvature in Bitcoin Price Quantiles_. It generates a curated BTC/USD snapshot from CryptoCompare/CoinDesk histoday data, precomputes model quantiles (and daily projections to 2051-12-31), and renders an interactive log-scale D3 chart with model switching (paper coefficients vs linear-regression baseline), quantile visibility toggles, range brushing, projection controls, tooltip diagnostics, and a "not a trading signal" caveat-first UX.

## Local Development

```bash
npm install
npm run generate:data
npm run dev
```

Local and production builds use Vite `base: "/"` because the site is deployed at the custom domain root, `https://catc.zyhe.me/`. In local Vite dev mode, open `http://localhost:5173/`.

## Data

`scripts/generate-data.mjs` fetches BTC/USD daily OHLCV rows from the CryptoCompare/CoinDesk legacy `histoday` endpoint, starting on `2012-01-01`. If that source rejects an incremental refresh, the script appends missing recent BTC-USD daily candles from Coinbase Exchange as a fallback. It writes `public/data/btc-atc.json` with:

- `prices`: historical daily BTC/USD OHLCV rows.
- `quantiles`: daily model bands through `2051-12-31`, enough for the site's 25-year projection view.
- `metadata`: source, generation timestamp, latest close date, warnings, and paper coefficient config.

If every refresh source fails and an existing snapshot is present, local builds keep the existing file so the chart still renders. In CI/GitHub Actions, a stale snapshot fails the build instead of quietly publishing old data.

## Model

The site uses Cowen's Table 3 coefficients directly. It does not refit the regression.

```text
log10(P_tau(t)) = c_tau + a_tau x + b_tau x^2
x = ln(days since 2009-01-01) - 7.9914
```

Per-date model outputs are monotone-rearranged before rendering.

## Deploy

`.github/workflows/pages.yml` builds and deploys on pushes to `main`, manual dispatch, and a daily `02:17 UTC` schedule. `public/CNAME` keeps the GitHub Pages custom domain set to `catc.zyhe.me`. In GitHub repository settings, set Pages source to GitHub Actions.

## License and attribution

The project source code is intended to be released under the [MIT License](LICENSE).

This project is an implementation and visualization inspired by Benjamin Cowen's paper, [_Asymmetric Tail Curvature in Bitcoin Price Quantiles_](https://benjamincowen.com/reports/asymmetric-tail-curvature-in-bitcoin-price-quantiles).  
The paper itself is © 2026 Benjamin Cowen, all rights reserved, and the paper text/figures are not provided under MIT.
