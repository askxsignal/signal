-- glyph — sign-in is just the handle: no device claim, no proof post. Run after 0003. Safe to run more than once.
--
-- Because anyone can type any handle, the one thing that must not be changeable from the chat is the
-- payout wallet: once saved it is locked (an admin can clear it in SQL). The per-IP limits on new
-- handles and sign-ins from 0003 stay.

-- Sign in with a typed handle. Returns {ok, uid, new} or {ok:false, error}.
create or replace function public.api_login_handle(p_handle text, p_device_hash text, p_ip text default null, p_ref text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  h   text := lower(trim(both '@' from coalesce(p_handle, '')));
  pid uuid;
begin
  if h !~ '^[a-z0-9_]{1,15}$' then return jsonb_build_object('ok', false, 'error', 'bad_handle'); end if;
  if p_ip is not null and hit('login:' || p_ip || ':' || to_char(now(), 'YYYYMMDDHH24')) > cfg('logins_per_ip_hour', 30) then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  select id into pid from profiles where x_username = h;
  if pid is not null then
    update profiles set device_hash = coalesce(p_device_hash, device_hash), last_seen = now() where id = pid;
    return jsonb_build_object('ok', true, 'uid', pid, 'new', false);
  end if;

  -- A brand-new handle: limited per IP per day so one machine can't farm accounts.
  if p_ip is not null and hit('newh:' || p_ip || ':' || to_char(now(), 'YYYYMMDD')) > cfg('new_handles_per_ip_day', 4) then
    return jsonb_build_object('ok', false, 'error', 'too_many_handles');
  end if;
  pid := upsert_x_user('h:' || h, h, h, null, null, null, p_ref);
  update profiles set device_hash = p_device_hash where id = pid;
  return jsonb_build_object('ok', true, 'uid', pid, 'new', true);
end $$;

-- The wallet is set once. Changing it later needs an admin (see docs/OPERATIONS.md).
create or replace function public.api_set_wallet(p_user uuid, p_wallet text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cur text;
begin
  select wallet into cur from profiles where id = p_user;
  if cur is not null then
    if cur = p_wallet or (cur like '0x%' and lower(cur) = lower(p_wallet)) then
      return jsonb_build_object('ok', true, 'wallet', cur, 'already', true);
    end if;
    return jsonb_build_object('ok', false, 'error', 'wallet_locked', 'wallet', cur);
  end if;
  -- EVM addresses are case-insensitive, Solana base58 is not.
  if exists (select 1 from profiles where id <> p_user and
      case when p_wallet like '0x%' then lower(wallet) = lower(p_wallet) else wallet = p_wallet end) then
    return jsonb_build_object('ok', false, 'error', 'wallet_taken');
  end if;
  update profiles set wallet = p_wallet where id = p_user;
  return jsonb_build_object('ok', true, 'wallet', p_wallet);
end $$;

-- Leftovers of the proof-post flow are no longer used.
drop function if exists public.api_verify_code(text);
drop function if exists public.api_verify_handle(text, text);
update profiles set verify_code = null, verify_expires = null where verify_code is not null;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
