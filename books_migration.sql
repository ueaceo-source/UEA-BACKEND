-- ═══════════════════════════════════════════════════════════════════════════
-- UPPER ECHELON AUTOMOTIVE — BOOKS (owner bookkeeping) TABLES
-- Run this ENTIRE script once in Supabase → SQL Editor → New query → Run.
-- Safe to run again; it only creates what's missing. Nothing existing is touched.
-- ═══════════════════════════════════════════════════════════════════════════

-- Settings for the Books screen (tax set-aside %, mileage rate, categories)
create table if not exists uea_book_settings (
  id int primary key default 1 check (id = 1),
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into uea_book_settings (id, config) values (1, '{}'::jsonb) on conflict (id) do nothing;

-- Repeating monthly bills (insurance, software, phone…)
create table if not exists uea_book_recurring (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'expense' check (kind in ('expense', 'income')),
  category text not null,
  vendor text,
  description text,
  amount_cents bigint not null check (amount_cents >= 0),
  method text,
  day_of_month int not null default 1 check (day_of_month between 1 and 31),
  start_date date not null,
  end_date date,
  active boolean not null default true,
  last_posted date,
  created_by text,
  created_at timestamptz not null default now()
);

-- Every expense and every income entry that isn't a desk job payment
create table if not exists uea_book_entries (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('expense', 'income')),
  entry_date date not null,
  category text not null,
  vendor text,
  description text,
  amount_cents bigint not null check (amount_cents >= 0),
  method text,
  job_ref text,
  has_receipt boolean not null default false,
  recurring_id uuid references uea_book_recurring(id) on delete set null,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uea_book_entries_recurring_once unique (recurring_id, entry_date)
);
create index if not exists uea_book_entries_date_idx on uea_book_entries (entry_date);

-- Receipt photos (kept apart so lists stay fast)
create table if not exists uea_book_receipts (
  entry_id uuid primary key references uea_book_entries(id) on delete cascade,
  data text not null,
  created_at timestamptz not null default now()
);

-- Business miles driven
create table if not exists uea_book_mileage (
  id uuid primary key default gen_random_uuid(),
  trip_date date not null,
  miles numeric(8,1) not null check (miles > 0),
  purpose text,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists uea_book_mileage_date_idx on uea_book_mileage (trip_date);

-- Link an expense to a specific job (parts run, gas, tech pay for that job…)
alter table uea_book_entries add column if not exists booking_id text;
create index if not exists uea_book_entries_booking_idx on uea_book_entries (booking_id);

-- Lock the tables down: only the backend (service key) can read or write them.
alter table uea_book_settings  enable row level security;
alter table uea_book_recurring enable row level security;
alter table uea_book_entries   enable row level security;
alter table uea_book_receipts  enable row level security;
alter table uea_book_mileage   enable row level security;

-- Tell the API about the new tables right away.
notify pgrst, 'reload schema';
