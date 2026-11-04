-- glyph — limits that protect the model key. Run after 0001. Self-contained, safe to run more than once.
--
-- Layers (all numbers live in app_config and can be changed without a deploy):
--   1. one message at a time per user (a 20 s lock, released when the answer is saved)
--   2. message rate per user: per minute / per hour / per day
--   3. message rate per IP per hour (several X accounts from one machine share it)
--   4. Model budget per user per day: calls and tokens; when spent, glyph keeps answering with the
--      scripted brain (tasks still work), it just stops spending the key
--   5. Model budget for the whole site per day (tokens): a circuit breaker for the bill
-- Message limits block the message (HTTP 429). Model budgets never block, they downgrade the brain.

alter table public.profiles add column if not exists chat_busy_until timestamptz;

-- Day counters: bucket = 'user:<uuid>:<yyyymmdd>' | 'global:<yyyymmdd>'
create table if not exists public.usage_daily (
  bucket     text primary key,
  calls      int    not null default 0,
  tokens     bigint not null default 0,
  created_at timestamptz not null default now()
);
alter table public.usage_daily enable row level security;

insert into app_config (key, value) values
  ('chat_per_minute', '6'), ('chat_per_hour', '40'), ('chat_per_day', '120'), ('chat_per_ip_hour', '150'),
  ('model_calls_per_user_day', '80'), ('model_tokens_per_user_day', '150000'),
  ('model_tokens_global_day', '4000000')
on conflict (key) do nothing;

-- Current minute / hour limits replace the 0001 defaults only if those were never edited.
update app_config set value = '6' where key = 'chat_per_minute' and value = '8';
update app_config set value = '120' where key = 'chat_per_day' and value = '150';

create or replace function public.usage_of(p_bucket text) returns usage_daily
language sql stable security definer set search_path = public as
$$ select coalesce((select u from usage_daily u where bucket = p_bucket), row(p_bucket, 0, 0, now())::usage_daily) $$;

-- ---------------------------------------------------------------- chat begin (replaces the 0001 version)
drop function if exists public.api_chat_begin(uuid, text);

create or replace function public.api_chat_begin(p_user uuid, p_text text, p_ip text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  hist  jsonb;
  day   text := to_char(now() at time zone 'utc', 'YYYYMMDD');
  u     usage_daily;
  g     usage_daily;
  locked boolean;
begin
  -- 1. one at a time
  update profiles set chat_busy_until = now() + interval '20 seconds'
  where id = p_user and (chat_busy_until is null or chat_busy_until < now())
  returning true into locked;
  if locked is null then
    return jsonb_build_object('ok', false, 'error', 'busy', 'retryAfter', 3);
  end if;

  -- 2. per user
  if hit('chat:' || p_user || ':' || to_char(now(), 'YYYYMMDDHH24MI')) > cfg('chat_per_minute', 6) then
    update profiles set chat_busy_until = null where id = p_user;
    return jsonb_build_object('ok', false, 'error', 'rate_minute', 'retryAfter', 60 - floor(extract(second from now()))::int);
  end if;
  if hit('chath:' || p_user || ':' || to_char(now(), 'YYYYMMDDHH24')) > cfg('chat_per_hour', 40) then
    update profiles set chat_busy_until = null where id = p_user;
    return jsonb_build_object('ok', false, 'error', 'rate_hour', 'retryAfter', 3600 - floor(extract(epoch from now()))::int % 3600);
  end if;
  if hit('chatday:' || p_user || ':' || day) > cfg('chat_per_day', 120) then
    update profiles set chat_busy_until = null where id = p_user;
    return jsonb_build_object('ok', false, 'error', 'rate_day', 'retryAfter', 86400 - floor(extract(epoch from now()))::int % 86400);
  end if;

  -- 3. per IP (hashed by the server before it gets here)
  if p_ip is not null and hit('ip:' || p_ip || ':' || to_char(now(), 'YYYYMMDDHH24')) > cfg('chat_per_ip_hour', 150) then
    update profiles set chat_busy_until = null where id = p_user;
    return jsonb_build_object('ok', false, 'error', 'rate_ip', 'retryAfter', 3600 - floor(extract(epoch from now()))::int % 3600);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('role', role, 'text', text) order by id), '[]'::jsonb) into hist
  from (select id, role, text from chat_messages where user_id = p_user order by id desc limit 16) m;
  insert into chat_messages (user_id, role, text) values (p_user, 'user', left(p_text, 1000));
  update profiles set last_seen = now() where id = p_user;

  -- 4 + 5. may this turn spend the model key?
  u := usage_of('user:' || p_user || ':' || day);
  g := usage_of('global:' || day);
  return jsonb_build_object('ok', true, 'history', hist,
    'model', u.calls < cfg('model_calls_per_user_day', 80)
          and u.tokens < cfg('model_tokens_per_user_day', 150000)
          and g.tokens < cfg('model_tokens_global_day', 4000000));
end $$;

-- ---------------------------------------------------------------- chat end (replaces the 0001 version)
drop function if exists public.api_chat_end(uuid, text, jsonb, text);

create or replace function public.api_chat_end(
  p_user uuid, p_text text, p_events jsonb default '[]', p_brain text default null,
  p_calls int default 0, p_tokens int default 0
) returns void
language plpgsql security definer set search_path = public as $$
declare day text := to_char(now() at time zone 'utc', 'YYYYMMDD');
begin
  if coalesce(p_text, '') <> '' then
    insert into chat_messages (user_id, role, text, events, brain)
    values (p_user, 'agent', left(p_text, 2000), coalesce(p_events, '[]'::jsonb), p_brain);
  end if;
  if coalesce(p_calls, 0) > 0 or coalesce(p_tokens, 0) > 0 then
    insert into usage_daily (bucket, calls, tokens) values ('user:' || p_user || ':' || day, greatest(p_calls, 0), greatest(p_tokens, 0))
    on conflict (bucket) do update set calls = usage_daily.calls + excluded.calls, tokens = usage_daily.tokens + excluded.tokens;
    insert into usage_daily (bucket, calls, tokens) values ('global:' || day, greatest(p_calls, 0), greatest(p_tokens, 0))
    on conflict (bucket) do update set calls = usage_daily.calls + excluded.calls, tokens = usage_daily.tokens + excluded.tokens;
  end if;
  update profiles set chat_busy_until = null where id = p_user;
  if random() < 0.01 then delete from usage_daily where created_at < now() - interval '40 days'; end if;
end $$;

-- ---------------------------------------------------------------- admin view of spend
create or replace function public.api_usage_today() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'global', (select to_jsonb(u) from usage_of('global:' || to_char(now() at time zone 'utc', 'YYYYMMDD')) u),
    'top_users', (select coalesce(jsonb_agg(x order by x.tokens desc), '[]'::jsonb) from (
      select p.x_username, d.calls, d.tokens from usage_daily d
      join profiles p on d.bucket = 'user:' || p.id || ':' || to_char(now() at time zone 'utc', 'YYYYMMDD')
      order by d.tokens desc limit 20) x))
$$;

-- ---------------------------------------------------------------- lockdown (new objects)
revoke all on all tables in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
