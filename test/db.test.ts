// Database tests for Aletheon Cloud: applies supabase/migrations/*.sql to a real PostgreSQL (PGlite, in-process) on top of a
// minimal stand-in for Supabase's auth schema and roles, then acts as different users to prove the row-level security,
// seat limit, invites, project limits, append-only evidence and entitlement/usage accounting. Offline, no Docker.
// Run: npm run test:db
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

let failed = 0;
const check = (label: string, ok: boolean, extra = ''): void => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ' :: ' + extra}`);
};

// What Supabase provides before any migration runs: roles, auth.users, auth.uid()/auth.jwt() and default grants.
const SUPABASE_STUB = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz);
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
grant usage on schema public, auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

const db = new PGlite({ extensions: { pgcrypto } });

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const users = { a: uid(1), b: uid(2), c: uid(3), d: uid(4), e: uid(5), f: uid(6), g: uid(7) };
const emails: Record<string, string> = Object.fromEntries(Object.keys(users).map((k) => [k, `${k}@example.com`]));

// Run SQL as a role, with a JWT for that user (null = anonymous).
async function as<T = any>(who: keyof typeof users | 'anon' | 'service', sql: string, params: unknown[] = []): Promise<T[]> {
  const role = who === 'anon' ? 'anon' : who === 'service' ? 'service_role' : 'authenticated';
  const claims = who === 'anon' || who === 'service' ? { role } : { sub: users[who], email: emails[who], role };
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
  await db.exec(`set role ${role}`);
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec('reset role');
  }
}
async function fails(who: Parameters<typeof as>[0], sql: string, params: unknown[] = []): Promise<string> {
  try {
    await as(who, sql, params);
    return '';
  } catch (e) {
    return String((e as Error).message);
  }
}

async function main(): Promise<void> {
  await db.exec(SUPABASE_STUB);
  const dir = process.env.ALETHEON_MIGRATIONS ?? path.resolve(__dirname, '..', 'supabase', 'migrations');
  for (const f of fs
    .readdirSync(dir)
    .filter((x) => x.endsWith('.sql'))
    .sort())
    await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  check('migrations apply cleanly', true);

  // ---- sign-up
  for (const [k, id] of Object.entries(users))
    await db.query('insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())', [id, emails[k].toUpperCase()]);
  const subs = await db.query<any>(`select user_id, plan_id, status from subscriptions where user_id is not null`);
  check(
    'sign-up creates a free, active personal subscription',
    subs.rows.length === 7 && subs.rows.every((s) => s.plan_id === 'free' && s.status === 'active'),
  );
  const prof = await as('a', 'select id, email from profiles');
  check('profiles: you see only yourself (no shared team yet), email stored lower-case', prof.length === 1 && prof[0].email === 'a@example.com');
  check(
    'plans: readable without signing in',
    (await as('anon', 'select id from plans order by sort')).map((p: any) => p.id).join(',') === 'free,plus,pro,max,team',
  );
  const anonProfiles = await as('anon', 'select * from profiles');
  const anonProjects = await as('anon', 'select * from projects');
  check('anon: cannot read profiles or projects', anonProfiles.length === 0 && anonProjects.length === 0);

  // ---- users cannot change their own plan or usage
  check(
    'subscriptions: a user cannot upgrade themselves',
    (await fails('a', `update subscriptions set plan_id = 'max' where user_id = $1`, [users.a])).includes('permission denied'),
  );
  check(
    'subscriptions: a user cannot insert one',
    (await fails('a', `insert into subscriptions (user_id, plan_id) values ($1, 'max')`, [users.a])).includes('permission denied'),
  );
  check(
    'usage: a user cannot write usage rows',
    (await fails('a', `insert into usage_events (user_id, model, billable_tokens) values ($1, 'm', 0)`, [users.a])).includes('permission denied'),
  );
  check('admin_set_plan: not callable by users', (await fails('a', `select admin_set_plan($1, null, 'max')`, [users.a])).includes('permission denied'));
  check(
    'entitlement_for: not callable by users (cannot read others)',
    (await fails('a', `select entitlement_for($1)`, [users.b])).includes('permission denied'),
  );
  check(
    'profiles: email column is not user-writable',
    (await fails('a', `update profiles set email = 'x@y.z' where id = $1`, [users.a])).includes('permission denied'),
  );

  // ---- personal projects
  const [pa] = await as('a', `insert into projects (name, user_id) values ('pico-uart', $1) returning id`, [users.a]);
  check('projects: personal project created', !!pa?.id);
  check('projects: invisible to other users', (await as('b', 'select * from projects')).length === 0);
  check(
    'projects: free plan allows 1 project',
    (await fails('a', `insert into projects (name, user_id) values ('second', $1)`, [users.a])).includes('project limit reached'),
  );
  check(
    'projects: cannot create one owned by someone else',
    (await fails('a', `insert into projects (name, user_id) values ('evil', $1)`, [users.b])).includes('row-level security'),
  );

  // ---- teams
  const [{ create_team: team }] = await as('a', `select create_team('Firmware team')`);
  check('team: created with the caller as owner', (await as('a', 'select role from team_members where team_id = $1', [team]))[0]?.role === 'owner');
  check(
    'team: starts on the team plan, pending until a plan is active',
    (await as('a', 'select plan_id, status from subscriptions where team_id = $1', [team]))[0]?.status === 'pending',
  );
  check('team: not visible to outsiders', (await as('b', 'select * from teams')).length === 0);
  check(
    'team: direct insert into team_members is refused',
    (await fails('b', `insert into team_members (team_id, user_id, role) values ($1, $2, 'owner')`, [team, users.b])).includes('permission denied'),
  );
  const [tp] = await as('a', `insert into projects (name, team_id) values ('shared-board', $1) returning id`, [team]);
  check('team project created by a member', !!tp?.id);

  // ---- invites
  const [inv] = await as('a', `insert into team_invites (team_id, email) values ($1, 'b@example.com') returning token`, [team]);
  check('invite: admin can invite', !!inv?.token);
  check('invite: a different signed-in user cannot accept it', (await fails('c', 'select accept_invite($1)', [inv.token])).includes('different email'));
  check(
    'invite: only the invitee and admins can see it',
    (await as('c', 'select * from team_invites')).length === 0 && (await as('b', 'select * from team_invites')).length === 1,
  );
  await as('b', 'select accept_invite($1)', [inv.token]);
  check('invite: invitee joins as member', (await as('b', 'select role from team_members where user_id = $1', [users.b]))[0]?.role === 'member');
  check('invite: cannot be reused', (await fails('b', 'select accept_invite($1)', [inv.token])).includes('invalid, used or expired'));
  check(
    'shared project visible to the new member',
    (await as('b', 'select name from projects')).some((p: any) => p.name === 'shared-board'),
  );
  check(
    'teammates can see each other’s profiles',
    (await as('b', 'select email from profiles order by email')).map((p: any) => p.email).join(',') === 'a@example.com,b@example.com',
  );
  check(
    'member cannot invite (not admin)',
    (await fails('b', `insert into team_invites (team_id, email) values ($1, 'c@example.com')`, [team])).includes('row-level security'),
  );

  // ---- seat limit: 5 members on the team plan
  for (const k of ['c', 'd', 'e'] as const) {
    const [i] = await as('a', `insert into team_invites (team_id, email) values ($1, $2) returning token`, [team, emails[k]]);
    await as(k, 'select accept_invite($1)', [i.token]);
  }
  check('seats: team has 5 members', (await as('a', 'select count(*)::int as n from team_members where team_id = $1', [team]))[0].n === 5);
  const [i6] = await as('a', `insert into team_invites (team_id, email) values ($1, $2) returning token`, [team, emails.f]);
  check('seats: a 6th member is refused', (await fails('f', 'select accept_invite($1)', [i6.token])).includes('team is full'));
  check('seats: refused invite stays unaccepted', (await as('a', 'select accepted_at from team_invites where token = $1', [i6.token]))[0].accepted_at === null);

  // ---- leaving and removing
  check('owner cannot be removed by an admin path', (await as('b', 'delete from team_members where user_id = $1 returning *', [users.a])).length === 0);
  check('a member cannot remove another member', (await as('d', 'delete from team_members where user_id = $1 returning *', [users.c])).length === 0);
  check('a member cannot promote themselves', (await as('d', `update team_members set role = 'admin' where user_id = $1 returning *`, [users.d])).length === 0);
  check(
    'owner can promote a member to admin',
    (await as('a', `update team_members set role = 'admin' where user_id = $1 returning role`, [users.b]))[0]?.role === 'admin',
  );
  check('an admin cannot remove the owner', (await as('b', 'delete from team_members where user_id = $1 returning *', [users.a])).length === 0);
  check('an admin can remove a member', (await as('b', 'delete from team_members where user_id = $1 returning *', [users.d])).length === 1);
  check('a member can leave', (await as('e', 'delete from team_members where user_id = $1 returning *', [users.e])).length === 1);
  check(
    'nobody can make a second owner',
    (await fails('a', `update team_members set role = 'owner' where user_id = $1`, [users.c])).includes('row-level security'),
  );

  // ---- shared evidence ledger: append-only
  await as(
    'b',
    `insert into evidence (project_id, eid, kind, source, excerpt, trust, ts) values ($1, 'E1', 'svd', 'RP2040.svd', 'UARTFR @ 0x40034018', 'vendor-official', now())`,
    [tp.id],
  );
  check(
    'evidence: member uploads, teammates read',
    (await as('c', 'select excerpt from evidence where project_id = $1', [tp.id]))[0]?.excerpt === 'UARTFR @ 0x40034018',
  );
  check('evidence: outsiders cannot read', (await as('g', 'select * from evidence')).length === 0);
  check(
    'evidence: outsiders cannot write',
    (
      await fails('g', `insert into evidence (project_id, eid, kind, source, excerpt, trust, ts) values ($1, 'E9', 'svd', 's', 'x', 'unknown', now())`, [tp.id])
    ).includes('row-level security'),
  );
  check('evidence: no edits (append-only)', (await as('b', `update evidence set excerpt = 'tampered' returning *`)).length === 0);
  check('evidence: no deletes (append-only)', (await as('a', `delete from evidence returning *`)).length === 0);
  check(
    'evidence: cannot impersonate another uploader',
    (
      await fails(
        'c',
        `insert into evidence (project_id, eid, kind, source, excerpt, trust, ts, created_by) values ($1, 'E2', 'svd', 's', 'x', 'unknown', now(), $2)`,
        [tp.id, users.b],
      )
    ).includes('row-level security'),
  );
  check(
    'evidence: bad trust class rejected',
    (
      await fails('b', `insert into evidence (project_id, eid, kind, source, excerpt, trust, ts) values ($1, 'E3', 'svd', 's', 'x', 'trust-me', now())`, [
        tp.id,
      ])
    ).includes('check constraint'),
  );

  // ---- entitlements and usage
  const ent = async (u: keyof typeof users, t: string | null = null) => (await db.query<any>('select entitlement_for($1, $2) as e', [users[u], t])).rows[0].e;
  const e0 = await ent('a');
  check('entitlement: free plan, nothing used, usable', e0.plan === 'free' && e0.used === 0 && e0.usable === true && e0.limit === 200000, JSON.stringify(e0));
  check('entitlement: pending team is not usable', (await ent('a', team)).usable === false);
  check('entitlement: non-member asking for a team is refused', (await ent('g', team)).error === 'not_a_member');
  await as(
    'service',
    `insert into usage_events (user_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, billable_tokens) values ($1, 'claude-sonnet-5-5', 1000, 500, 9000, 100, billable_tokens(1000, 500, 9000, 100))`,
    [users.a],
  );
  check('billable tokens: input + cache write + output + cache read / 10', (await ent('a')).used === 1000 + 100 + 500 + 900);
  await as('service', `insert into usage_events (user_id, model, billable_tokens) values ($1, 'claude-sonnet-5-5', 200000)`, [users.a]);
  const e1 = await ent('a');
  check('entitlement: over the limit is not usable, remaining is 0', e1.usable === false && e1.remaining === 0, JSON.stringify(e1));
  await db.query(`select admin_set_plan($1, null, 'pro')`, [users.a]);
  const e2 = await ent('a');
  check(
    'admin_set_plan: upgrade to Pro, new period, usable again, Opus allowed',
    e2.plan === 'pro' && e2.usable === true && e2.models.includes('claude-opus-5-5'),
    JSON.stringify(e2),
  );
  await db.query(`select admin_set_plan(null, $1, 'team')`, [team]);
  await as('service', `insert into usage_events (user_id, team_id, model, billable_tokens) values ($1, $2, 'm', 1000), ($3, $2, 'm', 2000)`, [
    users.b,
    team,
    users.c,
  ]);
  const et = await ent('c', team);
  check('team usage is pooled across members', et.usable === true && et.used === 3000 && et.limit === 50000000, JSON.stringify(et));
  check('team usage does not count against personal plans', (await ent('b')).used === 0);
  const mine = (await as('c', 'select my_entitlement($1) as e', [team]))[0].e;
  check('my_entitlement: members read their team entitlement', mine.used === 3000);
  check(
    'usage rows: a member sees only their own',
    (await as('c', 'select billable_tokens from usage_events')).map((r: any) => Number(r.billable_tokens)).join(',') === '2000',
  );
  check('usage rows: team admin sees the whole team', (await as('b', 'select count(*)::int as n from usage_events where team_id = $1', [team]))[0].n === 2);
  check(
    'admin_set_plan: teams only take the team plan',
    ((await db.query(`select admin_set_plan(null, $1, 'pro')`, [team]).catch((e) => ({ err: String(e) }))) as any).err?.includes('teams use the team plan'),
  );

  // ---- team deletion cascades
  check('only the owner can delete the team', (await as('b', 'delete from teams where id = $1 returning id', [team])).length === 0);
  await as('a', 'delete from teams where id = $1', [team]);
  check(
    'deleting the team removes its projects and evidence',
    (await db.query<any>('select count(*)::int as n from evidence')).rows[0].n === 0 &&
      (await db.query<any>('select count(*)::int as n from projects where team_id is not null')).rows[0].n === 0,
  );

  // ---- security hardening (20261102000000_security_hardening.sql)
  const tid = (await as('a', `select create_team('  Hardening team  ') as id`))[0].id;
  check('team names are trimmed', (await as('a', 'select name from teams where id = $1', [tid]))[0]?.name === 'Hardening team');
  await as('a', `insert into team_invites (team_id, email) values ($1, $2)`, [tid, emails.g]);
  await db.query('update auth.users set email_confirmed_at = null where id = $1', [users.g]);
  check('invites: an unconfirmed email cannot even see an invite addressed to it', (await as('g', 'select * from team_invites')).length === 0);
  const gTok = (await db.query<any>('select token from team_invites where team_id = $1 and email = $2', [tid, emails.g])).rows[0].token;
  check('invites: an unconfirmed email cannot accept it', (await fails('g', 'select accept_invite($1)', [gTok])).includes('confirm your email'));
  check(
    'invites: the unconfirmed user did not join',
    (await db.query<any>('select count(*)::int as n from team_members where team_id = $1 and user_id = $2', [tid, users.g])).rows[0].n === 0,
  );
  await db.query('update auth.users set email_confirmed_at = now() where id = $1', [users.g]);
  check(
    'invites: once confirmed, the invitee sees it and can accept',
    (await as('g', 'select * from team_invites')).length === 1 && !!(await as('g', 'select accept_invite($1) as t', [gTok]))[0].t,
  );

  check(
    'functions: anonymous clients cannot call membership helpers',
    (await fails('anon', 'select is_team_member($1)', [tid])).includes('permission denied') &&
      (await fails('anon', 'select can_access_project($1)', [tid])).includes('permission denied'),
  );
  check(
    'functions: anonymous clients cannot call my_confirmed_email or create_team',
    (await fails('anon', 'select my_confirmed_email()')).includes('permission denied') &&
      (await fails('anon', `select create_team('x')`)).includes('permission denied'),
  );
  check(
    'functions: trigger functions are not callable by signed-in users',
    (await fails('a', 'select enforce_seat_limit()')).includes('permission denied') &&
      (await fails('a', 'select handle_new_user()')).includes('permission denied'),
  );
  const seatSrc = (await db.query<any>(`select prosrc from pg_proc where proname = 'enforce_seat_limit'`)).rows[0].prosrc as string;
  check('seat limit locks the team row (no two joins take the last seat)', /for update/i.test(seatSrc));

  for (let i = 0; i < 10; i++) await as('f', `select create_team($1)`, [`f-team-${i}`]);
  check('teams: a user can create at most 10', (await fails('f', `select create_team('one too many')`)).includes('team limit reached'));

  for (let i = 0; i < 50; i++) await as('a', `insert into team_invites (team_id, email) values ($1, $2)`, [tid, `bulk${i}@example.com`]);
  check(
    'invites: at most 50 pending per team',
    (await fails('a', `insert into team_invites (team_id, email) values ($1, 'bulk50@example.com')`, [tid])).includes('invite limit reached'),
  );

  check(
    'plans: evidence per project has a sane default',
    (await db.query<any>(`select max_evidence_per_project as n from plans where id = 'free'`)).rows[0].n === 50000,
  );
  await db.query(`update plans set max_evidence_per_project = 2 where id = 'free'`);
  const cp = (await as('c', `insert into projects (name, user_id) values ('cap-test', $1) returning id`, [users.c]))[0].id;
  const ins = (n: number) =>
    as('c', `insert into evidence (project_id, eid, kind, source, excerpt, trust, ts) values ($1, $2, 'svd', 's', 'x', 'unknown', now())`, [cp, `E${n}`]);
  await ins(1);
  await ins(2);
  check(
    'evidence: the plan limit stops a project from growing without bound',
    (
      await fails('c', `insert into evidence (project_id, eid, kind, source, excerpt, trust, ts) values ($1, 'E3', 'svd', 's', 'x', 'unknown', now())`, [cp])
    ).includes('evidence limit reached'),
  );
  await db.query(`update plans set max_evidence_per_project = 50000 where id = 'free'`);

  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
