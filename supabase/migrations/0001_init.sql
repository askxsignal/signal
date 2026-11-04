-- signal — schema for the chat-quest site. Self-contained, safe to run more than once.
-- The browser never touches the database: Netlify functions call the api_* functions below with the
-- service role key and pass the signed-in user explicitly. Rewards are decided here, never by the
-- client and never by the language model.

-- ---------------------------------------------------------------- tables
create table if not exists public.profiles (
  id            uuid primary key default gen_random_uuid(),
  x_id          text unique not null,
  x_username    text not null,                 -- lowercased handle, refreshed on every sign-in
  display_name  text,
  avatar_url    text,
  x_created_at  timestamptz,
  followers     int,
  referral_code text unique not null,
  referred_by   uuid references public.profiles (id),
  wallet        text unique,
  points        bigint not null default 0,     -- cache of credited ledger rows = pending allocation
  created_at    timestamptz not null default now(),
  last_seen     timestamptz not null default now()
);

create table if not exists public.tasks (
  id           text primary key,                -- 'follow', 'like-1', 'reply-1', 'invite-2'
  type         text not null,                   -- follow | like | repost | reply | post | telegram | invite | custom
  title        text not null,                   -- may contain {handle}
  description  text,
  action_url   text,                            -- template: {handle} {post} {ref} are filled by the server
  reward       int  not null check (reward >= 0),
  verification text not null default 'timer' check (verification in ('timer', 'reply_url', 'referral', 'x_api')),
  min_wait_sec int  not null default 5,
  params       jsonb not null default '{}',
  required     boolean not null default true,   -- required tasks unlock the pitch
  active       boolean not null default true,
  sort         int not null default 0
);
alter table public.tasks add column if not exists required boolean not null default true;

create table if not exists public.task_completions (
  user_id      uuid not null references public.profiles (id) on delete cascade,
  task_id      text not null references public.tasks (id) on delete cascade,
  opened_at    timestamptz,
  completed_at timestamptz,
  evidence     jsonb,
  primary key (user_id, task_id)
);

create table if not exists public.ledger (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  amount          int not null check (amount > 0),
  reason          text not null,
  status          text not null default 'credited' check (status in ('credited', 'pending')),
  idempotency_key text not null unique,
  created_at      timestamptz not null default now()
);
create index if not exists ledger_user_idx on public.ledger (user_id, created_at desc);

create table if not exists public.referrals (
  referred_id  uuid primary key references public.profiles (id) on delete cascade,
  referrer_id  uuid not null references public.profiles (id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending', 'qualified')),
  created_at   timestamptz not null default now(),
  qualified_at timestamptz,
  check (referrer_id <> referred_id)
);
create index if not exists referrals_referrer_idx on public.referrals (referrer_id);

create table if not exists public.pitches (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  attempts   int not null default 0,
  best       int not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.chat_messages (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles (id) on delete cascade,
  role       text not null check (role in ('user', 'agent')),
  text       text not null,
  events     jsonb not null default '[]',
  brain      text,                              -- 'model' | 'scripted' for signal's rows
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_user_idx on public.chat_messages (user_id, id desc);

create table if not exists public.rate_buckets (
  bucket     text primary key,
  hits       int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.app_config (key text primary key, value jsonb not null);

create index if not exists profiles_points_idx on public.profiles (points desc, created_at);

-- ---------------------------------------------------------------- helpers
create or replace function public.cfg(p_key text, p_default int) returns int
language sql stable security definer set search_path = public as
$$ select coalesce((select (value #>> '{}')::int from app_config where key = p_key), p_default) $$;

-- The only way allocation is ever created.
create or replace function public.credit(p_user uuid, p_amount int, p_reason text, p_key text, p_status text default 'credited')
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if p_amount <= 0 then return false; end if;
  insert into ledger (user_id, amount, reason, status, idempotency_key)
  values (p_user, p_amount, p_reason, p_status, p_key)
  on conflict (idempotency_key) do nothing;
  if not found then return false; end if;
  if p_status = 'credited' then update profiles set points = points + p_amount where id = p_user; end if;
  return true;
end $$;

-- Turn a pending credit into a real one (referral rewards).
create or replace function public.release(p_key text) returns boolean
language plpgsql security definer set search_path = public as $$
declare l ledger%rowtype;
begin
  update ledger set status = 'credited' where idempotency_key = p_key and status = 'pending' returning * into l;
  if not found then return false; end if;
  update profiles set points = points + l.amount where id = l.user_id;
  return true;
end $$;

-- Fixed-window counter. Returns the hit count for this bucket.
create or replace function public.hit(p_bucket text) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into rate_buckets (bucket, hits) values (p_bucket, 1)
  on conflict (bucket) do update set hits = rate_buckets.hits + 1
  returning hits into n;
  if random() < 0.02 then delete from rate_buckets where created_at < now() - interval '2 days'; end if;
  return n;
end $$;

-- ---------------------------------------------------------------- sign-in
create or replace function public.upsert_x_user(
  p_x_id text, p_username text, p_name text, p_avatar text,
  p_x_created_at timestamptz default null, p_followers int default null, p_ref text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  pid uuid;
  uname text := lower(p_username);
  code text := lower(p_username);
  referrer uuid;
begin
  select id into pid from profiles where x_id = p_x_id;
  if pid is not null then
    update profiles set x_username = uname, display_name = p_name, avatar_url = p_avatar,
      followers = coalesce(p_followers, followers), last_seen = now() where id = pid;
    return pid;
  end if;

  if code is null or exists (select 1 from profiles where referral_code = code) then
    code := coalesce(uname, 'user') || '-' || substr(md5(p_x_id), 1, 6);
  end if;
  insert into profiles (x_id, x_username, display_name, avatar_url, x_created_at, followers, referral_code)
  values (p_x_id, uname, p_name, p_avatar, p_x_created_at, p_followers, code)
  returning id into pid;
  perform credit(pid, cfg('welcome_bonus', 100), 'Welcome bonus', 'welcome:' || pid);

  -- The invite code is bound once, at account creation only.
  if p_ref is not null then
    select id into referrer from profiles where referral_code = lower(p_ref) and id <> pid;
    if referrer is not null then
      update profiles set referred_by = referrer where id = pid;
      insert into referrals (referred_id, referrer_id) values (pid, referrer) on conflict do nothing;
      perform credit(referrer, cfg('referral_reward', 300), 'Friend joined: @' || uname, 'ref:' || pid, 'pending');
    end if;
  end if;
  return pid;
end $$;

-- ---------------------------------------------------------------- tasks
-- "Open on X" pressed: remember when (server clock, first open wins).
create or replace function public.api_task_open(p_user uuid, p_task text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c task_completions%rowtype;
begin
  if not exists (select 1 from tasks where id = p_task and active) then
    return jsonb_build_object('ok', false, 'error', 'unknown_task');
  end if;
  insert into task_completions (user_id, task_id, opened_at) values (p_user, p_task, now())
  on conflict (user_id, task_id) do update set opened_at = coalesce(task_completions.opened_at, excluded.opened_at)
  returning * into c;
  return jsonb_build_object('ok', true, 'openedAt', c.opened_at, 'completedAt', c.completed_at, 'now', now());
end $$;

-- Verify and credit a task once. p_evidence: {"url": "..."} for reply_url.
create or replace function public.api_task_claim(p_user uuid, p_task text, p_evidence jsonb default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t tasks%rowtype;
  c task_completions%rowtype;
  me profiles%rowtype;
  link text := coalesce(p_evidence ->> 'url', '');
  status_id text;
  joined int;
  done int;
begin
  select * into t from tasks where id = p_task and active;
  if not found then return jsonb_build_object('ok', false, 'error', 'unknown_task'); end if;
  select * into me from profiles where id = p_user for update;
  select * into c from task_completions where user_id = p_user and task_id = p_task for update;
  if c.completed_at is not null then
    return jsonb_build_object('ok', true, 'already', true, 'allocation', me.points);
  end if;

  if t.verification = 'timer' then
    if c.opened_at is null then return jsonb_build_object('ok', false, 'error', 'not_opened'); end if;
    if now() - c.opened_at < make_interval(secs => t.min_wait_sec) then
      return jsonb_build_object('ok', false, 'error', 'too_early',
        'wait', ceil(extract(epoch from (c.opened_at + make_interval(secs => t.min_wait_sec) - now()))));
    end if;
  elsif t.verification = 'reply_url' then
    -- The link must be a post by the signed-in account, and not one already used for another task.
    if link !~* ('^https://(www\.)?(x|twitter)\.com/' || me.x_username || '/status/[0-9]+') then
      return jsonb_build_object('ok', false, 'error', 'bad_link');
    end if;
    status_id := substring(link from '/status/([0-9]+)');
    if exists (select 1 from task_completions where user_id = p_user and task_id <> p_task
               and substring(evidence ->> 'url' from '/status/([0-9]+)') = status_id) then
      return jsonb_build_object('ok', false, 'error', 'link_reused');
    end if;
  elsif t.verification = 'referral' then
    select count(*) into joined from referrals where referrer_id = p_user and status = 'qualified';
    if joined < coalesce((t.params ->> 'need')::int, 1) then
      return jsonb_build_object('ok', false, 'error', 'not_enough_friends', 'have', joined, 'need', coalesce((t.params ->> 'need')::int, 1));
    end if;
  elsif t.verification = 'x_api' then
    if coalesce((p_evidence ->> 'x_api_ok')::boolean, false) is not true then
      return jsonb_build_object('ok', false, 'error', 'not_verified');
    end if;
  end if;

  insert into task_completions (user_id, task_id, opened_at, completed_at, evidence)
  values (p_user, p_task, coalesce(c.opened_at, now()), now(), p_evidence)
  on conflict (user_id, task_id) do update set completed_at = now(), evidence = excluded.evidence;
  perform credit(p_user, t.reward, 'Task: ' || t.id, 'task:' || p_user || ':' || p_task);

  -- The referral counts once the invited friend has done enough tasks.
  select count(*) into done from task_completions where user_id = p_user and completed_at is not null;
  if done >= cfg('ref_qualify_tasks', 1) then
    update referrals set status = 'qualified', qualified_at = now() where referred_id = p_user and status = 'pending';
    if found then perform release('ref:' || p_user); end if;
  end if;

  return jsonb_build_object('ok', true, 'reward', t.reward, 'allocation', (select points from profiles where id = p_user));
end $$;

-- ---------------------------------------------------------------- persuasion bonus
-- The model only proposes a score 0..3. Tiers are cumulative and each tier is paid once per user.
create or replace function public.api_pitch(p_user uuid, p_score int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p pitches%rowtype;
  maxa int := cfg('pitch_attempts', 3);
  s int := greatest(0, least(3, coalesce(p_score, 0)));
  awarded int := 0;
  amt int;
  i int;
begin
  if exists (select 1 from tasks t where t.active and t.required and not exists (
      select 1 from task_completions c where c.user_id = p_user and c.task_id = t.id and c.completed_at is not null)) then
    return jsonb_build_object('ok', false, 'error', 'locked');
  end if;
  insert into pitches (user_id) values (p_user) on conflict do nothing;
  select * into p from pitches where user_id = p_user for update;
  if p.attempts >= maxa then return jsonb_build_object('ok', false, 'error', 'no_attempts'); end if;
  update pitches set attempts = attempts + 1, best = greatest(best, s), updated_at = now() where user_id = p_user;
  for i in 1..s loop
    amt := cfg('pitch_t' || i, case i when 1 then 300 when 2 then 700 else 1500 end);
    if credit(p_user, amt, 'Persuasion bonus · tier ' || i, 'pitch:' || p_user || ':t' || i) then awarded := awarded + amt; end if;
  end loop;
  return jsonb_build_object('ok', true, 'score', s, 'awarded', awarded, 'attemptsLeft', maxa - p.attempts - 1,
    'allocation', (select points from profiles where id = p_user));
end $$;

-- ---------------------------------------------------------------- wallet
create or replace function public.api_set_wallet(p_user uuid, p_wallet text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  -- EVM addresses are case-insensitive, Solana base58 is not.
  if exists (select 1 from profiles where id <> p_user and
      case when p_wallet like '0x%' then lower(wallet) = lower(p_wallet) else wallet = p_wallet end) then
    return jsonb_build_object('ok', false, 'error', 'wallet_taken');
  end if;
  update profiles set wallet = p_wallet where id = p_user;
  return jsonb_build_object('ok', true, 'wallet', p_wallet);
end $$;

-- ---------------------------------------------------------------- chat
-- Rate limit, return recent history for the model, store the user's message.
create or replace function public.api_chat_begin(p_user uuid, p_text text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare hist jsonb;
begin
  if hit('chat:' || p_user || ':' || to_char(now(), 'YYYYMMDDHH24MI')) > cfg('chat_per_minute', 8) then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;
  if hit('chatday:' || p_user || ':' || to_char(now(), 'YYYYMMDD')) > cfg('chat_per_day', 150) then
    return jsonb_build_object('ok', false, 'error', 'daily_limit');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('role', role, 'text', text) order by id), '[]'::jsonb) into hist
  from (select id, role, text from chat_messages where user_id = p_user order by id desc limit 16) m;
  insert into chat_messages (user_id, role, text) values (p_user, 'user', left(p_text, 1000));
  update profiles set last_seen = now() where id = p_user;
  return jsonb_build_object('ok', true, 'history', hist);
end $$;

create or replace function public.api_chat_end(p_user uuid, p_text text, p_events jsonb default '[]', p_brain text default null) returns void
language sql security definer set search_path = public as $$
  insert into chat_messages (user_id, role, text, events, brain) values (p_user, 'agent', left(coalesce(p_text, ''), 2000), coalesce(p_events, '[]'::jsonb), p_brain)
$$;

create or replace function public.api_history(p_user uuid, p_limit int default 80) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('role', role, 'text', text, 'events', events, 'at', created_at) order by id), '[]'::jsonb)
  from (select * from chat_messages where user_id = p_user order by id desc limit least(p_limit, 200)) m
$$;

-- ---------------------------------------------------------------- reads
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
    'tasks', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', t.id, 'type', t.type, 'title', t.title, 'actionUrl', t.action_url, 'reward', t.reward,
        'verification', t.verification, 'waitSec', t.min_wait_sec, 'params', t.params, 'required', t.required,
        'openedAt', c.opened_at, 'completedAt', c.completed_at) order by t.sort), '[]'::jsonb)
      from tasks t left join task_completions c on c.task_id = t.id and c.user_id = p.id where t.active),
    'now', now()
  ) from profiles p where p.id = p_user
$$;

create or replace function public.api_leaderboard(p_limit int default 100) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(r order by r.rank), '[]'::jsonb) from (
    select row_number() over (order by points desc, created_at) as rank, x_username as username, avatar_url as avatar, points
    from profiles order by points desc, created_at limit least(p_limit, 500)
  ) r
$$;

-- ---------------------------------------------------------------- lockdown
alter table public.profiles         enable row level security;
alter table public.tasks            enable row level security;
alter table public.task_completions enable row level security;
alter table public.ledger           enable row level security;
alter table public.referrals        enable row level security;
alter table public.pitches          enable row level security;
alter table public.chat_messages    enable row level security;
alter table public.rate_buckets     enable row level security;
alter table public.app_config       enable row level security;

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- ---------------------------------------------------------------- config + seed
insert into app_config (key, value) values
  ('welcome_bonus', '100'), ('referral_reward', '300'), ('ref_qualify_tasks', '1'),
  ('pitch_attempts', '3'), ('pitch_t1', '300'), ('pitch_t2', '700'), ('pitch_t3', '1500'),
  ('chat_per_minute', '8'), ('chat_per_day', '150')
on conflict (key) do nothing;

-- Mirrors shared/tasks.mjs (DEMO mode). {handle} / {post} / {ref} come from shared/brand.mjs at request time.
insert into tasks (id, type, title, action_url, reward, verification, min_wait_sec, params, required, sort) values
  ('follow',   'follow', 'Follow @{handle} on X',  'https://x.com/intent/follow?screen_name={handle}', 500, 'timer', 6, '{}', true, 1),
  ('like-1',   'like',   'Like the pinned post',   'https://x.com/intent/like?tweet_id={post}',        250, 'timer', 5, '{}', true, 2),
  ('repost-1', 'repost', 'Repost the pinned post', 'https://x.com/intent/retweet?tweet_id={post}',     350, 'timer', 5, '{}', true, 3),
  ('reply-1',  'reply',  'Reply to the pinned post, then paste your reply link here', 'https://x.com/intent/tweet?in_reply_to={post}', 400, 'reply_url', 0, '{}', true, 4),
  ('quote-1',  'post',   'Post about signal with your invite link, then paste the link here',
     'https://x.com/intent/tweet?text=talked%20my%20way%20into%20the%20%24SIG%20reserve.%20your%20turn%3A&url={ref}', 500, 'reply_url', 0, '{}', false, 6),
  ('invite-2', 'invite', 'Bring 2 friends who finish a task', null, 1000, 'referral', 0, '{"need": 2}', false, 7)
on conflict (id) do update set type = excluded.type, title = excluded.title, action_url = excluded.action_url,
  reward = excluded.reward, verification = excluded.verification, min_wait_sec = excluded.min_wait_sec,
  params = excluded.params, required = excluded.required, sort = excluded.sort;
