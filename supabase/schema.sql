-- DomainGuard schema v3.0
-- Run in Supabase SQL Editor. This schema uses user-owned rows and RLS.
create extension if not exists pgcrypto;

create table if not exists public.domains (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  domain_name text not null,
  tld text not null,
  registrar_name text,
  registration_date date,
  expiration_date date,
  domain_status text not null default 'pending',
  availability_status text not null default 'unknown',
  nameservers text[] not null default '{}',
  status_codes text[] not null default '{}',
  data_source text,
  portfolio text not null default 'Unassigned',
  notes text,
  last_checked_at timestamptz,
  next_check_at timestamptz not null default now(),
  last_check_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint domains_name_lowercase check (domain_name = lower(domain_name)),
  constraint domains_name_nonempty check (length(domain_name) between 3 and 253),
  constraint domains_owner_domain_unique unique (owner_id, domain_name)
);
create index if not exists domains_owner_expiry_idx on public.domains(owner_id, expiration_date);
create index if not exists domains_next_check_idx on public.domains(next_check_at);

create table if not exists public.portfolios (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  constraint portfolios_owner_name_unique unique (owner_id, name)
);

create table if not exists public.notification_preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  email_enabled boolean not null default true,
  email_recipient text,
  telegram_enabled boolean not null default false,
  telegram_chat_id text,
  notify_days_before integer[] not null default array[30,14,7,3,1,0],
  updated_at timestamptz not null default now(),
  constraint valid_reminder_days check (notify_days_before <@ array[180,90,60,30,14,7,3,1,0]::integer[])
);

create table if not exists public.alerts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  domain_id uuid references public.domains(id) on delete cascade,
  domain_name text,
  alert_type text not null default 'system',
  severity text not null default 'info' check (severity in ('info','warning','critical')),
  title text not null,
  message text not null,
  is_read boolean not null default false,
  dedupe_key text,
  created_at timestamptz not null default now(),
  constraint alerts_owner_dedupe_unique unique (owner_id, dedupe_key)
);
create index if not exists alerts_owner_created_idx on public.alerts(owner_id, created_at desc);

create table if not exists public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  alert_id uuid references public.alerts(id) on delete set null,
  domain_id uuid references public.domains(id) on delete set null,
  channel text not null check (channel in ('email','telegram')),
  recipient text,
  status text not null check (status in ('pending','delivered','failed')),
  provider_id text,
  error_message text,
  created_at timestamptz not null default now()
);
create index if not exists deliveries_owner_created_idx on public.notification_deliveries(owner_id, created_at desc);

create or replace function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists domains_set_updated_at on public.domains;
create trigger domains_set_updated_at before update on public.domains for each row execute function public.set_updated_at();
drop trigger if exists notification_preferences_set_updated_at on public.notification_preferences;
create trigger notification_preferences_set_updated_at before update on public.notification_preferences for each row execute function public.set_updated_at();

alter table public.domains enable row level security;
alter table public.portfolios enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.alerts enable row level security;
alter table public.notification_deliveries enable row level security;

drop policy if exists "owners manage their domains" on public.domains;
create policy "owners manage their domains" on public.domains for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists "owners manage their portfolios" on public.portfolios;
create policy "owners manage their portfolios" on public.portfolios for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists "owners manage their notification preferences" on public.notification_preferences;
create policy "owners manage their notification preferences" on public.notification_preferences for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "owners read their alerts" on public.alerts;
create policy "owners read their alerts" on public.alerts for select to authenticated using (owner_id = auth.uid());
drop policy if exists "owners update their alerts" on public.alerts;
create policy "owners update their alerts" on public.alerts for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists "owners delete their alerts" on public.alerts;
create policy "owners delete their alerts" on public.alerts for delete to authenticated using (owner_id = auth.uid());
drop policy if exists "owners read their delivery history" on public.notification_deliveries;
create policy "owners read their delivery history" on public.notification_deliveries for select to authenticated using (owner_id = auth.uid());

-- No client insert policy on alerts/delivery history: only the trusted scheduled function writes them.
-- Supabase Edge Function secrets required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
-- CRON_SECRET, RESEND_API_KEY, RESEND_FROM_EMAIL, TELEGRAM_BOT_TOKEN.
