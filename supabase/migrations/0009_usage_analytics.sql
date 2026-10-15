-- Financial source of truth: USD provider costs vs USD budget charges; CAD allowances converted once per period.
-- Additive migration. Existing USD tester budgets keep their balance and remain labelled legacy.
alter table public.budgets add column if not exists allowance_cad_micros bigint;
alter table public.budgets add column if not exists usd_cad_rate numeric check (usd_cad_rate > 0);
alter table public.budgets add column if not exists expires_at timestamptz;
alter table public.ledger add column if not exists provider text;
alter table public.ledger add column if not exists operation text not null default 'legacy';
alter table public.ledger add column if not exists conversation_id uuid references public.conversations(id) on delete set null;
alter table public.ledger add column if not exists actual_usd_micros bigint check (actual_usd_micros >= 0);
alter table public.ledger add column if not exists usd_cad_rate numeric check (usd_cad_rate > 0);
alter table public.ledger add column if not exists cache_write_tokens integer;
alter table public.ledger add column if not exists reasoning_reported boolean;
alter table public.ledger add column if not exists price_snapshot jsonb not null default '{}';
alter table public.ledger add column if not exists metadata jsonb not null default '{}';
-- Do not pretend legacy full-price cache estimates are exact provider costs.
create index if not exists ledger_conversation_idx on public.ledger(conversation_id, created_at);
create index if not exists ledger_operation_idx on public.ledger(operation, created_at);

create table if not exists public.enrollments (
  user_id uuid primary key references auth.users(id) on delete cascade,
  cohort text not null default 'western-phase1',
  plan text not null default 'trial' check (plan in ('trial', 'subscriber', 'tester')),
  trial_days integer not null default 7 check (trial_days in (7,30)),
  trial_started_at timestamptz not null default now(),
  trial_ends_at timestamptz not null,
  price_cad_micros bigint not null default 30000000 check (price_cad_micros >= 0),
  allowance_cad_micros bigint not null default 2500000 check (allowance_cad_micros >= 0)
);
create table if not exists public.revenue_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  external_event_id text not null unique,
  kind text not null check (kind in ('payment','refund','cancellation')),
  net_cad_micros bigint not null default 0, -- net revenue excludes sales tax; refunds negative
  payment_fee_cad_micros bigint not null default 0 check (payment_fee_cad_micros >= 0),
  occurred_at timestamptz not null default now()
);
create table if not exists public.analytics_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  event text not null check (event in ('signup','trial_activated','conversation_created','message_sent','response_completed','model_switched','file_uploaded','feature_used','allowance_exhausted','context_retrieved')),
  properties jsonb not null default '{}',
  dedupe_key text unique,
  created_at timestamptz not null default now()
);
create index if not exists analytics_time_idx on public.analytics_events(created_at, event, user_id);
alter table public.enrollments enable row level security;
alter table public.revenue_events enable row level security;
alter table public.analytics_events enable row level security;
create policy "read own enrollment" on public.enrollments for select to authenticated using (user_id = auth.uid());
create policy "read own receipts" on public.revenue_events for select to authenticated using (user_id = auth.uid());
-- Analytics are service-role only, with no student policies.
insert into public.settings(key,value) values
 ('trial_allowance_cad_micros','2500000'), ('trial_days','7'), ('subscription_price_cad_micros','30000000'),
 ('monthly_allowance_cad_micros','20000000'), ('payments_enabled','false') on conflict (key) do nothing;
-- Intentionally no assumed FX rate. Set usd_cad_rate from your actual provider/payment conversion, e.g. JSON number.

create or replace function public.reserve_budget_v2(
 p_user_id uuid, p_request_id text, p_model_id text, p_kind text, p_bound_micros bigint,
 p_metadata jsonb default '{}', p_price_snapshot jsonb default '{}'
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_rate numeric; v_cad bigint; v_days integer; v_result jsonb; v_enroll public.enrollments%rowtype;
begin
 -- Serialize this user's creation/reservations and duplicate request IDs (also across users).
 perform pg_advisory_xact_lock(hashtextextended(p_request_id,0));
 perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,1));
 if exists(select 1 from public.ledger where request_id=p_request_id) then
   return jsonb_build_object('ok',false,'reason','duplicate');
 end if;
 if coalesce((select value::text::boolean from public.settings where key='global_stop'),false) then
   return jsonb_build_object('ok',false,'reason','global_stop');
 end if;
 if p_metadata->>'conversationId' is not null and not exists(
   select 1 from public.conversations where id=(p_metadata->>'conversationId')::uuid and user_id=p_user_id
 ) then raise exception 'conversation ownership'; end if;
 if not exists(select 1 from public.budgets where user_id=p_user_id) then
   v_rate := (select value::text::numeric from public.settings where key='usd_cad_rate');
   if v_rate is null or v_rate <= 0 then return jsonb_build_object('ok',false,'reason','fx_not_configured'); end if;
   select * into v_enroll from public.enrollments where user_id=p_user_id;
   if not found then
     v_cad := coalesce((select value::text::bigint from public.settings where key='trial_allowance_cad_micros'),2500000);
     v_days := coalesce((select value::text::integer from public.settings where key='trial_days'),7);
     insert into public.enrollments(user_id,trial_days,trial_ends_at,allowance_cad_micros)
       values(p_user_id,v_days,now()+make_interval(days=>v_days),v_cad) returning * into v_enroll;
     insert into public.analytics_events(user_id,event,dedupe_key) values(p_user_id,'trial_activated','trial:'||p_user_id);
   end if;
   insert into public.budgets(user_id,allowance_micros,allowance_cad_micros,usd_cad_rate,expires_at)
     values(p_user_id,floor(v_enroll.allowance_cad_micros/v_rate),v_enroll.allowance_cad_micros,v_rate,
       case when v_enroll.plan='trial' then v_enroll.trial_ends_at else null end);
 end if;
 if exists(select 1 from public.budgets where user_id=p_user_id and expires_at<=now()) then
   return jsonb_build_object('ok',false,'reason','trial_expired');
 end if;
 v_result := public.reserve_budget(p_user_id,p_request_id,p_model_id,p_kind,p_bound_micros);
 if (v_result->>'ok')::boolean then
   update public.ledger set provider=p_metadata->>'provider', operation=coalesce(p_metadata->>'operation','chat'),
     conversation_id=(p_metadata->>'conversationId')::uuid,
     usd_cad_rate=(select usd_cad_rate from public.budgets where user_id=p_user_id),
     metadata=p_metadata, price_snapshot=p_price_snapshot where request_id=p_request_id;
 end if;
 return v_result;
end $$;

create or replace function public.settle_budget_v2(
 p_request_id text, p_state text, p_actual_micros bigint,
 p_input_tokens integer default null, p_output_tokens integer default null,
 p_reasoning_tokens integer default null, p_cached_tokens integer default null, p_error_code text default null,
 p_cache_write_tokens integer default 0, p_reasoning_reported boolean default true, p_metadata jsonb default '{}'
) returns void language plpgsql security definer set search_path=public as $$
declare v_row public.ledger%rowtype;
begin
 select * into v_row from public.ledger where request_id=p_request_id for update;
 if not found or v_row.state<>'reserved' then return; end if;
 perform public.settle_budget(p_request_id,p_state,p_actual_micros,p_input_tokens,p_output_tokens,p_reasoning_tokens,p_cached_tokens,p_error_code);
 update public.ledger set actual_usd_micros=case when p_state='settled' then greatest(p_actual_micros,0) when p_state='released' then 0 else null end,
   cache_write_tokens=p_cache_write_tokens, reasoning_reported=p_reasoning_reported,
   metadata=metadata||p_metadata where request_id=p_request_id;
 -- actual_micros retains its legacy meaning: budget CHARGE, not provider cost for uncertain rows.
end $$;
revoke all on function public.reserve_budget_v2(uuid,text,text,text,bigint,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.reserve_budget_v2(uuid,text,text,text,bigint,jsonb,jsonb) to service_role;
revoke all on function public.settle_budget_v2(text,text,bigint,integer,integer,integer,integer,text,integer,boolean,jsonb) from public,anon,authenticated;
grant execute on function public.settle_budget_v2(text,text,bigint,integer,integer,integer,integer,text,integer,boolean,jsonb) to service_role;

-- Signup from verified accounts, independent of client retries. Records IDs only.
create or replace function public.record_verified_signup() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if new.email_confirmed_at is not null and lower(split_part(new.email,'@',2))='uwo.ca' then
   insert into public.analytics_events(user_id,event,dedupe_key) values(new.id,'signup','signup:'||new.id) on conflict(dedupe_key) do nothing;
 end if;
 return new;
end $$;
revoke all on function public.record_verified_signup() from public,anon,authenticated;
create trigger orbit_verified_signup after insert or update of email_confirmed_at on auth.users
 for each row execute function public.record_verified_signup();
