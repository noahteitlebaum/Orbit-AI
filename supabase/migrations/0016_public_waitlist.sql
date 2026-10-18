-- Waitlist interest is separate from auth, enrolment verification, app access and billing.
create table if not exists public.waitlist_interest(
 id uuid primary key default gen_random_uuid(),email text not null unique check(char_length(email)<=254),
 institution text not null check(char_length(institution) between 1 and 120),
 consent_version text not null default 'waitlist-2026-10',created_at timestamptz not null default now()
);
alter table public.waitlist_interest enable row level security;
revoke all on public.waitlist_interest from anon,authenticated;
create table if not exists public.waitlist_limits(bucket text primary key,window_start timestamptz not null,count integer not null);
alter table public.waitlist_limits enable row level security;
revoke all on public.waitlist_limits from anon,authenticated;
create or replace function public.join_waitlist(p_email text,p_institution text,p_bucket text) returns boolean language plpgsql security definer set search_path=public as $$
declare hits integer;
begin
 delete from public.waitlist_limits where window_start<now()-interval '2 hours';
 insert into public.waitlist_limits values(p_bucket,now(),1) on conflict(bucket) do update set
 count=case when waitlist_limits.window_start<now()-interval '1 hour' then 1 else waitlist_limits.count+1 end,
 window_start=case when waitlist_limits.window_start<now()-interval '1 hour' then now() else waitlist_limits.window_start end returning count into hits;
 if hits>8 then return false; end if;
 insert into public.waitlist_interest(email,institution) values(p_email,p_institution) on conflict(email) do nothing;
 return true;
end $$;
revoke all on function public.join_waitlist(text,text,text) from public,anon,authenticated;
grant execute on function public.join_waitlist(text,text,text) to service_role;
