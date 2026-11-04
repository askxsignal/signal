-- signal — /mintallo in the chat, signal's messages after a mint, and the +1000 "quote your NFT" task.
-- Run after 0010. Safe to run more than once.

-- ---------------------------------------------------------------- the NFT quote task
-- Only for people whose NFT has landed (params.needs = 'nft'): hidden from everyone else in api_me and
-- refused by api_task_claim. Not required (does not gate the pitch). Checked like the card: the pasted
-- link must be a public post by the signed-in account, not used for another task.
insert into tasks (id, type, title, action_url, reward, verification, min_wait_sec, params, required, sort) values
  ('nft-quote', 'nftquote', 'Quote the pinned post with your NFT, then paste the link here',
     'https://x.com/{handle}/status/{post}',
     1000, 'reply_url', 0, '{"needs": "nft"}', false, 8)
on conflict (id) do update set active = true, type = excluded.type, title = excluded.title, action_url = excluded.action_url,
  reward = excluded.reward, verification = excluded.verification, params = excluded.params,
  required = excluded.required, sort = excluded.sort;

create or replace function public.has_nft(p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from nft_mints where user_id = p_user and status = 'minted')
$$;

-- ---------------------------------------------------------------- api_task_claim (+ the NFT gate)
-- Same as 0001, plus: a task with params.needs = 'nft' needs a minted NFT.
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
  if t.params ->> 'needs' = 'nft' and not has_nft(p_user) then
    return jsonb_build_object('ok', false, 'error', 'need_nft');
  end if;
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

-- Opening ("Open post → Quote") a task you cannot have is refused too.
create or replace function public.api_task_open(p_user uuid, p_task text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t tasks%rowtype; c task_completions%rowtype;
begin
  select * into t from tasks where id = p_task and active;
  if not found then return jsonb_build_object('ok', false, 'error', 'unknown_task'); end if;
  if t.params ->> 'needs' = 'nft' and not has_nft(p_user) then
    return jsonb_build_object('ok', false, 'error', 'need_nft');
  end if;
  insert into task_completions (user_id, task_id, opened_at) values (p_user, p_task, now())
  on conflict (user_id, task_id) do update set opened_at = coalesce(task_completions.opened_at, excluded.opened_at)
  returning * into c;
  return jsonb_build_object('ok', true, 'openedAt', c.opened_at, 'completedAt', c.completed_at, 'now', now());
end $$;

-- ---------------------------------------------------------------- signal's messages after a mint
-- Written once per person (the first time the server sees the mint landed). Returns true when it wrote
-- them now, so the page shows them live exactly once; after a reload they come back with the history.
create or replace function public.api_nft_announce(p_user uuid, p_messages jsonb) returns boolean
language plpgsql security definer set search_path = public as $$
declare m jsonb;
begin
  if not has_nft(p_user) then return false; end if;
  perform 1 from profiles where id = p_user for update; -- one writer at a time per person
  if exists (select 1 from chat_messages where user_id = p_user and brain = 'nft-minted') then return false; end if;
  for m in select * from jsonb_array_elements(coalesce(p_messages, '[]'::jsonb)) loop
    insert into chat_messages (user_id, role, text, events, brain)
    values (p_user, 'agent', left(coalesce(m ->> 'text', ''), 2000), coalesce(m -> 'events', '[]'::jsonb), 'nft-minted');
  end loop;
  return true;
end $$;

-- ---------------------------------------------------------------- api_me (NFT-only tasks hidden until minted)
-- Same as 0010, except tasks with params.needs = 'nft' are listed only after the NFT has landed.
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
      from tasks t left join task_completions c on c.task_id = t.id and c.user_id = p.id
      where t.active and (t.params ->> 'needs' is distinct from 'nft' or has_nft(p.id))),
    'now', now()
  ) from profiles p where p.id = p_user
$$;

-- ---------------------------------------------------------------- lockdown (new objects)
revoke all on all tables in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
