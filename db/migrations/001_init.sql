-- 001_init.sql — schéma initial : utilisateurs, authentification, KYC, grand livre, mobile money, cartes.
-- Montants en FCFA (XOF), entiers : le franc CFA n'a pas de subdivision utilisée.

-- ---------------------------------------------------------------------------
-- Utilisateurs et authentification
-- ---------------------------------------------------------------------------

create table users (
  id                   uuid primary key default gen_random_uuid(),
  phone                text not null unique,
  pin_hash             text,
  pin_failed_attempts  int not null default 0,
  pin_locked_until     timestamptz,
  first_name           text,
  last_name            text,
  birth_date           date,
  language             text not null default 'fr' check (language in ('fr', 'wo', 'en')),
  kyc_tier             smallint not null default 0 check (kyc_tier between 0 and 3),
  status               text not null default 'active' check (status in ('active', 'frozen', 'closed')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table otp_challenges (
  id              uuid primary key default gen_random_uuid(),
  phone           text not null,
  code_hash       text not null,
  attempts        int not null default 0,
  expires_at      timestamptz not null,
  consumed_at     timestamptz,
  token_used_at   timestamptz,
  created_at      timestamptz not null default now()
);
create index otp_challenges_phone_created_idx on otp_challenges (phone, created_at desc);

create table devices (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users (id),
  device_id     text not null,
  label         text,
  trusted_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  revoked_at    timestamptz,
  unique (user_id, device_id)
);

create table refresh_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users (id),
  device_id    uuid not null references devices (id),
  token_hash   text not null unique,
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  replaced_by  uuid references refresh_tokens (id),
  created_at   timestamptz not null default now()
);
create index refresh_tokens_device_idx on refresh_tokens (device_id);

create table kyc_submissions (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references users (id),
  tier                smallint not null check (tier in (2, 3)),
  document_type       text not null check (document_type in ('cni', 'passport', 'consular_card', 'ninea', 'rccm')),
  provider_reference  text not null,
  status              text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  rejection_reason    text,
  reviewed_by         text,
  reviewed_at         timestamptz,
  created_at          timestamptz not null default now()
);
create index kyc_submissions_status_idx on kyc_submissions (status, created_at);
create unique index kyc_submissions_one_pending_idx on kyc_submissions (user_id, tier) where status = 'pending';

-- ---------------------------------------------------------------------------
-- Grand livre en partie double
-- ---------------------------------------------------------------------------
-- Règles garanties par la base, pas seulement par le code :
--   * chaque transaction est équilibrée (débits = crédits) et a au moins 2 écritures ;
--   * les écritures et les transactions ne peuvent être ni modifiées ni supprimées ;
--   * un compte sans découvert autorisé ne peut jamais passer sous zéro ;
--   * le solde en cache est mis à jour dans la même transaction que les écritures.

create table ledger_accounts (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique,
  kind             text not null check (kind in ('asset', 'liability', 'revenue', 'expense')),
  owner_user_id    uuid references users (id),
  currency         char(3) not null default 'XOF',
  allow_negative   boolean not null default false,
  balance          bigint not null default 0,
  created_at       timestamptz not null default now(),
  constraint ledger_accounts_no_overdraft check (allow_negative or balance >= 0)
);
create index ledger_accounts_owner_idx on ledger_accounts (owner_user_id);

create table ledger_transactions (
  id                uuid primary key default gen_random_uuid(),
  kind              text not null check (kind in (
                      'topup', 'card_creation_fee', 'card_load', 'card_unload',
                      'card_authorization', 'card_reversal',
                      'withdrawal_hold', 'withdrawal_settle', 'withdrawal_release',
                      'adjustment')),
  idempotency_key   text not null unique,
  user_id           uuid references users (id),
  reference_id      uuid,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now()
);
create index ledger_transactions_user_idx on ledger_transactions (user_id, created_at desc);

create table ledger_entries (
  id               bigserial primary key,
  transaction_id   uuid not null references ledger_transactions (id),
  account_id       uuid not null references ledger_accounts (id),
  direction        char(1) not null check (direction in ('D', 'C')),
  amount           bigint not null check (amount > 0),
  created_at       timestamptz not null default now()
);
create index ledger_entries_account_idx on ledger_entries (account_id, id desc);
create index ledger_entries_transaction_idx on ledger_entries (transaction_id);

-- Montant signé d'une écriture selon la nature du compte :
-- actif/charge augmentent au débit, passif/produit augmentent au crédit.
create function ledger_signed_amount(account_kind text, direction char, amount bigint)
returns bigint language sql immutable as $$
  select case when (account_kind in ('asset', 'expense')) = (direction = 'D') then amount else -amount end
$$;

-- Écritures et transactions immuables : une erreur se corrige par une écriture inverse.
create function ledger_forbid_change() returns trigger language plpgsql as $$
begin
  raise exception 'le grand livre est immuable : % interdit sur %', tg_op, tg_table_name
    using errcode = 'P0001';
end $$;

create trigger ledger_entries_immutable before update or delete on ledger_entries
  for each row execute function ledger_forbid_change();
create trigger ledger_transactions_immutable before update or delete on ledger_transactions
  for each row execute function ledger_forbid_change();
create trigger ledger_entries_no_truncate before truncate on ledger_entries
  for each statement execute function ledger_forbid_change();
create trigger ledger_transactions_no_truncate before truncate on ledger_transactions
  for each statement execute function ledger_forbid_change();

-- Mise à jour immédiate du solde en cache. L'UPDATE pose un verrou sur la ligne du compte :
-- deux opérations concurrentes sur le même compte sont donc sérialisées, et la contrainte
-- ledger_accounts_no_overdraft refuse celle qui ferait passer le solde sous zéro.
create function ledger_apply_entry() returns trigger language plpgsql as $$
begin
  update ledger_accounts a
     set balance = a.balance + ledger_signed_amount(a.kind, new.direction, new.amount)
   where a.id = new.account_id;
  return null;
end $$;

create trigger ledger_entries_apply after insert on ledger_entries
  for each row execute function ledger_apply_entry();

-- Équilibre vérifié au COMMIT (contrainte différée) : la transaction entière est annulée sinon.
create function ledger_check_balanced() returns trigger language plpgsql as $$
declare
  debits  bigint;
  credits bigint;
  n       int;
begin
  select coalesce(sum(amount) filter (where direction = 'D'), 0),
         coalesce(sum(amount) filter (where direction = 'C'), 0),
         count(*)
    into debits, credits, n
    from ledger_entries
   where transaction_id = new.transaction_id;
  if n < 2 or debits <> credits then
    raise exception 'transaction % déséquilibrée (débits %, crédits %, écritures %)',
      new.transaction_id, debits, credits, n using errcode = 'P0001';
  end if;
  return null;
end $$;

create constraint trigger ledger_entries_balanced after insert on ledger_entries
  deferrable initially deferred
  for each row execute function ledger_check_balanced();

-- Contrôle de rapprochement : solde en cache contre somme des écritures.
create view ledger_balance_check as
select a.id,
       a.code,
       a.balance as cached_balance,
       coalesce(sum(ledger_signed_amount(a.kind, e.direction, e.amount)), 0) as computed_balance
  from ledger_accounts a
  left join ledger_entries e on e.account_id = a.id
 group by a.id;

-- Comptes système
insert into ledger_accounts (code, kind, allow_negative) values
  ('system:momo_float:wave',         'asset',     true),
  ('system:momo_float:orange_money', 'asset',     true),
  ('system:momo_float:free_money',   'asset',     true),
  ('system:momo_float:mtn',          'asset',     true),
  ('system:momo_float:moov',         'asset',     true),
  ('system:withdrawals_in_flight',   'liability', false),
  ('system:issuer_payable',          'liability', true),
  ('system:fees_revenue',            'revenue',   false);

-- ---------------------------------------------------------------------------
-- Mobile money (recharges et retraits)
-- ---------------------------------------------------------------------------

create table momo_operations (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references users (id),
  direction           text not null check (direction in ('collection', 'disbursement')),
  operator            text not null check (operator in ('wave', 'orange_money', 'free_money', 'mtn', 'moov')),
  msisdn              text not null,
  amount              bigint not null check (amount > 0),
  fee                 bigint not null default 0 check (fee >= 0),
  status              text not null default 'pending' check (status in ('pending', 'succeeded', 'failed')),
  provider_reference  text unique,
  idempotency_key     text not null,
  failure_reason      text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  completed_at        timestamptz,
  unique (user_id, idempotency_key)
);
create index momo_operations_user_month_idx on momo_operations (user_id, direction, created_at);

-- ---------------------------------------------------------------------------
-- Cartes
-- ---------------------------------------------------------------------------

create table cards (
  id                  uuid primary key,
  user_id             uuid not null references users (id),
  issuer              text not null,
  issuer_card_id      text not null unique,
  type                text not null check (type in ('multi', 'single_use', 'subscription')),
  label               text,
  last4               char(4) not null,
  expiry_month        smallint not null check (expiry_month between 1 and 12),
  expiry_year         smallint not null,
  status              text not null default 'active' check (status in ('active', 'frozen', 'terminated')),
  monthly_limit       bigint check (monthly_limit > 0),
  ledger_account_id   uuid not null unique references ledger_accounts (id),
  idempotency_key     text not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  terminated_at       timestamptz,
  unique (user_id, idempotency_key)
);
create index cards_user_idx on cards (user_id, status);

create table card_authorizations (
  id                        uuid primary key default gen_random_uuid(),
  card_id                   uuid references cards (id),
  issuer_card_id            text not null,
  issuer_authorization_id   text not null unique,
  merchant_name             text,
  merchant_country          char(2),
  mcc                       text,
  original_amount           bigint not null,
  original_currency         char(3) not null,
  amount_xof                bigint not null,
  fee_xof                   bigint not null default 0,
  decision                  text not null check (decision in ('approved', 'declined')),
  decline_reason            text,
  ledger_transaction_id     uuid references ledger_transactions (id),
  reversed_at               timestamptz,
  created_at                timestamptz not null default now()
);
create index card_authorizations_card_idx on card_authorizations (card_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Journal d'audit (actions du back-office, événements suspects)
-- ---------------------------------------------------------------------------

create table audit_log (
  id           bigserial primary key,
  actor        text not null,
  action       text not null,
  target_type  text,
  target_id    text,
  details      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index audit_log_target_idx on audit_log (target_type, target_id);
