-- Orbit is a conversation mode, not a fifth provider. Existing provider/RLS contracts stay intact.
alter table public.conversations add column if not exists orbit_mode boolean not null default false;
alter table public.messages add column if not exists orbit_details jsonb;
create index if not exists conversations_orbit_idx on public.conversations(user_id,orbit_mode,updated_at);

-- One in-flight Orbit turn per student; lease expires after a terminated server process.
create table if not exists public.orbit_turn_leases (
 user_id uuid primary key references auth.users(id) on delete cascade,
 request_id uuid not null,
 expires_at timestamptz not null
);
alter table public.orbit_turn_leases enable row level security;
create or replace function public.claim_orbit_turn(p_user_id uuid,p_request_id uuid)
returns boolean language plpgsql security definer set search_path=public as $$
begin
 insert into public.orbit_turn_leases values(p_user_id,p_request_id,now()+interval '5 minutes')
 on conflict(user_id) do update set request_id=excluded.request_id,expires_at=excluded.expires_at
 where orbit_turn_leases.expires_at<now();
 return found;
end $$;
create or replace function public.release_orbit_turn(p_user_id uuid,p_request_id uuid)
returns void language sql security definer set search_path=public as $$
 delete from public.orbit_turn_leases where user_id=p_user_id and request_id=p_request_id;
$$;
revoke all on function public.claim_orbit_turn(uuid,uuid) from public,anon,authenticated;
revoke all on function public.release_orbit_turn(uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_orbit_turn(uuid,uuid) to service_role;
grant execute on function public.release_orbit_turn(uuid,uuid) to service_role;
