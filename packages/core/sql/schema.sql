create table if not exists verdicts (
  id            text primary key,
  address       text        not null,
  chain_id      int         not null,
  severity      text        not null,
  score         int         not null,
  summary       text        not null,
  analysis      jsonb       not null default '{}',
  gate_required boolean     not null default false,
  gate_approved boolean,
  gate_method   text,
  gate_reason   text,
  created_at    timestamptz not null default now()
);

create table if not exists signal_results (
  verdict_id text not null references verdicts(id) on delete cascade,
  name       text not null,
  fired      boolean not null,
  weight     real not null,
  evidence   jsonb not null default '[]',
  error      text
);

create table if not exists taint_events (
  verdict_id    text not null references verdicts(id) on delete cascade,
  field_path    text not null,
  source        text not null,
  raw           text not null,
  action        text not null,
  matched_rules jsonb not null default '[]'
);

create index if not exists verdicts_created_at_idx on verdicts (created_at desc);
create index if not exists signal_results_verdict_idx on signal_results (verdict_id);
create index if not exists taint_events_verdict_idx on taint_events (verdict_id);

-- Added after the gate shipped. A verdict re-read from here was reporting
-- "not approved" instead of the reason the device gave, so preflight_explain
-- contradicted preflight_check on the same verdict.
alter table verdicts add column if not exists gate_reason text;
