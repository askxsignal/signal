# Operations

Everything here runs in the SQL editor of your Postgres project. Rewards and limits live in tables, so
none of it needs a deploy.

## Rewards and limits

```sql
-- tune a reward or a limit (app_config is read through cfg(key, default))
update app_config set value = '1000' where key = 'pitch_t3';
update app_config set value = '10'   where key = 'chat_per_minute';
update app_config set value = '0'    where key = 'model_tokens_global_day';   -- emergency: scripted brain for everyone

-- a task's reward
update tasks set reward = 1000 where id = 'nft-quote';

-- today's model usage (site total + top users)
select api_usage_today();
```

## Secret phrases

Phrases live only in the database. Typed anywhere in a message, a phrase pays once per person.

```sql
insert into secret_codes (code, reward, max_uses, note) values (norm_code('your phrase'), 500, null, 'where it is hidden');
update secret_codes set active = false where code = norm_code('your phrase');
```

## A new pinned post

Change `postId` in `shared/brand.mjs` and redeploy. To give everyone fresh like / repost / reply trials on
the new post, add new task ids (`like-4`, …) with the same rows and switch the old ones off with
`active = false` — never delete old ids, the ledger keys point at them.

## The log

```sql
-- top 20, as the site shows it
select api_leaderboard(20);
-- export (Table editor → Export CSV, or:)
select x_username, points, created_at from profiles where x_id not like 'h:%' order by points desc, created_at;
```

## Minting

```sql
-- who may mint: a list…
insert into nft_allowlist (handle) values ('somehandle') on conflict do nothing;
-- …or everyone signed in with X
insert into app_config (key, value) values ('nft_open', '1') on conflict (key) do update set value = excluded.value;

-- daily ceiling and an emergency stop
insert into app_config (key, value) values ('nft_per_day', '2000') on conflict (key) do update set value = excluded.value;
insert into app_config (key, value) values ('nft_paused', '1') on conflict (key) do update set value = excluded.value;

-- what was minted, where, and any errors
select p.x_username, m.status, m.owner, m.asset_id, m.signature, m.attempts, m.error, m.minted_at
from nft_mints m join profiles p on p.id = m.user_id order by m.created_at desc;
```

Setup, once, from your machine:

```bash
export NFT_RPC_URL="https://<a DAS-capable RPC>"
node scripts/nft-setup.mjs keygen                                     # minting wallet → .nft/minter.json
node scripts/nft-setup.mjs tree --yes                                 # 65,536 cards, paid once
node scripts/nft-setup.mjs collection --site https://<your-domain> --yes
```

Each create command writes the new address down before sending, and checks the chain first on the next
run, so a timeout never pays twice. Check the minting function at `/api/nft/health`.

## Accounts

```sql
-- change a payout wallet on the owner's request (it is locked once set from the chat)
update profiles set wallet = null where x_username = 'somehandle';

-- whitelist export: verified X accounts only
select x_username, wallet, points from profiles
where wallet is not null and x_id not like 'h:%' order by points desc;
```

Accounts created by the early typed-handle sign-in carry `x_id = 'h:<handle>'` until their owner signs
in with X; leave them out of any distribution.
