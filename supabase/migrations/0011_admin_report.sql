-- A bounded, server-only aggregate report. No private message content leaves Postgres.
create or replace function public.orbit_analytics_report(p_days integer default 30) returns jsonb
language sql stable security definer set search_path=public as $$
 with scope as(select now()-make_interval(days=>least(greatest(p_days,1),90)) as since),
 calls as(select l.* from public.ledger l,scope s where l.created_at>=s.since),
 events as(select e.* from public.analytics_events e,scope s where e.created_at>=s.since),
 receipts as(select r.* from public.revenue_events r,scope s where r.occurred_at>=s.since),
 spend as(select user_id,sum(actual_usd_micros) filter(where state='settled') as cost,
   sum(actual_usd_micros*usd_cad_rate) filter(where state='settled') as cost_cad from calls group by user_id),
 financial as(select
   coalesce((select sum(net_cad_micros) from receipts),0) as revenue_cad_micros,
   coalesce((select sum(payment_fee_cad_micros) from receipts),0) as fees_cad_micros,
   coalesce(sum(actual_usd_micros) filter(where state='settled'),0) as api_usd_micros,
   coalesce(sum(actual_usd_micros*usd_cad_rate) filter(where state='settled'),0) as api_cad_micros,
   count(*) filter(where state='settled' and usd_cad_rate is null) as costs_without_fx,
   count(*) filter(where operation='legacy') as legacy_cost_rows,
   count(*) filter(where state='uncertain') as uncertain_calls,
   coalesce(sum(actual_micros) filter(where state='uncertain'),0) as uncertain_charges_usd_micros,
   coalesce(sum(reserved_micros) filter(where state='reserved'),0) as reserved_usd_micros,
   (select percentile_cont(0.5) within group(order by cost) from spend) as user_spend_p50_usd_micros,
   (select percentile_cont(0.95) within group(order by cost) from spend) as user_spend_p95_usd_micros,
   (select avg(cost) from spend) as mean_user_cost_usd_micros
 from calls),
 product as(select
   count(distinct user_id) filter(where event='message_sent' and created_at>=now()-interval '1 day') as dau,
   count(distinct user_id) filter(where event='message_sent' and created_at>=now()-interval '7 days') as wau,
   count(distinct user_id) filter(where event='message_sent' and created_at>=now()-interval '30 days') as mau,
   count(*) filter(where event='message_sent' and created_at>=(select since from scope)) as messages,
   count(*) filter(where event='conversation_created' and created_at>=(select since from scope)) as conversations_started,
   count(*) filter(where event='model_switched' and created_at>=(select since from scope)) as model_switches,
   count(*) filter(where event='allowance_exhausted' and created_at>=(select since from scope)) as allowance_exhaustions,
   count(*) filter(where event='file_uploaded' and created_at>=(select since from scope)) as file_uploads,
   count(*) filter(where event='message_sent' and created_at>=(select since from scope))::numeric/nullif(count(distinct user_id) filter(where event='message_sent' and created_at>=(select since from scope)),0) as messages_per_active_user,
   count(*) filter(where event='message_sent' and created_at>=(select since from scope))::numeric/nullif(count(distinct conversation_id) filter(where event='message_sent' and created_at>=(select since from scope)),0) as messages_per_active_conversation
 from public.analytics_events where created_at>=least((select since from scope),now()-interval '30 days') and coalesce((properties->>'live')::boolean,true)),
 context as(select
   count(*) filter(where operation='chat') as chat_calls,
   avg(input_tokens) filter(where operation='chat' and state='settled') as mean_input_tokens,
   sum(cached_tokens)::numeric/nullif(sum(input_tokens),0) as cache_read_ratio,
   sum(actual_usd_micros) filter(where operation='chat' and state='settled')*100.0/nullif(count(*) filter(where operation='chat' and state='settled'),0) as usd_micros_per_100_calls,
   coalesce(sum(actual_usd_micros) filter(where operation='summary' and state='settled'),0) as summary_usd_micros,
   coalesce(sum(actual_usd_micros) filter(where operation='embedding' and state='settled'),0) as embedding_usd_micros,
   sum(actual_usd_micros) filter(where operation in ('summary','embedding'))::numeric/nullif(sum(actual_usd_micros),0) as memory_cost_ratio,
   avg((metadata->>'latencyMs')::numeric) filter(where operation='chat') as mean_latency_ms,
   count(*) filter(where error_code is not null) as errors,
   count(*) filter(where operation='chat' and (metadata->>'historyDropped')::boolean) as trimmed_calls,
   count(*) filter(where operation='chat' and (metadata->>'retrievedCount')::integer>0) as retrieval_used_calls
 from calls),
 cohort_users as(select e.*,
   exists(select 1 from public.revenue_events r where r.user_id=e.user_id and r.kind='payment' and r.net_cad_micros>0) as converted,
   exists(select 1 from public.analytics_events a where a.user_id=e.user_id and a.event='message_sent'
     and a.created_at>=e.trial_started_at+interval '7 days' and a.created_at<e.trial_started_at+interval '14 days'
     and coalesce((a.properties->>'live')::boolean,true)) as retained_week2,
   coalesce((select sum(l.actual_usd_micros) from public.ledger l where l.user_id=e.user_id and l.created_at>=e.trial_started_at and l.created_at<e.trial_ends_at and l.state='settled'),0) as trial_cost,
   (select sum(l.actual_usd_micros*l.usd_cad_rate) from public.ledger l where l.user_id=e.user_id and l.created_at>=e.trial_started_at and l.created_at<e.trial_ends_at and l.state='settled') as trial_cost_cad
 from public.enrollments e),
 cohorts as(select cohort,trial_days,price_cad_micros,count(*) as enrolled,
   count(*) filter(where trial_ends_at<=now()) as matured_trials,
   count(*) filter(where converted and trial_ends_at<=now()) as conversions,
   count(*) filter(where converted and trial_ends_at<=now())::numeric/nullif(count(*) filter(where trial_ends_at<=now()),0) as trial_conversion_rate,
   count(*) filter(where retained_week2 and trial_started_at<=now()-interval '14 days')::numeric/nullif(count(*) filter(where trial_started_at<=now()-interval '14 days'),0) as week2_retention,
   sum(trial_cost) as trial_cost_usd_micros,sum(trial_cost_cad) as trial_cost_cad_micros,
   sum(trial_cost)/nullif(count(*) filter(where converted),0) as trial_cost_per_conversion_usd_micros
 from cohort_users group by cohort,trial_days,price_cad_micros),
 model_spend as(select provider,model_id,operation,count(*) as calls,
   coalesce(sum(actual_usd_micros),0) as cost_usd_micros,count(*) filter(where state='uncertain') as unknown_cost_calls
 from calls group by provider,model_id,operation),
 features as(select properties->>'feature' as feature,count(distinct user_id) as users,count(*) as uses
 from events where event='feature_used' and (properties->>'live')::boolean group by properties->>'feature'),
 users as(select b.user_id,b.allowance_micros,b.spent_micros,b.reserved_micros,b.allowance_cad_micros,b.usd_cad_rate,
   b.spent_micros::numeric/nullif(b.allowance_micros,0) as allowance_utilization,s.cost as api_usd_micros
 from public.budgets b left join spend s on s.user_id=b.user_id order by coalesce(s.cost,0) desc limit 200)
 select jsonb_build_object('days',least(greatest(p_days,1),90),
   'financial',(select to_jsonb(f) from financial f), 'product',(select to_jsonb(p) from product p),
   'context',(select to_jsonb(c) from context c), 'cohorts',coalesce((select jsonb_agg(to_jsonb(c)) from cohorts c),'[]'),
   'models',coalesce((select jsonb_agg(to_jsonb(m)) from model_spend m),'[]'),
   'features',coalesce((select jsonb_agg(to_jsonb(f)) from features f),'[]'),
   'users',coalesce((select jsonb_agg(to_jsonb(u)) from users u),'[]'));
$$;
revoke all on function public.orbit_analytics_report(integer) from public,anon,authenticated;
grant execute on function public.orbit_analytics_report(integer) to service_role;
