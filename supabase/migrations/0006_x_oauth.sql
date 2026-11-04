-- glyph — sign-in through X (OAuth 2.0) replaces typing a handle. Run after 0005. Safe to run more than once.
--
-- Accounts made by typing a handle have x_id = 'h:<handle>'. When the real owner of that handle signs in
-- with X for the first time, they take that account over (progress kept). Its wallet is cleared, because
-- under the old sign-in anyone who typed the handle could have saved one; the owner pastes theirs again.
-- Handle accounts nobody ever claims stay as they are: see docs/OPERATIONS.md for how to leave them out of a drop.

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
  -- 1. this X account signed in before
  select id into pid from profiles where x_id = p_x_id for update;

  -- 2. first X sign-in of a handle that was typed in earlier: the owner claims that account
  if pid is null then
    select id into pid from profiles where x_id = 'h:' || uname for update;
    if pid is not null then
      update profiles set x_id = p_x_id, wallet = null where id = pid;
    end if;
  end if;

  -- The handle belongs to whoever proves it now: if another profile still holds it (a renamed or
  -- recycled handle), move that one aside until its owner signs in again.
  update profiles set x_username = x_username || '~' || substr(md5(id::text), 1, 4)
  where x_username = uname and (pid is null or id <> pid);

  if pid is not null then
    update profiles set x_username = uname, display_name = p_name, avatar_url = p_avatar,
      x_created_at = coalesce(p_x_created_at, x_created_at), followers = coalesce(p_followers, followers),
      last_seen = now()
    where id = pid;
    return pid;
  end if;

  -- 3. a new account
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

-- Typed-handle sign-in is gone from the site; the database function goes too.
drop function if exists public.api_login_handle(text, text, text, text);

-- ---------------------------------------------------------------- lockdown (new objects)
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
