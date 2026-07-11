# automoney

Domeme product import MVP CLI.

## Run

Set `DATABASE_URL` to a local PostgreSQL database URL, then run:

```powershell
node scripts/process-test-products.mjs
```

Default input is `test-products.csv`; default pricing rules are in `pricing-rules.json`.

## Database

The app uses PostgreSQL only. Local PostgreSQL and Supabase must both be accessed through the same `DATABASE_URL` setting. Keep schema changes in `schema.sql` or migration files so the same SQL can be applied to either database.

The current schema is maintained in `schema.sql`.

## Environment

The loader reads `.env` first and falls back to `env` for the current workspace.

- `DATABASE_URL`: PostgreSQL connection string for local PostgreSQL or Supabase
- `DOMEME_API_KEY`: Domeme Open API key
- `DOMEME_PRODUCT_DETAIL_ENDPOINT`: optional product-detail API endpoint override

Coupang and Smartstore listing APIs are not called by this MVP.
