begin;

-- Phase 8 (section 13.1/13.3.1): caches the sId a 도매매 setLogin call returns
-- so every Private API call doesn't have to log in fresh -- sId is valid for
-- up to ~24h (or 30d with loginKeep=on) per the docs. Single row: this app
-- talks to 도매매 as one 구매 계정, never per-user.
create table if not exists domeme_session_state (
  id integer primary key default 1 check (id = 1),
  s_id text,
  c_id text,
  grade text,
  s_id_renew_date bigint,
  logged_in_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into domeme_session_state (id) values (1) on conflict (id) do nothing;

commit;
