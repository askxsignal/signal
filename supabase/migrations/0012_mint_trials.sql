-- signal — the mint needs the trials done: follow, like, repost, reply and the card quote (params.mint).
-- Run after 0011. Safe to run more than once.
--
-- Like / repost / reply are new tasks on the pinned post (shared/brand.mjs → postId): everyone does them
-- again, including people who did the old ones (the old tasks are switched off, rewards already earned stay,
-- the new ones pay again). Follow and the card quote stay done for those who did them, so old operators redo
-- three trials and newcomers do all five. /mintallo hands them out one by one, and the server refuses to
-- mint until all of them are done.
-- To open minting for everyone (after creating the big tree, see docs/OPERATIONS.md):
--   insert into app_config (key, value) values ('nft_open', '1') on conflict (key) do update set value = excluded.value;

insert into tasks (id, type, title, action_url, reward, verification, min_wait_sec, params, required, sort) values
  ('like-3',   'like',   'Like the pinned post',   'https://x.com/intent/like?tweet_id={post}',    250, 'timer', 5, '{"mint": true}', true, 2),
  ('repost-3', 'repost', 'Repost the pinned post', 'https://x.com/intent/retweet?tweet_id={post}', 350, 'timer', 5, '{"mint": true}', true, 3),
  ('reply-3',  'reply',  'Reply to the pinned post, then paste your reply link here', 'https://x.com/intent/tweet?in_reply_to={post}&text=gm%20signal.%20claiming%20my%20%24SIG%20allocation%20%F0%9F%9B%B0', 400, 'reply_url', 0, '{"mint": true}', true, 4)
on conflict (id) do update set active = true, type = excluded.type, title = excluded.title, action_url = excluded.action_url,
  reward = excluded.reward, verification = excluded.verification, min_wait_sec = excluded.min_wait_sec,
  params = excluded.params, required = excluded.required, sort = excluded.sort;
update tasks set active = false where id in ('like-2', 'repost-2', 'reply-2');
-- The follow and the card quote count for the mint too. People who did them before keep them done, so they
-- only redo like / repost / reply; newcomers do all five.
update tasks set params = params || '{"mint": true}' where id in ('follow', 'card-2');

-- All mint trials done?
create or replace function public.nft_ready(p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (
    select 1 from tasks t
    where t.active and t.params ->> 'mint' = 'true'
      and not exists (select 1 from task_completions c where c.user_id = p_user and c.task_id = t.id and c.completed_at is not null))
$$;

-- Same as 0010, plus `ready` (the mint trials are done).
create or replace function public.api_nft_state(p_user uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'eligible', nft_eligible(p),
    'ready', nft_ready(p.id),
    'allocationStatus', p.allocation_status,
    'wallet', p.wallet,
    'handle', split_part(p.x_username, '~', 1),
    'mint', (select jsonb_build_object('id', m.id, 'status', m.status, 'assetId', m.asset_id, 'signature', m.signature,
               'height', m.last_valid_height, 'owner', m.owner, 'network', m.network, 'mintedAt', m.minted_at)
             from nft_mints m where m.user_id = p.id))
  from profiles p where p.id = p_user
$$;

-- Same as 0010, plus: no mint before the mint trials are done (error need_tasks). A mint already started
-- or finished is never blocked.
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
    update nft_mints set status = 'minting', owner = p_owner, network = p_network, tree = p_tree, signature = null,
      last_valid_height = null, error = null, attempts = attempts + 1, locked_until = now() + interval '90 seconds', updated_at = now()
    where id = m.id returning * into m;
    return jsonb_build_object('ok', true, 'state', 'go', 'id', m.id, 'owner', m.owner);
  end if;

  if not nft_ready(p_user) then return jsonb_build_object('ok', false, 'error', 'need_tasks'); end if;
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

-- ---------------------------------------------------------------- lockdown (new objects)
revoke all on all tables in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
