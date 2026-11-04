-- signal — the profile card task, the card's standing (rank, operator number) and secret phrases.
-- Run after 0004. Safe to run more than once.

-- ---------------------------------------------------------------- the card task
-- The last required trial: post your operator pass on X and paste the link. The server checks through
-- X's public oEmbed that the post is yours, carries an image and mentions signal (params.must / params.media).
insert into tasks (id, type, title, action_url, reward, verification, min_wait_sec, params, required, sort) values
  ('card-1', 'card', 'Post your operator pass on X, then paste the link here',
     'https://x.com/intent/tweet?text=my%20%24SIG%20operator%20pass.%20ask%20signal%20anything%3A&url={ref}',
     750, 'reply_url', 0, '{"must": ["signal"], "media": true}', true, 5)
on conflict (id) do update set type = excluded.type, title = excluded.title, action_url = excluded.action_url,
  reward = excluded.reward, verification = excluded.verification, min_wait_sec = excluded.min_wait_sec,
  params = excluded.params, required = excluded.required, sort = excluded.sort;
-- The optional bonus tasks move after it.
update tasks set sort = 6 where id = 'quote-1';
update tasks set sort = 7 where id = 'invite-2';

-- ---------------------------------------------------------------- api_me + standing
-- Same as 0001, plus `standing`: rank by allocation, how many operators there are, this operator's number.
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
    'tasks', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', t.id, 'type', t.type, 'title', t.title, 'actionUrl', t.action_url, 'reward', t.reward,
        'verification', t.verification, 'waitSec', t.min_wait_sec, 'params', t.params, 'required', t.required,
        'openedAt', c.opened_at, 'completedAt', c.completed_at) order by t.sort), '[]'::jsonb)
      from tasks t left join task_completions c on c.task_id = t.id and c.user_id = p.id where t.active),
    'now', now()
  ) from profiles p where p.id = p_user
$$;

-- ---------------------------------------------------------------- secret phrases
-- Typed anywhere in a chat message, a phrase credits its reward once per person. Phrases live only
-- here (never in the site's code). Stored normalised: lowercase, words separated by single spaces.
create table if not exists public.secret_codes (
  code       text primary key,
  reward     int  not null check (reward > 0),
  max_uses   int,                                  -- null = no limit; otherwise first N people (fcfs)
  uses       int  not null default 0,
  active     boolean not null default true,
  note       text,                                 -- where it is hidden, for the team
  created_at timestamptz not null default now()
);
alter table public.secret_codes enable row level security;
revoke all on public.secret_codes from anon, authenticated;

-- lowercase, anything that is not a letter, digit or $ becomes a space, spaces collapse.
create or replace function public.norm_code(p text) returns text
language sql immutable set search_path = public as $$
  select btrim(regexp_replace(lower(coalesce(p, '')), '[^a-z0-9а-яё$]+', ' ', 'g'))
$$;

-- Returns {matched:false} when the message holds no active phrase; otherwise
-- {matched:true, ok:true, reward, allocation} or {matched:true, ok:false, error: already | exhausted}.
create or replace function public.api_redeem_code(p_user uuid, p_text text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  msg text := ' ' || norm_code(left(p_text, 1000)) || ' ';
  c   secret_codes%rowtype;
  k   text;
begin
  select * into c from secret_codes
  where active and code <> '' and position(' ' || code || ' ' in msg) > 0
  order by length(code) desc limit 1;
  if not found then return jsonb_build_object('matched', false); end if;

  k := 'code:' || p_user || ':' || c.code;
  if exists (select 1 from ledger where idempotency_key = k) then
    return jsonb_build_object('matched', true, 'ok', false, 'error', 'already');
  end if;
  select * into c from secret_codes where code = c.code for update;
  if c.max_uses is not null and c.uses >= c.max_uses then
    return jsonb_build_object('matched', true, 'ok', false, 'error', 'exhausted');
  end if;
  if not credit(p_user, c.reward, 'Secret phrase', k) then
    return jsonb_build_object('matched', true, 'ok', false, 'error', 'already');
  end if;
  update secret_codes set uses = uses + 1 where code = c.code;
  return jsonb_build_object('matched', true, 'ok', true, 'reward', c.reward,
    'allocation', (select points from profiles where id = p_user));
end $$;

-- Phrases live only in your database, never in the code. Add your own, e.g.:
--   insert into secret_codes (code, reward, max_uses, note) values (norm_code('your phrase'), 500, null, 'where it is hidden');

-- ---------------------------------------------------------------- lockdown (new objects)
revoke all on all tables in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
