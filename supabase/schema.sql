-- WebNest schema. Run once in the Supabase SQL editor.
-- Tables are only accessed server-side with the service-role key; RLS is
-- enabled with no policies so the anon/public key cannot read or write them.

create table if not exists webnest_batches (
  id          text primary key,
  params      jsonb not null,
  stage       text not null,
  phase       text not null default '',
  cursor      jsonb not null default '{}'::jsonb,
  export_mode text not null default 'sheets',
  message     text not null default '',
  error       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists webnest_candidates (
  batch_id   text not null references webnest_batches(id) on delete cascade,
  place_id   text not null,
  state      text not null,
  lead       jsonb not null,
  reason     text not null default '',
  attempts   int  not null default 0,
  updated_at timestamptz not null default now(),
  primary key (batch_id, place_id)
);
create index if not exists webnest_candidates_state on webnest_candidates (batch_id, state);

-- Short-lived named locks (export lock, per-batch step lock).
create table if not exists webnest_locks (
  name       text primary key,
  holder     text not null,
  expires_at timestamptz not null
);

create or replace function webnest_try_lock(p_name text, p_holder text, p_ttl_seconds int)
returns boolean language plpgsql as $$
declare current_holder text;
begin
  insert into webnest_locks (name, holder, expires_at)
  values (p_name, p_holder, now() + make_interval(secs => p_ttl_seconds))
  on conflict (name) do update
    set holder = excluded.holder, expires_at = excluded.expires_at
    where webnest_locks.expires_at < now() or webnest_locks.holder = excluded.holder;
  select holder into current_holder from webnest_locks where name = p_name;
  return current_holder = p_holder;
end $$;

create or replace function webnest_release_lock(p_name text, p_holder text)
returns void language sql as $$
  delete from webnest_locks where name = p_name and holder = p_holder;
$$;

alter table webnest_batches    enable row level security;
alter table webnest_candidates enable row level security;
alter table webnest_locks      enable row level security;
revoke execute on function webnest_try_lock(text, text, int) from anon, authenticated;
revoke execute on function webnest_release_lock(text, text) from anon, authenticated;
