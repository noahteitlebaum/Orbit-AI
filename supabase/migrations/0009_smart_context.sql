begin;

-- Separate auxiliary model expenses from answers. No text or embedding vectors in analytics.
alter table public.ledger drop constraint if exists ledger_kind_check;
alter table public.ledger add constraint ledger_kind_check check (kind in ('text', 'image', 'summary', 'embedding'));

alter table public.ledger add column if not exists cache_write_tokens integer;
drop function if exists public.settle_budget(text, text, bigint, integer, integer, integer, integer, text);
create or replace function public.settle_budget(
  p_request_id text, p_state text, p_actual_micros bigint,
  p_input_tokens integer default null, p_output_tokens integer default null,
  p_reasoning_tokens integer default null, p_cached_tokens integer default null,
  p_error_code text default null, p_cache_write_tokens integer default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_row public.ledger%rowtype;
  v_charge bigint;
begin
  if p_state not in ('settled', 'uncertain', 'released') then
    raise exception 'bad state %', p_state;
  end if;

  select * into v_row from public.ledger where request_id = p_request_id for update;
  if not found or v_row.state <> 'reserved' then
    return; -- already reconciled (retry-safe)
  end if;

  v_charge := case p_state
    when 'settled' then greatest(coalesce(p_actual_micros, v_row.reserved_micros), 0)
    when 'uncertain' then v_row.reserved_micros
    else 0 end;

  update public.budgets
     set reserved_micros = greatest(reserved_micros - v_row.reserved_micros, 0),
         spent_micros = spent_micros + v_charge
   where user_id = v_row.user_id;

  update public.ledger
     set state = p_state, actual_micros = v_charge,
         input_tokens = p_input_tokens, output_tokens = p_output_tokens,
         reasoning_tokens = p_reasoning_tokens, cached_tokens = p_cached_tokens, cache_write_tokens = p_cache_write_tokens,
         error_code = p_error_code, settled_at = now()
   where id = v_row.id;
end $$;


revoke all on function public.settle_budget(text, text, bigint, integer, integer, integer, integer, text, integer) from public, anon, authenticated;
grant execute on function public.settle_budget(text, text, bigint, integer, integer, integer, integer, text, integer) to service_role;

commit;
