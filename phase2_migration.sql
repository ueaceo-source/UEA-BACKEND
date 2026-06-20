-- ═══════════════════════════════════════════════════════════════════════════
-- UPPER ECHELON AUTOMOTIVE — PHASE 2 MIGRATION (Stripe columns)
-- Adds the columns the new payment backend needs to read/write.
-- Safe to run even if some columns already exist.
-- Run this ENTIRE script in Supabase SQL Editor in ONE paste, then RUN.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Technicians: Stripe Connect account ──
do $$
begin
  if not exists (select 1 from information_schema.columns where table_name='uea_technicians' and column_name='stripe_connect_id') then
    alter table uea_technicians add column stripe_connect_id text;
  end if;
end $$;

-- ── Users: Stripe customer + subscription ──
do $$
begin
  if not exists (select 1 from information_schema.columns where table_name='uea_users' and column_name='stripe_customer_id') then
    alter table uea_users add column stripe_customer_id text;
  end if;
  if not exists (select 1 from information_schema.columns where table_name='uea_users' and column_name='stripe_subscription_id') then
    alter table uea_users add column stripe_subscription_id text;
  end if;
end $$;

-- ── Appointments: payment tracking ──
do $$
begin
  if not exists (select 1 from information_schema.columns where table_name='uea_appointments' and column_name='payment_status') then
    alter table uea_appointments add column payment_status text default 'unpaid'; -- unpaid | paid | failed
  end if;
  if not exists (select 1 from information_schema.columns where table_name='uea_appointments' and column_name='payment_intent_id') then
    alter table uea_appointments add column payment_intent_id text;
  end if;
  if not exists (select 1 from information_schema.columns where table_name='uea_appointments' and column_name='paid_at') then
    alter table uea_appointments add column paid_at timestamptz;
  end if;
end $$;

-- Done! You should see "Success. No rows returned."
