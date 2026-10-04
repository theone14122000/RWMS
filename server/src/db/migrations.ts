export interface Migration {
  id: string;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: '001',
    name: 'core_schema',
    sql: `
-- ============================ RBAC ============================
CREATE TABLE roles (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE permissions (
  id         INTEGER PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT 'general',
  created_at TEXT NOT NULL
);

CREATE TABLE role_permissions (
  role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT,
  username      TEXT,
  password_hash TEXT NOT NULL,
  role_id       INTEGER NOT NULL REFERENCES roles(id),
  status        TEXT NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('ACTIVE','INACTIVE','SUSPENDED')),
  last_login_at TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);
CREATE UNIQUE INDEX idx_users_email ON users(lower(email)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_users_username ON users(lower(username)) WHERE username IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_users_role ON users(role_id);
CREATE INDEX idx_users_status ON users(status);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,          -- sha256(token)
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip         TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- ========================= CUSTOMERS ==========================
CREATE TABLE customers (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT,
  whatsapp   TEXT,
  email      TEXT,
  city       TEXT,
  state      TEXT,
  country    TEXT,
  notes      TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_customers_name ON customers(name);
CREATE INDEX idx_customers_phone ON customers(phone);
CREATE INDEX idx_customers_whatsapp ON customers(whatsapp);
CREATE INDEX idx_customers_email ON customers(email);
CREATE INDEX idx_customers_active ON customers(deleted_at, name);

-- ============================ LEADS ===========================
CREATE TABLE lead_sources (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  is_active  INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE lead_statuses (
  id         INTEGER PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT 'OPEN'
             CHECK (category IN ('OPEN','WON','LOST','NEUTRAL')),
  color      TEXT NOT NULL DEFAULT '#64748b',
  is_active  INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE leads (
  id               INTEGER PRIMARY KEY,
  lead_number      TEXT NOT NULL UNIQUE,
  customer_id      INTEGER NOT NULL REFERENCES customers(id),
  source_id        INTEGER REFERENCES lead_sources(id),
  assigned_to      INTEGER REFERENCES users(id),
  destination      TEXT,
  travel_type      TEXT CHECK (travel_type IN ('DOMESTIC','INTERNATIONAL')),
  trip_type        TEXT,
  requirements     TEXT NOT NULL DEFAULT '[]',
  travel_start_date TEXT,
  travel_end_date   TEXT,
  duration_days    INTEGER,
  adults           INTEGER,
  children         INTEGER,
  total_travelers  INTEGER,
  budget           REAL,
  currency         TEXT NOT NULL DEFAULT 'INR',
  priority         TEXT NOT NULL DEFAULT 'MEDIUM'
                   CHECK (priority IN ('LOW','MEDIUM','HIGH','URGENT')),
  status_id        INTEGER NOT NULL REFERENCES lead_statuses(id),
  last_contacted_at TEXT,
  next_follow_up_at TEXT,
  notes             TEXT,
  custom_fields    TEXT NOT NULL DEFAULT '{}',
  created_by       INTEGER REFERENCES users(id),
  updated_by       INTEGER REFERENCES users(id),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT
);
CREATE INDEX idx_leads_customer ON leads(customer_id);
CREATE INDEX idx_leads_status ON leads(status_id);
CREATE INDEX idx_leads_source ON leads(source_id);
CREATE INDEX idx_leads_created ON leads(created_at);
CREATE INDEX idx_leads_next_fu ON leads(next_follow_up_at);
CREATE INDEX idx_leads_active ON leads(deleted_at, assigned_to, status_id);
CREATE INDEX idx_leads_dest ON leads(destination);

CREATE TABLE lead_assignments (
  id          INTEGER PRIMARY KEY,
  lead_id     INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  assigned_to INTEGER NOT NULL REFERENCES users(id),
  assigned_by INTEGER NOT NULL REFERENCES users(id),
  action      TEXT NOT NULL CHECK (action IN ('ASSIGNED','REASSIGNED','UNASSIGNED')),
  reason      TEXT,
  assigned_at TEXT NOT NULL,
  released_at TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_assign_lead ON lead_assignments(lead_id, is_active);
CREATE INDEX idx_assign_worker ON lead_assignments(assigned_to, is_active);
CREATE INDEX idx_assign_at ON lead_assignments(assigned_at);

CREATE TABLE lead_status_history (
  id             INTEGER PRIMARY KEY,
  lead_id        INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_status_id INTEGER REFERENCES lead_statuses(id),
  to_status_id   INTEGER NOT NULL REFERENCES lead_statuses(id),
  changed_by     INTEGER REFERENCES users(id),
  remark         TEXT,
  changed_at     TEXT NOT NULL
);
CREATE INDEX idx_status_hist_lead ON lead_status_history(lead_id, changed_at);

-- Extensible event log powering the lead timeline.
-- Part 2 will append new event types (CALL_INITIATED, QUOTATION_SENT, ...)
-- without changing this schema.
CREATE TABLE lead_timeline (
  id         INTEGER PRIMARY KEY,
  lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  actor_id   INTEGER REFERENCES users(id),
  summary    TEXT NOT NULL,
  metadata   TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_timeline_lead ON lead_timeline(lead_id, created_at);
CREATE INDEX idx_timeline_actor ON lead_timeline(actor_id, created_at);
CREATE INDEX idx_timeline_type ON lead_timeline(type, created_at);

CREATE TABLE notes (
  id         INTEGER PRIMARY KEY,
  lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  author_id  INTEGER NOT NULL REFERENCES users(id),
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_notes_lead ON notes(lead_id, created_at);

-- ========================== FOLLOW-UPS ========================
CREATE TABLE follow_ups (
  id                INTEGER PRIMARY KEY,
  lead_id           INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  worker_id         INTEGER NOT NULL REFERENCES users(id),
  scheduled_date    TEXT NOT NULL,          -- YYYY-MM-DD (business timezone)
  scheduled_time    TEXT,                   -- HH:MM
  type              TEXT NOT NULL DEFAULT 'CALL',
  status            TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','TODAY','COMPLETED','CONVERTED','NOT_INTERESTED',
                                      'RESCHEDULED','NO_RESPONSE','CALLBACK_REQUESTED','OVERDUE','CANCELLED')),
  notes             TEXT,
  customer_response TEXT,
  next_action       TEXT,
  created_by        INTEGER REFERENCES users(id),
  completed_by      INTEGER REFERENCES users(id),
  created_at        TEXT NOT NULL,
  completed_at      TEXT,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT
);
CREATE INDEX idx_fu_worker_date ON follow_ups(worker_id, scheduled_date);
CREATE INDEX idx_fu_lead ON follow_ups(lead_id, scheduled_date);
CREATE INDEX idx_fu_status ON follow_ups(status);
CREATE INDEX idx_fu_date ON follow_ups(scheduled_date);
CREATE INDEX idx_fu_active ON follow_ups(deleted_at, worker_id, scheduled_date);

-- ======================== NOTIFICATIONS =======================
CREATE TABLE notifications (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT,
  entity     TEXT,
  entity_id  INTEGER,
  link       TEXT,
  read_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_notif_user ON notifications(user_id, read_at, created_at);

-- ========================== AUDIT LOG =========================
CREATE TABLE audit_logs (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id),
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT,
  metadata   TEXT NOT NULL DEFAULT '{}',
  ip         TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_user ON audit_logs(user_id, created_at);
CREATE INDEX idx_audit_entity ON audit_logs(entity, entity_id);
CREATE INDEX idx_audit_created ON audit_logs(created_at);
CREATE INDEX idx_audit_action ON audit_logs(action, created_at);

-- =========================== SETTINGS =========================
CREATE TABLE settings (
  setting_key TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
`,
  },
  {
    id: '002',
    name: 'part2_operations',
    sql: `
-- ============================ CALLS ===========================
-- Provider-independent call records. Written manually by workers or by
-- telephony webhooks; provider_call_id is unique per provider so duplicate
-- webhook events can never create a second row.
CREATE TABLE calls (
  id                INTEGER PRIMARY KEY,
  lead_id           INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  customer_id       INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  worker_id         INTEGER NOT NULL REFERENCES users(id),
  provider          TEXT NOT NULL DEFAULT 'manual',
  provider_call_id  TEXT,
  direction         TEXT NOT NULL DEFAULT 'OUTBOUND'
                    CHECK (direction IN ('INBOUND','OUTBOUND')),
  phone_number      TEXT,
  started_at        TEXT,
  answered_at       TEXT,
  ended_at          TEXT,
  duration_seconds  INTEGER,
  status            TEXT NOT NULL DEFAULT 'RINGING',
  disposition       TEXT,
  recording_available INTEGER NOT NULL DEFAULT 0,
  recording_ref     TEXT,
  consent           TEXT,
  notes             TEXT,
  follow_up_id      INTEGER REFERENCES follow_ups(id) ON DELETE SET NULL,
  webhook_event_id  TEXT,
  created_by        INTEGER REFERENCES users(id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT
);
CREATE UNIQUE INDEX idx_calls_provider ON calls(provider, provider_call_id)
  WHERE provider_call_id IS NOT NULL;
CREATE INDEX idx_calls_lead ON calls(lead_id, started_at);
CREATE INDEX idx_calls_customer ON calls(customer_id, started_at);
CREATE INDEX idx_calls_worker ON calls(worker_id, started_at);
CREATE INDEX idx_calls_started ON calls(started_at);
CREATE INDEX idx_calls_status ON calls(status);

-- Recordings are never linked from public URLs: source_url/file_key stay
-- server-side and playback goes through an authenticated, audited endpoint.
CREATE TABLE call_recordings (
  id                   INTEGER PRIMARY KEY,
  call_id              INTEGER NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  provider             TEXT NOT NULL DEFAULT 'manual',
  provider_recording_id TEXT,
  storage              TEXT NOT NULL DEFAULT 'provider'
                       CHECK (storage IN ('provider','local')),
  source_url           TEXT,
  file_key             TEXT,
  mime_type            TEXT,
  duration_seconds     INTEGER,
  status               TEXT NOT NULL DEFAULT 'PENDING'
                       CHECK (status IN ('PENDING','AVAILABLE','FAILED','DELETED')),
  consent              TEXT,
  retention_until      TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  deleted_at           TEXT
);
CREATE UNIQUE INDEX idx_recording_provider ON call_recordings(provider, provider_recording_id)
  WHERE provider_recording_id IS NOT NULL;
CREATE INDEX idx_recording_call ON call_recordings(call_id);
CREATE INDEX idx_recording_retention ON call_recordings(retention_until);

-- Webhook inbox: (provider, event_id) is unique so retries/duplicates are
-- detected before any business logic runs.
CREATE TABLE webhook_events (
  id           INTEGER PRIMARY KEY,
  provider     TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  signature    TEXT,
  status       TEXT NOT NULL DEFAULT 'RECEIVED'
               CHECK (status IN ('RECEIVED','PROCESSED','DUPLICATE','FAILED','IGNORED')),
  payload      TEXT NOT NULL,
  error        TEXT,
  call_id      INTEGER REFERENCES calls(id) ON DELETE SET NULL,
  received_at  TEXT NOT NULL,
  processed_at TEXT,
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_webhook_event ON webhook_events(provider, event_id);
CREATE INDEX idx_webhook_received ON webhook_events(received_at);

-- ========================= QUOTATIONS =========================
CREATE TABLE quotations (
  id                INTEGER PRIMARY KEY,
  quotation_number  TEXT NOT NULL UNIQUE,
  lead_id           INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  customer_id       INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  worker_id         INTEGER REFERENCES users(id),
  destination       TEXT,
  travel_start_date TEXT,
  travel_end_date   TEXT,
  travelers         INTEGER,
  accommodation     TEXT,
  transport         TEXT,
  activities        TEXT,
  inclusions        TEXT NOT NULL DEFAULT '[]',
  exclusions        TEXT NOT NULL DEFAULT '[]',
  items             TEXT NOT NULL DEFAULT '[]',
  currency          TEXT NOT NULL DEFAULT 'INR',
  total_amount      REAL NOT NULL DEFAULT 0,
  notes             TEXT,
  valid_until       TEXT,
  status            TEXT NOT NULL DEFAULT 'DRAFT'
                    CHECK (status IN ('DRAFT','SENT','VIEWED','NEGOTIATION','ACCEPTED','REJECTED','EXPIRED','CANCELLED')),
  status_history    TEXT NOT NULL DEFAULT '[]',
  sent_at           TEXT,
  accepted_at       TEXT,
  rejected_at       TEXT,
  created_by        INTEGER REFERENCES users(id),
  updated_by        INTEGER REFERENCES users(id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT
);
CREATE INDEX idx_quot_lead ON quotations(lead_id, created_at);
CREATE INDEX idx_quot_customer ON quotations(customer_id, created_at);
CREATE INDEX idx_quot_worker ON quotations(worker_id, created_at);
CREATE INDEX idx_quot_status ON quotations(status);
CREATE INDEX idx_quot_valid ON quotations(valid_until);

-- =========================== BOOKINGS =========================
CREATE TABLE bookings (
  id                INTEGER PRIMARY KEY,
  booking_number    TEXT NOT NULL UNIQUE,
  lead_id           INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  customer_id       INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  quotation_id      INTEGER REFERENCES quotations(id) ON DELETE SET NULL,
  worker_id         INTEGER REFERENCES users(id),
  destination       TEXT,
  travel_start_date TEXT,
  travel_end_date   TEXT,
  travelers         INTEGER,
  services          TEXT NOT NULL DEFAULT '[]',
  currency          TEXT NOT NULL DEFAULT 'INR',
  total_amount      REAL NOT NULL DEFAULT 0,
  paid_amount       REAL NOT NULL DEFAULT 0,
  payment_status    TEXT NOT NULL DEFAULT 'UNPAID'
                    CHECK (payment_status IN ('UNPAID','PARTIAL','PAID','REFUNDED')),
  status            TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','CONFIRMED','IN_PROGRESS','COMPLETED','CANCELLED')),
  status_history    TEXT NOT NULL DEFAULT '[]',
  notes             TEXT,
  booked_at         TEXT,
  created_by        INTEGER REFERENCES users(id),
  updated_by        INTEGER REFERENCES users(id),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT
);
CREATE INDEX idx_book_lead ON bookings(lead_id);
CREATE INDEX idx_book_customer ON bookings(customer_id, created_at);
CREATE INDEX idx_book_worker ON bookings(worker_id, created_at);
CREATE INDEX idx_book_status ON bookings(status);

-- Payments stay a separate architecture so a payment gateway can be added
-- later without touching bookings.
CREATE TABLE payments (
  id          INTEGER PRIMARY KEY,
  booking_id  INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  amount      REAL NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'INR',
  method      TEXT,
  reference   TEXT,
  status      TEXT NOT NULL DEFAULT 'RECORDED'
              CHECK (status IN ('RECORDED','PENDING','CONFIRMED','FAILED','REFUNDED')),
  paid_at     TEXT,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE INDEX idx_payment_booking ON payments(booking_id, created_at);

-- ======================== COMMUNICATIONS ======================
-- Channel-agnostic outbound/inbound message ledger. status stays QUEUED or
-- NOT_CONFIGURED until a provider actually confirms delivery.
CREATE TABLE communications (
  id                 INTEGER PRIMARY KEY,
  channel            TEXT NOT NULL
                     CHECK (channel IN ('WHATSAPP','EMAIL','SMS','IN_APP')),
  direction          TEXT NOT NULL DEFAULT 'OUTBOUND'
                     CHECK (direction IN ('INBOUND','OUTBOUND')),
  provider           TEXT,
  provider_message_id TEXT,
  sender_id          INTEGER REFERENCES users(id),
  recipient          TEXT NOT NULL,
  customer_id        INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  lead_id            INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  worker_id          INTEGER REFERENCES users(id),
  subject            TEXT,
  body               TEXT,
  status             TEXT NOT NULL DEFAULT 'QUEUED'
                     CHECK (status IN ('QUEUED','SENT','DELIVERED','READ','FAILED','NOT_CONFIGURED')),
  error              TEXT,
  sent_at            TEXT,
  delivered_at       TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  deleted_at         TEXT
);
CREATE INDEX idx_comm_lead ON communications(lead_id, created_at);
CREATE INDEX idx_comm_customer ON communications(customer_id, created_at);
CREATE INDEX idx_comm_worker ON communications(worker_id, created_at);
CREATE INDEX idx_comm_status ON communications(status, created_at);
CREATE INDEX idx_comm_provider ON communications(provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- ========================== DOCUMENTS =========================
-- stored_name is a random token: private files are never reachable through a
-- predictable public URL, only through the authenticated file endpoint.
CREATE TABLE documents (
  id           INTEGER PRIMARY KEY,
  entity       TEXT NOT NULL
               CHECK (entity IN ('CUSTOMER','LEAD','QUOTATION','BOOKING','CALL','GENERAL')),
  entity_id    INTEGER NOT NULL,
  category     TEXT,
  filename     TEXT NOT NULL,
  stored_name  TEXT NOT NULL UNIQUE,
  mime_type    TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  uploaded_by  INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL,
  deleted_at   TEXT
);
CREATE INDEX idx_docs_entity ON documents(entity, entity_id, created_at);

-- =========================== IMPORTS ==========================
CREATE TABLE import_jobs (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL DEFAULT 'LEADS',
  filename      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING','PARSED','IMPORTING','COMPLETED','FAILED')),
  column_map    TEXT NOT NULL DEFAULT '{}',
  preview       TEXT NOT NULL DEFAULT '[]',
  total_rows    INTEGER NOT NULL DEFAULT 0,
  valid_rows    INTEGER NOT NULL DEFAULT 0,
  invalid_rows  INTEGER NOT NULL DEFAULT 0,
  duplicate_rows INTEGER NOT NULL DEFAULT 0,
  imported_rows INTEGER NOT NULL DEFAULT 0,
  failed_rows   INTEGER NOT NULL DEFAULT 0,
  errors        TEXT NOT NULL DEFAULT '[]',
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  completed_at  TEXT,
  deleted_at    TEXT
);
CREATE INDEX idx_imports_created ON import_jobs(created_at);

ALTER TABLE leads ADD COLUMN import_job_id INTEGER REFERENCES import_jobs(id);

-- ==================== DUPLICATE REVIEWS ======================
CREATE TABLE duplicate_reviews (
  id           INTEGER PRIMARY KEY,
  entity       TEXT NOT NULL CHECK (entity IN ('LEAD','CUSTOMER')),
  entity_id    INTEGER NOT NULL,
  candidate_id INTEGER NOT NULL,
  reason       TEXT,
  score        TEXT,
  status       TEXT NOT NULL DEFAULT 'OPEN'
               CHECK (status IN ('OPEN','KEPT_SEPARATE','MERGED','LINKED','IGNORED')),
  decided_by   INTEGER REFERENCES users(id),
  decided_at   TEXT,
  metadata     TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_dup_status ON duplicate_reviews(status, created_at);
CREATE INDEX idx_dup_entity ON duplicate_reviews(entity, entity_id);

ALTER TABLE customers ADD COLUMN merged_into_id INTEGER REFERENCES customers(id);

-- =================== AUTOMATION SUPPORT ======================
ALTER TABLE users ADD COLUMN skills TEXT NOT NULL DEFAULT '[]';
ALTER TABLE follow_ups ADD COLUMN reminder_sent_at TEXT;
ALTER TABLE follow_ups ADD COLUMN overdue_reminder_sent_at TEXT;
CREATE INDEX idx_fu_reminder ON follow_ups(overdue_reminder_sent_at, scheduled_date);
`,
  },
];

