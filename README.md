# Em H Butchers – Money Ledger

Compares Semtek against money actually received, and keeps the ledger of all money outside the bank
(cash, floats, cheques, vouchers, card takings on their way to the bank).

- Database: Supabase project "ButcherPay" (all tables, views and workflows are in the database).
- Website: a static site in `dist/` – upload that folder to any static host (e.g. Netlify Drop).

## Rebuild the website after a code change
    npm install
    npm run build        # creates dist/

## Test the importers against sample files
    npx tsx tests/sample.test.ts
