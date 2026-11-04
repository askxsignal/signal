-- glyph — sign-in by typing an X handle (no X OAuth). Run after 0001 and 0002. Safe to run more than once.
--
-- How a handle stays yours without OAuth:
--   • the first device that signs in with a handle claims it (the server keeps a hash of a random
--     device cookie, never the cookie itself);
--   • the same device signs in again freely;
--   • another device gets "claimed" and a one-time code; it can take the handle over only by posting
--     that code from the X account (the server checks the post through X's public oEmbed).
-- Limits per IP stop one machine from minting handles in bulk.

alter table public.profiles add column if not exists device_hash    text;
alter table public.profiles add column if not exists verify_code    text;
alter table public.profiles add column if not exists verify_expires timestamptz;
create unique index if not exists profiles_username_key on public.profiles (x_username);

insert into app_config (key, value) values
  ('logins_per_ip_hour', '30'), ('new_handles_per_ip_day', '4')
on conflict (key) do nothing;

-- Sign in with a typed handle. Returns {ok, uid} or {ok:false, error, code?}.
create or replace function public.api_login_handle(p_handle text, p_device_hash text, p_ip text default null, p_ref text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  h   text := lower(trim(both '@' from coalesce(p_handle, '')));
  p   profiles%rowtype;
  uid uuid;
  code text;
begin
  if h !~ '^[a-z0-9_]{1,15}$' then return jsonb_build_object('ok', false, 'error', 'bad_handle'); end if;
  if coalesce(p_device_hash, '') = '' then return jsonb_build_object('ok', false, 'error', 'no_device'); end if;
  if p_ip is not null and hit('login:' || p_ip || ':' || to_char(now(), 'YYYYMMDDHH24')) > cfg('logins_per_ip_hour', 30) then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  select * into p from profiles where x_username = h for update;

  if not found then
    -- A brand-new handle: limited per IP per day so one machine can't farm accounts.
    if p_ip is not null and hit('newh:' || p_ip || ':' || to_char(now(), 'YYYYMMDD')) > cfg('new_handles_per_ip_day', 4) then
      return jsonb_build_object('ok', false, 'error', 'too_many_handles');
    end if;
    uid := upsert_x_user('h:' || h, h, h, null, null, null, p_ref);
    update profiles set device_hash = p_device_hash where id = uid;
    return jsonb_build_object('ok', true, 'uid', uid, 'new', true);
  end if;

  if p.device_hash is null or p.device_hash = p_device_hash then
    update profiles set device_hash = p_device_hash, last_seen = now() where id = p.id;
    return jsonb_build_object('ok', true, 'uid', p.id, 'new', false);
  end if;

  -- Claimed by another device: hand out (or reuse) a short-lived proof code.
  if p.verify_code is null or p.verify_expires < now() then
    code := 'glyph-' || substr(md5(gen_random_uuid()::text), 1, 6);
    update profiles set verify_code = code, verify_expires = now() + interval '30 minutes' where id = p.id;
  else
    code := p.verify_code;
  end if;
  return jsonb_build_object('ok', false, 'error', 'claimed', 'code', code);
end $$;

-- The current proof code for a handle (the server checks the post against it).
create or replace function public.api_verify_code(p_handle text) returns text
language sql stable security definer set search_path = public as $$
  select verify_code from profiles where x_username = lower(p_handle) and verify_expires > now()
$$;

-- The server confirmed a post with the code from that account: move the handle to this device.
create or replace function public.api_verify_handle(p_handle text, p_device_hash text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  update profiles set device_hash = p_device_hash, verify_code = null, verify_expires = null, last_seen = now()
  where x_username = lower(p_handle) and verify_code is not null and verify_expires > now()
  returning id into uid;
  if uid is null then return jsonb_build_object('ok', false, 'error', 'expired'); end if;
  return jsonb_build_object('ok', true, 'uid', uid);
end $$;

-- ---------------------------------------------------------------- lockdown (new objects)
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
