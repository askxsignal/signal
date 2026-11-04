# Security

If you find a way to get rewards you did not earn, read another person's data, mint more than one pass,
or make the minting key sign something it should not, please tell us privately first: send a DM to [@asksignal](https://x.com/asksignal) on X. We read every report and will credit you
when it is fixed.

Please do not test against other people's accounts, and do not run load tests against the live site.

## What the design guarantees

- The browser has no database access at all: no anon key, no grants, row-level security on every table.
- Rewards are fixed SQL functions behind idempotency keys; neither the client nor the language model sends an amount.
- Sessions are HMAC-signed cookies (`HttpOnly; Secure; SameSite=Lax`), compared in constant time.
- The X token is used once to read the profile, then revoked. Nothing from X is stored but the public profile.
- Every state-changing request needs a JSON body from the same origin (`Origin` / `sec-fetch-site`).
- Every API response is `Cache-Control: no-store`. Rate limits at the edge and in the database.
- The minting key signs only a single `mintV2` instruction that the server built itself, for the wallet stored in the database.
- Secrets live only in server environment variables.

```sql
-- change a payout wallet on the owner's request (it is locked once set from the chat)
update profiles set wallet = null where x_username = 'somehandle';
```
