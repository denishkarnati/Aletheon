-- Aletheon Cloud: accounts, plans, teams (shared projects), shared evidence ledgers and AI usage metering.
--
-- Security model: every table has row-level security (RLS). Signed-in users (role `authenticated`) reach only their own rows
-- and rows of teams they belong to. Plans are public. Subscriptions and usage are written only by the server (service role:
-- the AI gateway and the operator), never by clients. Payments are not wired yet: subscriptions carry nullable Stripe columns
-- and an operator assigns plans with admin_set_plan() until billing launches.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------------------------------------------------
-- Plans. Limits below are PLACEHOLDERS to be set before launch; prices stay null until billing exists.
-- billable tokens = input + cache_write + output + ceil(cache_read / 10)   (see public.billable_tokens)
-- ---------------------------------------------------------------------------------------------------------------------
create table public.plans (
  id text primary key check (id in ('free', 'plus', 'pro', 'max', 'team')),
  name text not null,
  monthly_token_limit bigint not null check (monthly_token_limit >= 0),
  max_members int not null default 1 check (max_members >= 1),
  max_projects int not null check (max_projects >= 0),
  models text[] not null,
  price_cents int check (price_cents is null or price_cents >= 0),
  stripe_price_id text,
  sort int not null
);

insert into public.plans (id, name, monthly_token_limit, max_members, max_projects, models, sort) values
  ('free', 'Free', 200000, 1, 1, array['claude-haiku-5-5', 'claude-sonnet-5-5'], 0),
  ('plus', 'Plus', 2000000, 1, 5, array['claude-haiku-5-5', 'claude-sonnet-5-5'], 1),
  ('pro', 'Pro', 10000000, 1, 25, array['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'], 2),
  ('max', 'Max', 40000000, 1, 100, array['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'], 3),
  ('team', 'Team (5 members)', 50000000, 5, 100, array['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'], 4);

-- ---------------------------------------------------------------------------------------------------------------------
-- People and teams
-- ---------------------------------------------------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text check (display_name is null or length(display_name) <= 80),
  created_at timestamptz not null default now()
);

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 80),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now()
);

create table public.team_members (
  team_id uuid not null references public.teams (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member')),
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
create index team_members_user on public.team_members (user_id);

create table public.team_invites (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  email text not null check (email = lower(email) and position('@' in email) > 1),
  token uuid not null unique default gen_random_uuid(),
  invited_by uuid not null default auth.uid() references auth.users (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz
);
create index team_invites_email on public.team_invites (email);

-- One subscription per user (personal plan) or per team (team plan).
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users (id) on delete cascade,
  team_id uuid unique references public.teams (id) on delete cascade,
  plan_id text not null references public.plans (id),
  status text not null default 'active' check (status in ('active', 'trialing', 'pending', 'past_due', 'canceled')),
  period_start timestamptz not null default date_trunc('month', now()),
  period_end timestamptz,
  stripe_customer_id text,
  stripe_subscription_id text unique,
  updated_at timestamptz not null default now(),
  check ((user_id is null) <> (team_id is null))
);

-- ---------------------------------------------------------------------------------------------------------------------
-- Projects and their shared, append-only evidence ledgers
-- ---------------------------------------------------------------------------------------------------------------------
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 120),
  user_id uuid references auth.users (id) on delete cascade,
  team_id uuid references public.teams (id) on delete cascade,
  created_by uuid not null default auth.uid() references auth.users (id),
  created_at timestamptz not null default now(),
  check ((user_id is null) <> (team_id is null))
);

create table public.evidence (
  project_id uuid not null references public.projects (id) on delete cascade,
  eid text not null check (eid ~ '^E[0-9]+$'),
  kind text not null check (kind in ('datasheet', 'serial', 'build', 'flash', 'web', 'rea', 'svd', 'file', 'user')),
  source text not null check (length(source) <= 2000),
  excerpt text not null check (length(excerpt) <= 4000),
  trust text not null check (trust in ('measured', 'vendor-official', 'derived', 'user-supplied', 'community-mirror', 'unknown')),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  ts timestamptz not null,
  created_by uuid not null default auth.uid() references auth.users (id),
  uploaded_at timestamptz not null default now(),
  primary key (project_id, created_by, eid)
);

-- ---------------------------------------------------------------------------------------------------------------------
-- Usage metering (written by the AI gateway with the service role)
-- ---------------------------------------------------------------------------------------------------------------------
create table public.usage_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  team_id uuid references public.teams (id) on delete set null,
  project_id uuid references public.projects (id) on delete set null,
  model text not null,
  input_tokens int not null default 0 check (input_tokens >= 0),
  output_tokens int not null default 0 check (output_tokens >= 0),
  cache_read_tokens int not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens int not null default 0 check (cache_write_tokens >= 0),
  billable_tokens bigint not null check (billable_tokens >= 0),
  created_at timestamptz not null default now()
);
create index usage_user_time on public.usage_events (user_id, created_at) where team_id is null;
create index usage_team_time on public.usage_events (team_id, created_at) where team_id is not null;

-- ---------------------------------------------------------------------------------------------------------------------
-- Helpers (security definer: they read membership without being subject to the RLS they implement)
-- ---------------------------------------------------------------------------------------------------------------------
create function public.billable_tokens(input int, output int, cache_read int, cache_write int) returns bigint
language sql immutable as $$ select input::bigint + cache_write + output + ceil(cache_read / 10.0)::bigint $$;

create function public.team_role(t uuid) returns text
language sql stable security definer set search_path = public as $$
  select role from team_members where team_id = t and user_id = auth.uid()
$$;

create function public.is_team_member(t uuid) returns boolean
language sql stable security definer set search_path = public as $$ select public.team_role(t) is not null $$;

create function public.is_team_admin(t uuid) returns boolean
language sql stable security definer set search_path = public as $$ select public.team_role(t) in ('owner', 'admin') $$;

create function public.can_access_project(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from projects pr
    where pr.id = p and (pr.user_id = auth.uid() or (pr.team_id is not null and public.is_team_member(pr.team_id)))
  )
$$;

create function public.shares_team_with(other uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from team_members a join team_members b on a.team_id = b.team_id
    where a.user_id = auth.uid() and b.user_id = other
  )
$$;

-- New account: profile + a free personal subscription.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email) values (new.id, lower(new.email));
  insert into subscriptions (user_id, plan_id, status) values (new.id, 'free', 'active');
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- Seat limit: a team never has more members than its plan allows (5 on the Team plan).
create function public.enforce_seat_limit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  seats int;
  used int;
begin
  select p.max_members into seats from subscriptions s join plans p on p.id = s.plan_id where s.team_id = new.team_id;
  select count(*) into used from team_members where team_id = new.team_id;
  if used >= coalesce(seats, 1) then
    raise exception 'team is full: % of % seats used', used, coalesce(seats, 1) using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger team_seat_limit before insert on public.team_members for each row execute function public.enforce_seat_limit();

-- Project limit per plan (personal plan for personal projects, team plan for team projects).
create function public.enforce_project_limit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  cap int;
  used int;
begin
  if new.team_id is not null then
    select p.max_projects into cap from subscriptions s join plans p on p.id = s.plan_id where s.team_id = new.team_id;
    select count(*) into used from projects where team_id = new.team_id;
  else
    select p.max_projects into cap from subscriptions s join plans p on p.id = s.plan_id where s.user_id = new.user_id;
    select count(*) into used from projects where user_id = new.user_id;
  end if;
  if used >= coalesce(cap, 0) then
    raise exception 'project limit reached: % of % projects', used, coalesce(cap, 0) using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger project_limit before insert on public.projects for each row execute function public.enforce_project_limit();

-- ---------------------------------------------------------------------------------------------------------------------
-- Entitlements: which plan pays for a request and how much of it is left this period
-- ---------------------------------------------------------------------------------------------------------------------
-- Server-side only (the gateway calls it with the service role). Team usage is pooled across members.
create function public.entitlement_for(uid uuid, team uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  s subscriptions;
  p plans;
  used bigint;
begin
  if team is not null then
    if not exists (select 1 from team_members where team_id = team and user_id = uid) then
      return jsonb_build_object('error', 'not_a_member');
    end if;
    select * into s from subscriptions where team_id = team;
  else
    select * into s from subscriptions where user_id = uid;
  end if;
  if s.id is null then
    return jsonb_build_object('error', 'no_subscription');
  end if;
  select * into p from plans where id = s.plan_id;
  if team is not null then
    select coalesce(sum(billable_tokens), 0) into used from usage_events where team_id = team and created_at >= s.period_start;
  else
    select coalesce(sum(billable_tokens), 0) into used from usage_events where user_id = uid and team_id is null and created_at >= s.period_start;
  end if;
  return jsonb_build_object(
    'plan', p.id, 'plan_name', p.name, 'status', s.status, 'team_id', team,
    'limit', p.monthly_token_limit, 'used', used, 'remaining', greatest(p.monthly_token_limit - used, 0),
    'models', to_jsonb(p.models), 'period_start', s.period_start,
    'resets_at', coalesce(s.period_end, date_trunc('month', s.period_start) + interval '1 month'),
    'usable', s.status in ('active', 'trialing') and used < p.monthly_token_limit
  );
end $$;
revoke execute on function public.entitlement_for(uuid, uuid) from public, anon, authenticated;

-- What a signed-in user sees for themselves (or for a team they belong to).
create function public.my_entitlement(team uuid default null) returns jsonb
language sql stable security definer set search_path = public as $$ select public.entitlement_for(auth.uid(), team) $$;
revoke execute on function public.my_entitlement(uuid) from public, anon;
grant execute on function public.my_entitlement(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------
-- Team operations (RPCs; direct inserts into teams/team_members are not allowed)
-- ---------------------------------------------------------------------------------------------------------------------
-- A new team starts 'pending': members and shared projects work, cloud AI usage waits for an active plan.
create function public.create_team(team_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  t uuid;
begin
  if auth.uid() is null then
    raise exception 'sign in required' using errcode = '42501';
  end if;
  insert into teams (name, created_by) values (team_name, auth.uid()) returning id into t;
  insert into subscriptions (team_id, plan_id, status) values (t, 'team', 'pending');
  insert into team_members (team_id, user_id, role) values (t, auth.uid(), 'owner');
  return t;
end $$;
revoke execute on function public.create_team(text) from public, anon;
grant execute on function public.create_team(text) to authenticated;

-- Accepting requires signing in with the invited email address.
create function public.accept_invite(invite_token uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  inv team_invites;
begin
  select * into inv from team_invites where token = invite_token for update;
  if inv.id is null or inv.accepted_at is not null or inv.expires_at < now() then
    raise exception 'invite is invalid, used or expired' using errcode = 'P0001';
  end if;
  if inv.email <> lower(coalesce(auth.jwt() ->> 'email', '')) then
    raise exception 'this invite is for a different email address' using errcode = '42501';
  end if;
  insert into team_members (team_id, user_id, role) values (inv.team_id, auth.uid(), 'member') on conflict do nothing;
  update team_invites set accepted_at = now() where id = inv.id;
  return inv.team_id;
end $$;
revoke execute on function public.accept_invite(uuid) from public, anon;
grant execute on function public.accept_invite(uuid) to authenticated;

-- Operator-only until billing launches: assign a plan to a user or a team.
create function public.admin_set_plan(target_user uuid, target_team uuid, plan text, new_status text default 'active') returns void
language plpgsql security definer set search_path = public as $$
begin
  if (target_user is null) = (target_team is null) then
    raise exception 'pass exactly one of target_user, target_team';
  end if;
  if target_team is not null and plan <> 'team' then
    raise exception 'teams use the team plan';
  end if;
  if target_user is not null and plan = 'team' then
    raise exception 'the team plan belongs to a team';
  end if;
  update subscriptions set plan_id = plan, status = new_status, period_start = date_trunc('month', now()), updated_at = now()
  where (target_user is not null and user_id = target_user) or (target_team is not null and team_id = target_team);
end $$;
revoke execute on function public.admin_set_plan(uuid, uuid, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------------------------------------------------
alter table public.plans enable row level security;
alter table public.profiles enable row level security;
alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.team_invites enable row level security;
alter table public.subscriptions enable row level security;
alter table public.projects enable row level security;
alter table public.evidence enable row level security;
alter table public.usage_events enable row level security;

create policy plans_public_read on public.plans for select to anon, authenticated using (true);

create policy profiles_read on public.profiles for select to authenticated using (id = auth.uid() or public.shares_team_with(id));
create policy profiles_update_self on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy teams_read on public.teams for select to authenticated using (public.is_team_member(id));
create policy teams_rename on public.teams for update to authenticated using (public.is_team_admin(id)) with check (public.is_team_admin(id));
create policy teams_delete on public.teams for delete to authenticated using (public.team_role(id) = 'owner');

create policy members_read on public.team_members for select to authenticated using (public.is_team_member(team_id));
-- Admins remove members (never the owner); anyone but the owner may leave.
create policy members_remove on public.team_members for delete to authenticated
  using (role <> 'owner' and (user_id = auth.uid() or public.is_team_admin(team_id)));
create policy members_role on public.team_members for update to authenticated
  using (public.team_role(team_id) = 'owner' and role <> 'owner') with check (role in ('admin', 'member'));

create policy invites_read on public.team_invites for select to authenticated
  using (public.is_team_admin(team_id) or email = lower(coalesce(auth.jwt() ->> 'email', '')));
create policy invites_create on public.team_invites for insert to authenticated
  with check (public.is_team_admin(team_id) and invited_by = auth.uid());
create policy invites_revoke on public.team_invites for delete to authenticated using (public.is_team_admin(team_id));

create policy subscriptions_read on public.subscriptions for select to authenticated
  using (user_id = auth.uid() or (team_id is not null and public.is_team_member(team_id)));

-- Judge the row by its own columns: re-querying projects (can_access_project) cannot see a row being inserted in the same
-- statement, which made `insert ... returning` (supabase-js insert().select()) fail.
create policy projects_read on public.projects for select to authenticated
  using (user_id = auth.uid() or (team_id is not null and public.is_team_member(team_id)));
create policy projects_create on public.projects for insert to authenticated
  with check (created_by = auth.uid() and ((user_id = auth.uid() and team_id is null) or (user_id is null and public.is_team_member(team_id))));
create policy projects_rename on public.projects for update to authenticated
  using (user_id = auth.uid() or (team_id is not null and public.is_team_member(team_id))) with check ((user_id = auth.uid() and team_id is null) or (user_id is null and public.is_team_member(team_id)));
create policy projects_delete on public.projects for delete to authenticated
  using (created_by = auth.uid() or (team_id is not null and public.is_team_admin(team_id)));

-- Evidence is append-only, like the local ledger: no update or delete policies exist.
create policy evidence_read on public.evidence for select to authenticated using (public.can_access_project(project_id));
create policy evidence_add on public.evidence for insert to authenticated
  with check (created_by = auth.uid() and public.can_access_project(project_id));

-- Your own usage (personal and team requests you made); team admins also see every member's team usage.
create policy usage_read on public.usage_events for select to authenticated
  using (user_id = auth.uid() or (team_id is not null and public.is_team_admin(team_id)));

-- Column-level write limits on top of the policies.
revoke update on public.profiles from authenticated;
grant update (display_name) on public.profiles to authenticated;
revoke update on public.team_members from authenticated;
grant update (role) on public.team_members to authenticated;
revoke update on public.teams from authenticated;
grant update (name) on public.teams to authenticated;
revoke update on public.projects from authenticated;
grant update (name) on public.projects to authenticated;
revoke insert, update, delete on public.subscriptions, public.usage_events, public.plans from anon, authenticated;
revoke insert on public.teams, public.team_members from anon, authenticated;
