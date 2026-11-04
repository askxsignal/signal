-- signal — the operator pass as a compressed NFT (Solana, Metaplex Bubblegum v2), minted on demand.
-- Run after 0009. Safe to run more than once.
--
-- Nothing is minted in advance. When an allowed person presses "Mint", the server builds one mint for
-- that person only, pays the fee itself and mints straight into their wallet. The metadata URL points
-- at our own domain (/nft/<id>.json), so the picture follows the database: allocation and the stamp
-- (pending / approved / rejected) are drawn from the current values.
--
-- Who may mint: the handles in nft_allowlist. Open it for everyone later with
--   insert into app_config (key, value) values ('nft_open', '1') on conflict (key) do update set value = excluded.value;

-- ---------------------------------------------------------------- the reserve's decision per person
alter table public.profiles add column if not exists allocation_status text not null default 'pending';
alter table public.profiles add column if not exists status_at timestamptz;
do $$ begin
  alter table public.profiles add constraint profiles_allocation_status_chk check (allocation_status in ('pending', 'approved', 'rejected'));
exception when duplicate_object then null; end $$;

-- status_at = when the stamp last changed (printed on the NFT).
create or replace function public.touch_status_at() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.allocation_status is distinct from old.allocation_status then new.status_at := now(); end if;
  return new;
end $$;
drop trigger if exists profiles_status_at on public.profiles;
create trigger profiles_status_at before update of allocation_status on public.profiles
  for each row execute function public.touch_status_at();

-- ---------------------------------------------------------------- who may mint (for now)
create table if not exists public.nft_allowlist (
  handle   text primary key,                 -- lowercase X handle, no @
  note     text,
  added_at timestamptz not null default now()
);
-- Add handles (lowercase, no @):
--   insert into public.nft_allowlist (handle, note) values ('somehandle', 'first wave') on conflict (handle) do nothing;

-- ---------------------------------------------------------------- one NFT per person
create table if not exists public.nft_mints (
  id                text primary key,          -- public id in the metadata URL: /nft/<id>.json
  user_id           uuid not null unique references public.profiles (id) on delete cascade,
  owner             text not null,             -- Solana wallet the cNFT is minted to
  status            text not null default 'minting' check (status in ('minting', 'sent', 'minted', 'failed')),
  signature         text,                      -- saved BEFORE the transaction is sent
  last_valid_height bigint,                    -- after this block height the transaction can never land
  asset_id          text,
  network           text,                      -- mainnet | devnet
  tree              text,
  error             text,
  attempts          int not null default 0,
  locked_until      timestamptz,               -- one mint at a time per person
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  minted_at         timestamptz
);
create index if not exists nft_mints_created_idx on public.nft_mints (created_at);
alter table public.nft_allowlist enable row level security;
alter table public.nft_mints enable row level security;

create or replace function public.nft_eligible(p profiles) returns boolean
language sql stable security definer set search_path = public as $$
  select p.x_id not like 'h:%'
     and cfg('nft_paused', 0) = 0
     and (cfg('nft_open', 0) = 1 or exists (select 1 from nft_allowlist a where a.handle = p.x_username))
$$;

-- Step 1 (before anything touches the chain): may this person mint, and is nobody else minting for them?
-- Returns {ok, state: go | sent | minted, id, ...} or {ok:false, error}.
--   go     → the server builds, signs and sends a new mint (id = the metadata id)
--   sent   → a transaction is already out; the server checks it on chain instead of minting again
--   minted → done
create or replace function public.api_nft_claim(p_user uuid, p_owner text, p_network text, p_tree text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p profiles%rowtype;
  m nft_mints%rowtype;
begin
  select * into p from profiles where id = p_user;
  if not found then return jsonb_build_object('ok', false, 'error', 'unauthorized'); end if;
  if cfg('nft_paused', 0) = 1 then return jsonb_build_object('ok', false, 'error', 'paused'); end if;
  if not nft_eligible(p) then return jsonb_build_object('ok', false, 'error', 'closed'); end if;
  if p_owner is null or p_owner !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' then
    return jsonb_build_object('ok', false, 'error', 'bad_wallet');
  end if;

  select * into m from nft_mints where user_id = p_user for update;
  if found then
    if m.status = 'minted' then
      return jsonb_build_object('ok', true, 'state', 'minted', 'id', m.id, 'assetId', m.asset_id, 'signature', m.signature, 'owner', m.owner, 'network', m.network);
    end if;
    if m.status = 'sent' then
      return jsonb_build_object('ok', true, 'state', 'sent', 'id', m.id, 'signature', m.signature, 'height', m.last_valid_height, 'owner', m.owner, 'network', m.network);
    end if;
    if m.status = 'minting' and m.locked_until > now() then
      return jsonb_build_object('ok', false, 'error', 'busy');
    end if;
    if m.attempts >= cfg('nft_max_attempts', 5) then
      return jsonb_build_object('ok', false, 'error', 'too_many_attempts');
    end if;
    -- failed, or a mint that died before it saved a signature (so it was never sent): try again.
    update nft_mints set status = 'minting', owner = p_owner, network = p_network, tree = p_tree, signature = null,
      last_valid_height = null, error = null, attempts = attempts + 1, locked_until = now() + interval '90 seconds', updated_at = now()
    where id = m.id returning * into m;
    return jsonb_build_object('ok', true, 'state', 'go', 'id', m.id, 'owner', m.owner);
  end if;

  -- The reserve pays every mint: a daily ceiling stops a runaway.
  if (select count(*) from nft_mints where created_at >= date_trunc('day', now())) >= cfg('nft_per_day', 500) then
    return jsonb_build_object('ok', false, 'error', 'daily_cap');
  end if;
  insert into nft_mints (id, user_id, owner, status, network, tree, attempts, locked_until)
  values (substr(md5(p_user::text || clock_timestamp()::text || random()::text), 1, 12), p_user, p_owner, 'minting', p_network, p_tree, 1, now() + interval '90 seconds')
  on conflict (user_id) do nothing
  returning * into m;
  if not found then return jsonb_build_object('ok', false, 'error', 'busy'); end if;
  return jsonb_build_object('ok', true, 'state', 'go', 'id', m.id, 'owner', m.owner);
end $$;

-- Step 2: the transaction is signed; its signature is stored before it is sent, so a crash can never
-- lead to a second mint.
create or replace function public.api_nft_sent(p_user uuid, p_id text, p_signature text, p_height bigint) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update nft_mints set status = 'sent', signature = p_signature, last_valid_height = p_height, locked_until = null, updated_at = now()
  where id = p_id and user_id = p_user and status = 'minting';
  return found;
end $$;

-- Step 3a: confirmed on chain.
create or replace function public.api_nft_done(p_user uuid, p_signature text, p_asset text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update nft_mints set status = 'minted', asset_id = coalesce(p_asset, asset_id), error = null, minted_at = coalesce(minted_at, now()), updated_at = now()
  where user_id = p_user and signature = p_signature and status in ('sent', 'minted');
  return found;
end $$;

-- Step 3b: it can no longer land (rejected before sending, failed on chain, or its blockhash expired).
create or replace function public.api_nft_failed(p_user uuid, p_signature text, p_error text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update nft_mints set status = 'failed', error = left(p_error, 300), locked_until = null, updated_at = now()
  where user_id = p_user
    and ((p_signature is null and status = 'minting') or (signature = p_signature and status = 'sent'));
  return found;
end $$;

-- What the public image / metadata show for one NFT id.
create or replace function public.api_nft_public(p_id text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'handle', split_part(p.x_username, '~', 1),
    'allocation', p.points,
    'status', p.allocation_status,
    'statusAt', p.status_at,
    'no', (select count(*) from profiles q where q.created_at <= p.created_at),
    'rank', (select count(*) + 1 from profiles q where q.points > p.points or (q.points = p.points and q.created_at < p.created_at)),
    'divers', (select count(*) from profiles),
    'mintStatus', m.status,
    'createdAt', m.created_at)
  from nft_mints m join profiles p on p.id = m.user_id
  where m.id = p_id
$$;

-- The same picture for the signed-in person before they mint (preview).
create or replace function public.api_nft_preview(p_user uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'handle', split_part(p.x_username, '~', 1),
    'allocation', p.points,
    'status', p.allocation_status,
    'statusAt', p.status_at,
    'no', (select count(*) from profiles q where q.created_at <= p.created_at),
    'rank', (select count(*) + 1 from profiles q where q.points > p.points or (q.points = p.points and q.created_at < p.created_at)),
    'divers', (select count(*) from profiles),
    'eligible', nft_eligible(p))
  from profiles p where p.id = p_user
$$;

-- One person's NFT state: may they mint, the stamp, their mint (if any). Used by /api/me and the mint.
create or replace function public.api_nft_state(p_user uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'eligible', nft_eligible(p),
    'allocationStatus', p.allocation_status,
    'wallet', p.wallet,
    'handle', split_part(p.x_username, '~', 1),
    'mint', (select jsonb_build_object('id', m.id, 'status', m.status, 'assetId', m.asset_id, 'signature', m.signature,
               'height', m.last_valid_height, 'owner', m.owner, 'network', m.network, 'mintedAt', m.minted_at)
             from nft_mints m where m.user_id = p.id))
  from profiles p where p.id = p_user
$$;

-- ---------------------------------------------------------------- api_me + nft
-- Same as 0005, plus `nft`: may this person mint, the reserve's stamp, and their mint if any.
create or replace function public.api_me(p_user uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'user', jsonb_build_object('username', p.x_username, 'name', p.display_name, 'avatar', p.avatar_url),
    'allocation', p.points,
    'pendingRefs', (select coalesce(sum(amount), 0) from ledger where user_id = p.id and status = 'pending'),
    'refCode', p.referral_code,
    'wallet', p.wallet,
    'referrals', jsonb_build_object(
      'total', (select count(*) from referrals where referrer_id = p.id),
      'qualified', (select count(*) from referrals where referrer_id = p.id and status = 'qualified')),
    'pitch', jsonb_build_object(
      'attempts', coalesce((select attempts from pitches where user_id = p.id), 0),
      'best', coalesce((select best from pitches where user_id = p.id), 0),
      'max', cfg('pitch_attempts', 3),
      'unlocked', not exists (select 1 from tasks t where t.active and t.required and not exists (
        select 1 from task_completions c where c.user_id = p.id and c.task_id = t.id and c.completed_at is not null))),
    'standing', jsonb_build_object(
      'rank', (select count(*) + 1 from profiles q where q.points > p.points or (q.points = p.points and q.created_at < p.created_at)),
      'total', (select count(*) from profiles),
      'no', (select count(*) from profiles q where q.created_at <= p.created_at),
      'joinedAt', p.created_at),
    'nft', api_nft_state(p.id) - 'wallet' - 'handle',
    'tasks', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', t.id, 'type', t.type, 'title', t.title, 'actionUrl', t.action_url, 'reward', t.reward,
        'verification', t.verification, 'waitSec', t.min_wait_sec, 'params', t.params, 'required', t.required,
        'openedAt', c.opened_at, 'completedAt', c.completed_at) order by t.sort), '[]'::jsonb)
      from tasks t left join task_completions c on c.task_id = t.id and c.user_id = p.id where t.active),
    'now', now()
  ) from profiles p where p.id = p_user
$$;

-- ---------------------------------------------------------------- lockdown (new objects)
revoke all on all tables in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
