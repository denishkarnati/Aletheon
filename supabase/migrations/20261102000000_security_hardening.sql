-- Security hardening for Aletheon Cloud (applies on top of 20261026000000_aletheon_cloud.sql).
--
-- 1. Invites trust only a CONFIRMED email address. Before, anyone who signed up with an invited address (while email confirmation
--    was off) could read the invite and join the team.
-- 2. Helper and trigger functions are no longer callable by anonymous clients through the API.
-- 3. Abuse limits: teams per user, pending invites per team, evidence rows per project (a plan column).
-- 4. The seat-limit check locks the team row, so two simultaneous invites cannot both take the last seat.

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Confirmed email
-- ---------------------------------------------------------------------------------------------------------------------
create function public.my_confirmed_email() returns text
language sql stable security definer set search_path = public as $$
  select lower(u.email) from auth.users u where u.id = auth.uid() and u.email_confirmed_at is not null
$$;
revoke execute on function public.my_confirmed_email() from public, anon;
grant execute on function public.my_confirmed_email() to authenticated;

drop policy invites_read on public.team_invites;
create policy invites_read on public.team_invites for select to authenticated
  using (public.is_team_admin(team_id) or email = public.my_confirmed_email());

create or replace function public.accept_invite(invite_token uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  inv team_invites;
  mine text := public.my_confirmed_email();
begin
  if auth.uid() is null then
    raise exception 'sign in required' using errcode = '42501';
  end if;
  select * into inv from team_invites where token = invite_token for update;
  if inv.id is null or inv.accepted_at is not null or inv.expires_at < now() then
    raise exception 'invite is invalid, used or expired' using errcode = 'P0001';
  end if;
  if mine is null then
    raise exception 'confirm your email address before accepting an invite' using errcode = '42501';
  end if;
  if inv.email <> mine then
    raise exception 'this invite is for a different email address' using errcode = '42501';
  end if;
  insert into team_members (team_id, user_id, role) values (inv.team_id, auth.uid(), 'member') on conflict do nothing;
  update team_invites set accepted_at = now() where id = inv.id;
  return inv.team_id;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Least privilege on functions (default privileges grant EXECUTE to anon, authenticated and public)
-- ---------------------------------------------------------------------------------------------------------------------
revoke execute on function public.team_role(uuid), public.is_team_member(uuid), public.is_team_admin(uuid),
  public.can_access_project(uuid), public.shares_team_with(uuid), public.billable_tokens(int, int, int, int) from public, anon;
-- Trigger functions run when their trigger fires; nobody needs to call them directly.
revoke execute on function public.handle_new_user(), public.enforce_seat_limit(), public.enforce_project_limit() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Abuse limits
-- ---------------------------------------------------------------------------------------------------------------------
alter table public.plans add column max_evidence_per_project int not null default 50000 check (max_evidence_per_project >= 0);

create or replace function public.create_team(team_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  t uuid;
begin
  if auth.uid() is null then
    raise exception 'sign in required' using errcode = '42501';
  end if;
  if (select count(*) from teams where created_by = auth.uid()) >= 10 then
    raise exception 'team limit reached: you can create at most 10 teams' using errcode = 'P0001';
  end if;
  insert into teams (name, created_by) values (btrim(team_name), auth.uid()) returning id into t;
  insert into subscriptions (team_id, plan_id, status) values (t, 'team', 'pending');
  insert into team_members (team_id, user_id, role) values (t, auth.uid(), 'owner');
  return t;
end $$;

create function public.enforce_invite_limit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  pending int;
begin
  select count(*) into pending from team_invites where team_id = new.team_id and accepted_at is null and expires_at > now();
  if pending >= 50 then
    raise exception 'invite limit reached: at most 50 pending invites per team' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke execute on function public.enforce_invite_limit() from public, anon, authenticated;
create trigger invite_limit before insert on public.team_invites for each row execute function public.enforce_invite_limit();

create function public.enforce_evidence_limit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  cap int;
  used int;
begin
  select p.max_evidence_per_project into cap
  from projects pr
  join subscriptions s on (pr.team_id is not null and s.team_id = pr.team_id) or (pr.team_id is null and s.user_id = pr.user_id)
  join plans p on p.id = s.plan_id
  where pr.id = new.project_id;
  select count(*) into used from evidence where project_id = new.project_id;
  if used >= coalesce(cap, 0) then
    raise exception 'evidence limit reached: % of % rows for this project', used, coalesce(cap, 0) using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke execute on function public.enforce_evidence_limit() from public, anon, authenticated;
create trigger evidence_limit before insert on public.evidence for each row execute function public.enforce_evidence_limit();

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Seat limit without a race
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function public.enforce_seat_limit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  seats int;
  used int;
begin
  perform 1 from teams where id = new.team_id for update; -- serialises concurrent joins to the same team
  select p.max_members into seats from subscriptions s join plans p on p.id = s.plan_id where s.team_id = new.team_id;
  select count(*) into used from team_members where team_id = new.team_id;
  if used >= coalesce(seats, 1) then
    raise exception 'team is full: % of % seats used', used, coalesce(seats, 1) using errcode = 'P0001';
  end if;
  return new;
end $$;
