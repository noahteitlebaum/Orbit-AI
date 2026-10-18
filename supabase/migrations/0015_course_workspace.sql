-- Shared student courses preserve existing IDs, files and chat relationships.
alter table public.projects alter column provider drop not null;
update public.projects set provider=null;
alter table public.projects add column if not exists course_data jsonb;
alter table public.projects add column if not exists syllabus_id uuid references public.files(id) on delete set null;
drop policy if exists "own conversations" on public.conversations;
create policy "own conversations" on public.conversations for all to authenticated using(user_id=auth.uid())
with check(user_id=auth.uid() and (project_id is null or exists(select 1 from public.projects p where p.id=project_id and p.user_id=auth.uid())));
create table if not exists public.syllabus_drafts(
 file_id uuid primary key references public.files(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 draft jsonb not null,
 course_id uuid references public.projects(id) on delete cascade,
 created_at timestamptz not null default now()
);
alter table public.syllabus_drafts enable row level security;
drop policy if exists "own syllabus drafts" on public.syllabus_drafts;
create policy "own syllabus drafts" on public.syllabus_drafts for all to authenticated using(user_id=auth.uid())
with check(user_id=auth.uid() and exists(select 1 from public.files f where f.id=file_id and f.user_id=auth.uid())
 and (course_id is null or exists(select 1 from public.projects p where p.id=course_id and p.user_id=auth.uid())));
grant select,insert,update,delete on public.syllabus_drafts to authenticated;
alter table public.syllabus_drafts add column if not exists target_id uuid references public.projects(id) on delete cascade;
alter table public.syllabus_drafts add column if not exists base_version timestamptz;
create table if not exists public.syllabus_leases(file_id uuid primary key references public.files(id) on delete cascade,request_id uuid not null,expires_at timestamptz not null);
alter table public.syllabus_leases enable row level security;
create or replace function public.claim_syllabus(p_file uuid,p_user uuid,p_request uuid) returns boolean language plpgsql security definer set search_path=public as $$
begin
 if not exists(select 1 from public.files where id=p_file and user_id=p_user) then return false; end if;
 insert into public.syllabus_leases values(p_file,p_request,now()+interval '3 minutes') on conflict(file_id) do update set request_id=excluded.request_id,expires_at=excluded.expires_at where public.syllabus_leases.expires_at<now();
 return found;
end $$;
create or replace function public.release_syllabus(p_file uuid,p_request uuid) returns void language sql security definer set search_path=public as $$ delete from public.syllabus_leases where file_id=p_file and request_id=p_request $$;
revoke all on function public.claim_syllabus(uuid,uuid,uuid),public.release_syllabus(uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_syllabus(uuid,uuid,uuid),public.release_syllabus(uuid,uuid) to service_role;

create or replace function public.confirm_syllabus(p_file uuid,p_draft jsonb) returns uuid
language plpgsql security invoker set search_path=public as $$
declare d public.syllabus_drafts; cid uuid; f public.files; p public.projects;
begin
 select * into d from public.syllabus_drafts where file_id=p_file and user_id=auth.uid() for update;
 if not found then raise exception 'draft_not_found'; end if;
 if d.course_id is not null then return d.course_id; end if;
 select * into f from public.files where id=p_file and user_id=auth.uid() for update;
 if not found or f.project_id is not null or f.conversation_id is not null then raise exception 'file_already_attached'; end if;
 if jsonb_typeof(p_draft)<>'object' or length(p_draft->>'name') not between 1 and 80 or jsonb_typeof(p_draft->'items')<>'array' then raise exception 'invalid_draft'; end if;
 if d.target_id is not null then
  select * into p from public.projects where id=d.target_id and user_id=auth.uid() for update;
  if not found or p.updated_at is distinct from d.base_version then raise exception 'course_changed'; end if;
  cid=p.id;
  update public.projects set name=p_draft->>'name',course_data=p_draft,syllabus_id=p_file,updated_at=clock_timestamp() where id=cid;
 else
  insert into public.projects(user_id,provider,name,instructions,course_data,syllabus_id)
  values(auth.uid(),null,p_draft->>'name','',p_draft,p_file) returning id into cid;
 end if;
 update public.files set project_id=cid where id=p_file and user_id=auth.uid();
 update public.syllabus_drafts set course_id=cid where file_id=p_file and user_id=auth.uid();
 return cid;
end $$;
revoke all on function public.confirm_syllabus(uuid,jsonb) from public;
grant execute on function public.confirm_syllabus(uuid,jsonb) to authenticated;
-- Enforce the ownership of a referenced syllabus, including direct authenticated database writes.
create or replace function public.check_course_syllabus_owner() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.syllabus_id is not null and not exists(select 1 from public.files where id=new.syllabus_id and user_id=new.user_id) then raise exception 'syllabus_owner_mismatch'; end if;
 return new;
end $$;
drop trigger if exists course_syllabus_owner on public.projects;
create trigger course_syllabus_owner before insert or update of syllabus_id,user_id on public.projects for each row execute function public.check_course_syllabus_owner();
