-- AI saves must honor the current preference, even if an answer began before memory was disabled.
-- Share-lock the profile row so preference updates and AI inserts have a defined transactional order.
begin;
create or replace function public.guard_ai_memory_consent() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_enabled boolean;
begin
  if new.source = 'ai' then
    select memory_enabled into v_enabled from public.profiles where user_id = new.user_id for share;
    if not coalesce(v_enabled, false) then return null; end if;
    if new.conversation_id is not null and not exists (
      select 1 from public.conversations where id = new.conversation_id and user_id = new.user_id
    ) then
      raise exception 'invalid memory conversation' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.guard_ai_memory_consent() from public, anon, authenticated;
drop trigger if exists orbit_ai_memory_consent on public.memories;
create trigger orbit_ai_memory_consent before insert or update on public.memories
for each row execute function public.guard_ai_memory_consent();
commit;
