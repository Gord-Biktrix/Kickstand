# Biktrix Pickup Program — Vancouver Pilot

**Technical specification · v0.1 · 3 September 2026 · Draft for build**

| | |
|---|---|
| Owner | Gordon (RevOps), Biktrix |
| Pilot site | Biktrix Vancouver, 2825 Grandview Hwy, Vancouver BC V5M 2E1 · Tue–Sat |
| Timezone | `America/Vancouver` (all customer-facing times; storage in UTC) |
| Companion | "Biktrix Pickup Program" design page (v0.1 concept) — this spec supersedes it where they differ |

---

## 0. Summary

A small web app that runs showroom pickups for pre-order bikes. **A bike is built only for a booked pickup slot, never for a queue.** When a customer's box is received at the showroom, staff tag it to the order and send an invite. The customer books a pickup time from a calendar; slots are **first come, first served**; each day has a **configurable number of pickups, X**, set per weekday with per-date overrides. Two dates run from the invite: **book by day 14, pick up by day 21**. After those, a unit can be reassigned to a waiting customer (release rule) and storage accrues (storage fee). Both rules are feature-flagged so the pilot can start with booking only.

The pilot runs at Vancouver only. The data model carries `showroom_id` throughout so a second showroom is configuration, not code.

---

## 1. Scope

### 1.1 In scope — P0 (must ship for pilot)

- Staff: receive a box, tag it to an order, send the invite.
- Customer: tokened booking page; pick a slot; confirmation; reschedule; cancel.
- Capacity: X pickups per day, per weekday template + per-date overrides (incl. 0 = closed); slot window and length; minimum lead time; booking horizon.
- Clock: book-by and pick-up-by dates per unit; nudges on days 3, 7, 10, 14; day-before reminder; hold-ending and storage-started notices.
- Staff: today's pickups with handover checklist; build board (what to build today); watchlist (unbooked 7+, hold ending, overdue, releasable); mark Building / Ready / Picked up; record no-show; grant extension; waive storage.
- Release rule and defer option (behind `release_rule_enabled`).
- Storage accrual and display (behind `storage_fee_enabled`); collection happens in Lightspeed, the app records the amount.
- Notifications via Klaviyo events (email + SMS through Klaviyo flows).
- Manual order entry and CSV import of existing pre-orders.
- Settings UI for capacity and program parameters.
- Reports: the seven pilot metrics (§11).

### 1.2 P1 (build if time allows during pilot)

- Multi-unit bookings for one customer at the same slot.
- Slack summary of the daily clock run.
- Early-bird reward tracking (`early_bird_enabled`): flag units booked within 72 h so staff apply the reward at handover.
- Call-task list for day-10 phone calls (P0 is a watchlist row; P1 is a dedicated queue with outcome logging).

### 1.3 Out of scope for the pilot

- Payments in-app (balance and storage are collected in Lightspeed at handover).
- Lightspeed, Shopify, Odoo integrations (§12 describes the seams; not built for pilot).
- Customer accounts or sign-in (customers use tokened links only).
- Multi-showroom UI (data model supports it; UI is scoped to one showroom by config).

### 1.4 Assumptions

- Vancouver has one tech and one or two floor staff on any open day.
- Units are already tagged to named orders when they arrive; the app records the tag, it does not allocate.
- Pre-orders are either paid in full or deposit-with-balance; the app stores `payment_status` and `balance_cents` but never charges.
- Klaviyo is the message channel of record and has SMS enabled for the Canadian account.

---

## 2. Glossary

| Term | Meaning |
|---|---|
| **Order** | A customer's purchase of one bike (model, size, colour) for showroom pickup. Source: Lightspeed sale, Shopify order, or manual. |
| **Unit** | A physical boxed bike, identified by box tag or serial, attached to an order once received at the showroom. |
| **Arrival notice / Invite** | The moment staff send the "your bike is here, book your pickup" message. Starts the clock. |
| **Book-by** | Invite + `book_by_days` (default 14). After this an unbooked unit is *releasable*. |
| **Pick-up-by** | Invite + `pickup_by_days` (default 21). After this storage accrues. |
| **Capacity (X)** | Maximum pickups that may be booked on a calendar day. |
| **Slot** | A start time within the day's pickup window, at `slot_minutes` intervals, that can hold up to `max_concurrent` bookings. |
| **Window** | The hours on a day during which pickups may start. |
| **Appointment** | One unit booked into one slot. |
| **Waitlist** | Open orders at the showroom that have no unit attached. |
| **Releasable** | Unit past book-by with no active appointment, eligible for reassignment when a waitlist order matches model/size/colour. |
| **Re-tag** | Moving a unit from one order to another (release rule or defer). |
| **Defer** | Customer-initiated: give up this unit, keep the order, take a unit from the next shipment. |
| **Overdue** | Unit past pick-up-by and not picked up. |

---

## 3. Business rules (normative)

Each rule has a settings key (§14). Defaults are the pilot's starting values; managers can change them in Settings without a deploy.

| # | Rule | Default | Key |
|---|---|---|---|
| R1 | A unit is placed on the build board only when it has an appointment. Units without appointments are never built (demo/floor stock is outside this app). | — | — |
| R2 | Booking is first come, first served. Order date has no effect on slot availability. | — | — |
| R3 | Each calendar day has a capacity X. Bookings on a day may not exceed X. X = per-date override if present, else weekday template. X = 0 means closed. | Tue–Fri 3, Sat 6, Sun–Mon 0 | `capacity.weekly`, `capacity.overrides` |
| R4 | Slots start at `slot_minutes` intervals within the day's window; a slot may hold up to `max_concurrent` bookings. | 45 min; Tue–Fri 12:00–17:15, Sat 11:00–17:15; max_concurrent 1 | `slot_minutes`, `capacity.weekly[].window`, `max_concurrent` |
| R5 | Earliest bookable slot is `min_lead_hours` from now. | 48 h | `min_lead_hours` |
| R6 | Slots are offered up to `booking_horizon_days` after the invite. | 42 days | `booking_horizon_days` |
| R7 | Book-by = invite + `book_by_days`. Pick-up-by = invite + `pickup_by_days`. Both are stored on the unit at invite time and only change via extension. | 14 / 21 days | `book_by_days`, `pickup_by_days` |
| R8 | Reschedule and cancel are free until `reschedule_cutoff_hours` before the slot. Inside the cutoff, a reschedule or cancel is recorded as a no-show. | 24 h | `reschedule_cutoff_hours` |
| R9 | No-show: appointment → `no_show`; unit keeps its build state; customer must rebook (FCFS). A second no-show on the same unit sets `storage_from = now` regardless of pick-up-by. | — | — |
| R10 | **Storage** (flag `storage_fee_enabled`, and only when the order's `terms_version ≥ 2`): accrues from the day after pick-up-by at `storage_rate_cents` per day, capped at `storage_cap_cents`. Displayed to customer on any slot past pick-up-by and on the manage page. Collected in Lightspeed at handover; staff enter the collected or waived amount. | $10/day, cap $150 | `storage_fee_enabled`, `storage_rate_cents`, `storage_cap_cents` |
| R11 | **Release** (flag `release_rule_enabled`): a unit is releasable when now > book-by, it has no active appointment, and its status is `invited` (a built bike sitting in `ready` after a no-show is not releasable; it stays with its customer). Staff may re-tag a releasable unit to a waitlist order with the same model, size and colour. The original order becomes `deferred` and keeps its `order_date` for priority at the next arrival. Both customers are notified. | off at pilot start | `release_rule_enabled` |
| R12 | **Defer**: a customer with an invited or booked unit may, from the manage page, defer to the next shipment at no charge. The unit becomes `unassigned`; the order becomes `deferred`. Any appointment is cancelled without penalty. | on | `defer_enabled` |
| R13 | **Extension**: a manager may extend book-by and pick-up-by together by `extension_days`, once per unit, with a reason. A second extension requires the admin role. | 7 days | `extension_days` |
| R14 | Deposit orders follow the same clock. A unit is also releasable when the order is a deposit order, unbooked, and `balance_cents > 0` at book-by. Balance is due at handover; the app shows it, Lightspeed collects it. | — | — |
| R15 | Early-bird (flag `early_bird_enabled`): if the first booking is created within `early_bird_hours` of the invite, the unit is flagged `early_bird = true` for staff to apply the reward at handover. The reward does not change slot rules. | 72 h; off at pilot start | `early_bird_enabled`, `early_bird_hours`, `early_bird_reward_text` |
| R16 | Custom/powder-coat orders: staff receive the unit only when finishing is complete; the clock cannot start before that because it starts at invite. | — | — |
| R17 | All customer-facing dates and times are computed and displayed in `America/Vancouver`. Day boundaries for the clock are local midnight. | — | `showroom.timezone` |
| R18 | Orders with `terms_version = 1` (bought under the current terms) are never charged storage and are never released without the customer's agreement (staff must tick "customer agreed" and give a reason). New orders default to version 2 only once `terms_v2_effective_date` is set and the order date is on or after it. | null | `terms_v2_effective_date` |

---

## 4. Roles and access

| Role | Who | Can |
|---|---|---|
| `staff` | Vancouver floor staff and tech | Receive/tag units, send invites, view calendar and build board, mark building/ready/picked up, record no-show, view watchlist |
| `manager` | Vancouver showroom manager | Everything staff can, plus: edit capacity and overrides, grant extensions, waive storage, re-tag units (release), import CSV, edit program settings |
| `admin` | Gordon / HQ | Everything, across showrooms; second extensions; reports; feature flags |
| Customer | Anyone holding a valid unit token | View their unit, book, reschedule, cancel, defer. No sign-in. |

Staff sign in with magic links (email) restricted to an allow-listed domain (`biktrix.com`) and an allow-list of addresses for the pilot. Sessions expire after 30 days; magic links after 15 minutes.

---

## 5. Data model

Postgres. UUID primary keys (`gen_random_uuid()`), `created_at`/`updated_at timestamptz` on every table (omitted below). Money in integer cents. Times in `timestamptz`; calendar dates in `date`.

```sql
create table showrooms (
  id uuid primary key,
  slug text unique not null,              -- 'vancouver'
  name text not null,                     -- 'Biktrix Vancouver'
  timezone text not null,                 -- 'America/Vancouver'
  address_line text not null,             -- for messages
  phone text,
  settings jsonb not null default '{}'    -- program parameters, see §14
);

create table staff_users (
  id uuid primary key,
  email text unique not null,
  name text not null,
  role text not null check (role in ('staff','manager','admin')),
  showroom_id uuid references showrooms(id),   -- null for admin = all
  active boolean not null default true
);

create table capacity_rules (               -- weekly template
  id uuid primary key,
  showroom_id uuid not null references showrooms(id),
  weekday smallint not null check (weekday between 0 and 6),   -- 0 = Sunday
  capacity smallint not null check (capacity >= 0),            -- X; 0 = closed
  window_start time not null,               -- local time
  window_end time not null,                 -- local time; last slot must END by this
  max_concurrent smallint not null default 1,
  unique (showroom_id, weekday)
);

create table capacity_overrides (           -- per-date exceptions
  id uuid primary key,
  showroom_id uuid not null references showrooms(id),
  on_date date not null,
  capacity smallint not null check (capacity >= 0),
  window_start time,                        -- null = use template
  window_end time,
  max_concurrent smallint,
  note text,                                -- 'Labour Day', 'container day'
  unique (showroom_id, on_date)
);

create table orders (
  id uuid primary key,
  showroom_id uuid not null references showrooms(id),
  order_ref text not null,                  -- Lightspeed sale # / Shopify # / manual ref
  source text not null check (source in ('lightspeed','shopify','manual')),
  customer_name text not null,
  customer_email text,
  customer_phone text,                      -- E.164
  sms_consent boolean not null default false,
  model text not null,
  size text,
  colour text,
  order_date date not null,
  payment_status text not null check (payment_status in ('paid','deposit')),
  balance_cents integer not null default 0,
  terms_version smallint not null default 1,   -- 1 = bought under current terms; 2 = new pickup terms
  status text not null default 'open'
    check (status in ('open','deferred','fulfilled','cancelled')),
  deferred_at timestamptz,
  notes text,
  unique (showroom_id, source, order_ref)
);

create table units (
  id uuid primary key,
  showroom_id uuid not null references showrooms(id),
  order_id uuid references orders(id),      -- null when unassigned
  box_tag text not null,                    -- serial or box label
  model text not null, size text, colour text,   -- copied from order at tagging; used for waitlist match
  status text not null default 'received'
    check (status in ('received','invited','booked','building','ready','picked_up','unassigned')),
  received_at timestamptz not null,
  invited_at timestamptz,
  book_by timestamptz,
  pickup_by timestamptz,
  extension_count smallint not null default 0,
  no_show_count smallint not null default 0,
  storage_from timestamptz,                 -- first chargeable day 00:00 local; null if none
  storage_collected_cents integer,          -- entered at handover
  storage_waived_cents integer,
  early_bird boolean not null default false,
  token_hash text unique,                   -- sha256 of the customer link token
  picked_up_at timestamptz,
  unique (showroom_id, box_tag)
);

create table appointments (
  id uuid primary key,
  showroom_id uuid not null references showrooms(id),
  unit_id uuid not null references units(id),
  on_date date not null,                    -- local date, denormalised for capacity counting
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'booked'
    check (status in ('booked','completed','no_show','cancelled')),
  cancelled_reason text,                    -- 'customer','late_change','deferred','staff'
  replaced_by uuid references appointments(id),   -- set when rescheduled
  created_by text not null                  -- 'customer' | staff_user id
);
create index on appointments (showroom_id, on_date) where status = 'booked';
create index on appointments (unit_id) where status = 'booked';

create table day_counters (                 -- concurrency-safe daily capacity counter
  showroom_id uuid not null references showrooms(id),
  on_date date not null,
  booked_count integer not null default 0,
  primary key (showroom_id, on_date)
);

create table events (                       -- append-only audit + message log
  id uuid primary key,
  showroom_id uuid not null,
  unit_id uuid,
  order_id uuid,
  appointment_id uuid,
  type text not null,                       -- see §7.3 and §9.2
  actor text not null,                      -- 'system' | 'customer' | staff_user id
  payload jsonb not null default '{}',
  klaviyo_status text                       -- 'sent','failed', null if not a message
);
create unique index events_dedupe
  on events (unit_id, type, (payload->>'dedupe_key'));   -- prevents double sends
```

Derived (not stored):

- `overdue(unit)` = status ∉ {picked_up, unassigned} ∧ now > pickup_by.
- `releasable(unit)` = `release_rule_enabled` ∧ status = invited ∧ now > book_by ∧ no booked appointment ∧ (order.terms_version ≥ 2 ∨ staff override with agreement).
- `storage_due_cents(unit, at)` = 0 if `storage_from` null or `!storage_fee_enabled` or `order.terms_version < 2`; else `min(cap, rate × days_between(storage_from, at))` counting the `storage_from` day as day 1.
- `waitlist(showroom)` = orders where status = open and no unit references them.

---

## 6. Capacity and availability

### 6.1 Effective capacity for a date

```
effective(date):
  o = capacity_overrides[showroom, date]
  t = capacity_rules[showroom, weekday(date)]
  capacity      = o?.capacity ?? t.capacity            -- X
  window_start  = o?.window_start ?? t.window_start
  window_end    = o?.window_end ?? t.window_end
  max_concurrent= o?.max_concurrent ?? t.max_concurrent
  if capacity == 0 → closed
```

### 6.2 Slot generation

```
slots(unit, date):
  e = effective(date); if closed → []
  now_local = now in showroom tz
  earliest = now + min_lead_hours
  latest_date = invited_at + booking_horizon_days
  if date > latest_date → []
  remaining_day = e.capacity - day_counters[date].booked_count      -- may be 0
  for start = e.window_start; start + slot_minutes <= e.window_end; start += slot_minutes:
    starts_at = localToUtc(date, start)
    if starts_at < earliest → continue
    at_time = count(appointments where starts_at = this and status = 'booked')
    yield {
      starts_at,
      available: remaining_day > 0 and at_time < e.max_concurrent,
      storage_applies: date > local_date(unit.pickup_by),
      storage_estimate_cents: storage_due_cents(unit, date) if storage_applies
    }
```

The customer calendar shows each day with "N of X left" (`remaining_day`/`capacity`) and greys out full or closed days. Times inside a day are listed at `slot_minutes` intervals; a time is disabled when `at_time >= max_concurrent`.

### 6.3 Booking transaction (no overbooking)

All in one database transaction. `read committed` is sufficient because the `UPDATE` in step 2 takes a row lock on the day's counter, so every booking for that day runs one at a time:

```
1. insert into day_counters (showroom_id, on_date, booked_count) values (…, 0) on conflict do nothing
2. update day_counters set booked_count = booked_count + 1
     where showroom_id = ? and on_date = ? and booked_count < :capacity
     returning booked_count
   → if no row returned: day is full → abort with DAY_FULL
3. select count(*) from appointments
     where showroom_id = ? and starts_at = ? and status = 'booked'
   (safe without an explicit lock: step 2 already serialised this day)
   → if count >= max_concurrent: abort with TIME_FULL (rolls back step 2)
4. insert appointment (status 'booked')
5. update unit set status = 'booked' (from invited or ready — see §7)
6. insert event 'booking_confirmed'
7. after commit: send Klaviyo event Pickup: Booked
```

Cancellation and no-show decrement `booked_count` for that date (never below 0). Reschedule = cancel + book in one transaction; the new appointment id is written to `replaced_by` on the old one.

### 6.4 Edge cases

- **DST**: slot times are defined in local time; convert per date with the IANA zone, never with a fixed offset. On the November fall-back day the window still reads 12:00–17:15 local.
- **Window not divisible by slot length**: the last slot is the last start where `start + slot_minutes ≤ window_end`.
- **Override to 0** on a day with existing bookings: allowed; the day shows as closed for new bookings and the watchlist flags the existing appointments as "day closed — contact customer".
- **Capacity lowered below current bookings**: same behaviour; no automatic cancellations.
- **Horizon shorter than pick-up-by**: not permitted; Settings validates `booking_horizon_days ≥ pickup_by_days`.
- **Two units, one customer**: P0 books each unit separately (two tokens, two appointments, two of X). P1 offers "book together" when `max_concurrent ≥ 2` or as back-to-back slots.

---

## 7. Unit lifecycle

### 7.1 States

`received → invited → booked → building → ready → picked_up`, with `unassigned` as the detached state (release/defer) and re-entry to `invited` when attached to another order.

### 7.2 Transitions

| From | To | Trigger | Guard | Side effects |
|---|---|---|---|---|
| — | received | Staff tags a box to an order (Arrivals) | order.status = open; box_tag unique | unit created with received_at = now; copies model/size/colour |
| received | invited | Staff taps Invite (single or batch) | order has email or phone | invited_at = now; book_by, pickup_by computed (R7); token generated; event `invite_sent`; Klaviyo `Pickup: Bike Arrived` |
| invited | booked | Customer books | slot available (§6.3) | appointment created; `early_bird` set if within early_bird_hours (R15); Klaviyo `Pickup: Booked` |
| booked | invited | Customer cancels outside cutoff | — | appointment cancelled (reason customer); counter decremented; Klaviyo `Pickup: Cancelled` |
| booked | booked | Customer reschedules outside cutoff | new slot available | old appointment cancelled + `replaced_by`; new appointment; Klaviyo `Pickup: Rescheduled` |
| booked | booked | Customer cancels/reschedules inside cutoff | — | recorded as no-show (R8): appointment `no_show`, `no_show_count++`, then behaves as customer cancel/reschedule |
| building, ready | same | Customer cancels or reschedules outside cutoff | — | appointment cancelled or replaced; unit keeps its build state; shows as "Built — needs rebooking" until a new appointment exists |
| booked | building | Staff taps Build (build board) | appointment exists | event `build_started` |
| building | ready | Staff taps Ready | — | event `ready`; day-before reminder still sent by clock job |
| ready | picked_up | Staff completes handover | checklist complete; storage/balance amounts entered | appointment completed; picked_up_at; order.status = fulfilled; Klaviyo `Pickup: Completed` |
| ready | ready | Staff records no-show | appointment slot has passed | appointment `no_show`; counter decremented; `no_show_count++`; if `no_show_count ≥ 2` → `storage_from = today` (R9); customer gets `Pickup: Missed` with rebook link |
| ready | booked* | Customer rebooks after no-show | slot available | *unit status stays `ready` (bike is built); appointment created; build board excludes it |
| invited | unassigned | Staff re-tags (release, R11) or customer defers (R12) | releasable, or defer_enabled | order.status = deferred; unit.order_id = null; event `unit_detached` with reason; Klaviyo `Pickup: Deferred` to original customer |
| booked | unassigned | Customer defers | defer_enabled | appointment cancelled (reason deferred), counter decremented; as above |
| unassigned | invited | Staff attaches unit to a waitlist order | same model/size/colour; order.status = open | unit.order_id set; fresh invited_at/book_by/pickup_by/token; Klaviyo `Pickup: Bike Arrived` to new customer; event `unit_reassigned` |
| any (not picked_up) | same | Manager extension (R13) | extension_count < 1 (admin: < 2) | book_by += extension_days; pickup_by += extension_days; storage_from recomputed if not yet chargeable; event `extension_granted` |

### 7.3 Event types (audit)

`unit_received`, `invite_sent`, `booking_confirmed`, `booking_rescheduled`, `booking_cancelled`, `no_show`, `build_started`, `ready`, `picked_up`, `unit_detached`, `unit_reassigned`, `extension_granted`, `storage_waived`, `storage_collected`, `settings_changed`, plus one per message in §9.2 (`msg_*`).

---

## 8. Clock job

- Runs **hourly** via Vercel Cron (`0 * * * *`), endpoint `POST /api/cron/clock`, protected by `CRON_SECRET`. Each run computes local time per showroom and performs the **daily** actions only when local hour = 7 and the day's `clock_ran_on = today` marker is absent (stored in `showrooms.settings.clock_last_run_date`). Hourly runs also send day-before reminders whose local send hour is 17:00.
- Every message is idempotent through `events` unique key `(unit_id, type, dedupe_key)` where `dedupe_key` = the local date (or the appointment id for reminders). Re-running the job never double-sends.
- Age of a unit = whole local days since `invited_at` (invite day = day 0).

Daily actions at 07:00 local, for each unit not `picked_up` / `unassigned`:

| Condition | Action | Klaviyo metric |
|---|---|---|
| status = invited, age = 3 | nudge | `Pickup: Nudge Day 3` |
| status = invited, age = 7 | nudge (SMS) | `Pickup: Nudge Day 7` |
| status = invited, age = 10 | create watchlist call task (P0: row flag `call_due`; P1: call queue) | — |
| status = invited, age = 14 | hold-ending notice with book / defer choices | `Pickup: Hold Ending` |
| now > book_by, status = invited, no appointment | set derived flag; watchlist shows **Releasable** if `release_rule_enabled` and a waitlist match exists | — |
| local date = pickup_by + 1 day, not picked up, `storage_fee_enabled`, terms_version ≥ 2, `storage_from` null | `storage_from = today 00:00 local` | `Pickup: Storage Started` |
| storage running | recompute `storage_due_cents` for display (not stored) | — |
| appointment tomorrow (any status booked) | at 17:00 local: day-before reminder | `Pickup: Reminder Day Before` |
| appointment date passed, status still booked, no staff action by 07:00 next day | watchlist flag "unrecorded outcome" (staff must mark completed or no-show) | — |

The job writes one `clock_run` event per showroom per day with counts (invited, booked, overdue, releasable, messages sent, failures) — the P1 Slack summary posts this payload.

---

## 9. Notifications

### 9.1 Provider

All messages are Klaviyo **events** (Create Event API) on the customer's profile, identified by email and phone. Klaviyo flows own templates, channel logic (email vs SMS) and consent. The app never sends email or SMS directly. Implement behind a `Notifier` interface (`send(metric, profile, properties)`) so a Twilio/Resend fallback is a config change.

- Transactional messages (arrival, confirmation, reminders, notices) are configured in Klaviyo as transactional flows; SMS goes only to profiles with SMS consent. The booking page captures SMS consent with an unticked checkbox ("Text me reminders about this pickup") and writes `orders.sms_consent`; the app passes `sms_consent` as a profile property.
- Failures (non-2xx) are retried 3× with backoff; a final failure writes `events.klaviyo_status = 'failed'` and shows on the watchlist as "message failed".

### 9.2 Event catalog

Common properties on every event: `showroom`, `showroom_address`, `showroom_phone`, `order_ref`, `model`, `size`, `colour`, `booking_url`, `manage_url`, `book_by_date`, `pickup_by_date` (local, formatted `Saturday 12 September`), `payment_status`, `balance_display` (e.g. `$1,250.00` or empty), `terms_version`, `sms_consent`.

| Metric | When | Extra properties |
|---|---|---|
| `Pickup: Bike Arrived` | Invite | `early_bird_deadline` (if enabled), `reward_text`, `days_left_display` |
| `Pickup: Booked` | Booking created | `slot_start_local`, `slot_end_local`, `calendar_ics_url`, `storage_estimate_display` (if slot past pick-up-by) |
| `Pickup: Rescheduled` | Reschedule | old and new `slot_start_local` |
| `Pickup: Cancelled` | Customer cancel | `days_left_display` |
| `Pickup: Reminder Day Before` | 17:00 local day before | `slot_start_local`, `bring_list` |
| `Pickup: Nudge Day 3` | Clock | `remaining_saturday_display` (e.g. `2 of 6`) |
| `Pickup: Nudge Day 7` | Clock | `pickup_by_date` |
| `Pickup: Hold Ending` | Clock day 14 | `storage_rate_display`, `storage_cap_display`, `defer_url` |
| `Pickup: Storage Started` | Clock | `storage_rate_display`, `storage_cap_display`, `storage_due_display` |
| `Pickup: Missed` | Staff records no-show | `rebook_url`, `second_missed` (bool) |
| `Pickup: Deferred` | Defer / release | `reason` (`customer_deferred` \| `released`), `next_shipment_eta` (free text from staff) |
| `Pickup: Completed` | Handover | `picked_up_at_local`; flows send thanks + 2-day follow-up |

### 9.3 Copy deck (Klaviyo templates; example values for Vancouver)

See Appendix B: twelve templates, one per metric above. The day-10 touch is a phone call from staff, not a message.

---

## 10. Screens and routes

### 10.1 Customer (no sign-in)

**`GET /b/[token]` — Your bike**
State-aware landing page.

- `invited`: arrival card (model, colour, showroom address, "we hold your bike free until {pickup_by_date}"), primary button **Book your pickup**, secondary "Can't make it in time? Options" (defer if enabled).
- `booked`: appointment card (date, time, address, what to bring), buttons **Reschedule**, **Cancel**, "Add to calendar" (.ics), storage note if applicable.
- `building` / `ready`: same as booked plus "Your bike is built and charging".
- `ready` with no appointment (after no-show): "You missed your pickup — book a new time", rebook button; storage note if `storage_from` set.
- `picked_up`: thanks page.
- `unassigned` / order deferred: "Your order is reserved from our next shipment; we'll invite you when it lands."
- Invalid or expired token: friendly error with showroom phone.

**`GET /b/[token]/book` — Pick a slot**
Month/week calendar showing each open day with `N of X left`; closed days greyed; days past pick-up-by carry a small "storage applies" tag with the estimate. Selecting a day lists times; selecting a time opens confirmation with SMS-consent checkbox and the R8 cutoff stated plainly. Submit → §6.3 transaction → confirmation page. Errors: `DAY_FULL` / `TIME_FULL` re-render the calendar with a one-line explanation.

**`GET /b/[token]/manage` — Reschedule, cancel, defer**
Reschedule reuses the picker. Cancel and defer require a confirm step. Inside the cutoff, the page says the change counts as a missed pickup before the customer confirms.

Acceptance criteria (P0):

- A customer with a valid token can book, receive confirmation, reschedule, and cancel, all without signing in.
- A day at capacity shows as full and cannot be booked even under concurrent attempts (two simultaneous bookings for the last slot: exactly one succeeds).
- No slot is offered earlier than `min_lead_hours` from now or beyond the horizon.
- Slots past pick-up-by show the storage estimate before the customer commits (when storage is enabled for that order).
- Every page is usable on a 360 px wide phone and meets WCAG 2.1 AA contrast.

### 10.2 Staff

**`/app` — Today**
Today's appointments in time order with unit, customer, model/colour, payment status and balance, storage due, `early_bird` badge, and a **Start handover** button that opens the checklist (fit; display and modes; app pairing; charging routine; accessories; warranty registration; balance collected in Lightspeed; storage collected/waived with amount and reason; photo optional). **Complete** → `picked_up`. **No-show** available once the slot start has passed.

**`/app/arrivals` — Receive and invite**
Left: search/select order (by name, ref, phone) or **New order** form (fields in §5 `orders`; `terms_version` defaults from `terms_v2_effective_date`: 2 when `order_date` is on or after it, otherwise 1; editable per order). Deferred orders for the same model/size/colour are pinned to the top with a "waiting since" note. Right: enter box tag → **Receive**. List of received-not-invited units with **Invite** per row and **Invite all**. CSV import (manager) per Appendix A with a preview and row-level errors.

**`/app/build` — Build board**
The queue of every unit with a `booked` appointment that has not been built yet (status `booked`), sorted by appointment start. Each row carries a **build-by** date = the last open day before the appointment (open days come from the capacity template and overrides, so with Sunday and Monday closed a Tuesday appointment is build-by Saturday). Rows with build-by today or earlier are highlighted; the tech may pull any row forward (build Saturday's bikes on Thursday and Friday, for instance). A second group, **Built, waiting**, lists `building` and `ready` units with their appointment; a third, **Built — needs rebooking**, lists `ready` units with no appointment. Buttons: **Build** (→ building), **Ready** (→ ready).

**`/app/watchlist` — Needs attention** (manager view; staff read-only)
Sections with counts: Unbooked 7+ days (with **Call** flag at day 10), Hold ending this week, Overdue (storage running, amount due), Releasable (unit + matching waitlist order, **Re-tag** button requiring reason and, for terms v1, an "agreed with customer" tick), Unrecorded outcomes, Message failures, Day-closed conflicts. Row actions: **Extend** (reason required), **Waive storage** (amount + reason), **Send invite again**.

**`/app/units/[id]` and `/app/orders/[id]` — Detail**
Full timeline from `events`, current clock dates, appointment history, storage computation, the customer's link (copy button), manual notes.

**`/app/settings/capacity` — Capacity (manager)**
Weekly template editor: per weekday, X, window start/end, max concurrent; closed toggle sets X = 0. Calendar of overrides: click a date to set X (0 = closed), window, note. Shows booked counts against X for the next 8 weeks so a lowered X is visible immediately.

**`/app/settings/program` — Program (manager; flags admin-only)**
All keys in §14 with validation (`booking_horizon_days ≥ pickup_by_days`, `min_lead_hours ≥ slot_minutes/60`, rates non-negative). Change log via `settings_changed` events.

**`/app/reports` — Pilot metrics (admin)**
§11 metrics for a date range, plus CSV export of units and appointments.

Acceptance criteria (P0):

- Receiving a unit and sending the invite takes ≤ 3 clicks after the order is selected; the customer's message arrives within 60 s (Klaviyo event accepted).
- The build board lists exactly the units with `booked` appointments and no build yet, sorted by appointment start, each with a correct build-by date (last open day before the appointment, honouring overrides).
- A manager can change tomorrow's X and see the customer calendar reflect it immediately.
- Every extension, waiver, re-tag and settings change is in the unit/order timeline with actor and reason.
- Staff without the manager role cannot see the Extend, Waive, Re-tag or Settings actions (server-enforced, not just hidden).

### 10.3 API surface

Server actions for all staff and customer mutations (Next.js). HTTP routes only for: `POST /api/cron/clock` (CRON_SECRET), `GET /api/ics/[appointmentId]` (calendar file, unauthenticated by unguessable id), `GET /api/health`.

---

## 11. Reports and pilot metrics

| Metric | Definition | Pilot target |
|---|---|---|
| Floor-days of built, unclaimed bikes | Σ over units of days between `ready` and `picked_up` minus 1 | < 2 per unit average |
| Box-days arrival → pickup | median of `picked_up_at − received_at` | ≤ 10 days |
| Booked within 72 h | % of invited units with first booking ≤ 72 h after invite | ≥ 60 % |
| Days to fill Saturday | for each Saturday: days from first invite of the week until `booked_count = X` | tracked; informs X |
| No-show + late-change rate | (no_show appointments) / (appointments reaching their date) | < 5 % |
| Storage assessed vs waived | Σ storage_due at handover vs Σ waived | tracked; high waiver ⇒ revisit window or fee |
| Releases and defers | count of `unit_detached` by reason; time from detach to reassignment | tracked |

Also: slot utilisation (booked / X) by weekday, invites per week, message failure rate.

---

## 12. Integration seams (not built for pilot)

| System | Pilot | Later |
|---|---|---|
| **Lightspeed R-Series** | Staff type orders; `source = lightspeed`, `order_ref` = sale/ticket number | Hourly poll of `Sale`/`SaleLine` for open special-order and layaway lines by shop and customer (R-Series has no webhooks); Custom Button on the special-order screen launching `/app/arrivals?saleID=…&customerID=…`; storage posted back as an item-fee `SaleLine` at completion |
| **Lightspeed X-Series** | same | `sale.update` webhook for sales with `pickup`/`layby` attributes; storage fee as a catalogue product line on the open sale |
| **Shopify** | Staff type orders; `source = shopify` | `orders/create` webhook filtered to pickup location; suppress Shopify's ready-for-pickup email in favour of the app invite |
| **Odoo** | — | Receipt of an internal transfer at the showroom location marks the unit `received` |
| **Klaviyo** | Events out (P0) | — |
| **Slack** | — | P1 daily clock summary via incoming webhook |

Keep `source`, `source_ref`/`order_ref` and `box_tag` as the join keys.

---

## 13. Non-functional requirements

- **Security**: customer tokens are 32 random bytes, base64url in the URL, stored as SHA-256; token invalid 30 days after `picked_up`. Rate-limit `/b/*` to 60 req/min per IP. Staff auth via magic link + domain allow-list; role checks on the server for every mutation. `CRON_SECRET` on the cron route. No PII in logs (log ids only).
- **Privacy** (PIPEDA / BC PIPA): store only name, email, phone, order details. Retention: purge `customer_email`, `customer_phone`, `customer_name` from orders fulfilled or cancelled > 24 months ago (job, P1). Consent for SMS captured explicitly. Data hosted in a Canadian or US region as the Neon/Vercel account allows; document the choice.
- **Accessibility**: WCAG 2.1 AA; keyboard-operable slot picker; visible focus; labels on every control; error text tied to fields.
- **Performance**: booking page interactive < 2 s on 4G; availability computation ≤ 200 ms for a 6-week horizon (one query for counters, one for appointments in range).
- **Reliability**: booking transaction per §6.3; Neon point-in-time recovery enabled; clock job idempotent; message sends retried; every send and failure logged.
- **Observability**: structured logs (pino), request ids; Sentry optional; `/api/health` checks DB and Klaviyo key presence.
- **Localisation**: en-CA; 12-hour times with am/pm; dates as `Saturday 12 September`; currency CAD.

---

## 14. Configuration

### 14.1 Environment

```
DATABASE_URL=            # Neon, pooled
AUTH_SECRET=             # Auth.js
AUTH_EMAIL_FROM=pickups@biktrix.com
AUTH_ALLOWED_DOMAIN=biktrix.com
AUTH_ALLOWED_EMAILS=     # comma list for pilot
KLAVIYO_PRIVATE_KEY=
KLAVIYO_REVISION=        # pin the API revision date you test against
CRON_SECRET=
APP_BASE_URL=https://pickup.biktrix.com
DEFAULT_SHOWROOM=vancouver
```

### 14.2 Vancouver seed (`showrooms.settings`)

```json
{
  "slot_minutes": 45,
  "min_lead_hours": 48,
  "booking_horizon_days": 42,
  "book_by_days": 14,
  "pickup_by_days": 21,
  "reschedule_cutoff_hours": 24,
  "extension_days": 7,
  "storage_fee_enabled": false,
  "storage_rate_cents": 1000,
  "storage_cap_cents": 15000,
  "release_rule_enabled": false,
  "defer_enabled": true,
  "early_bird_enabled": false,
  "early_bird_hours": 72,
  "early_bird_reward_text": "free installation of accessories bought with your bike",
  "reminder_send_hour_local": 17,
  "clock_run_hour_local": 7,
  "terms_v2_effective_date": null
}
```

`terms_v2_effective_date` stays `null` until the Appendix C paragraph is live at checkout; set it to that date and every order placed from then on defaults to `terms_version = 2` (storage and release eligible).

Capacity template seed (X per day; edit in Settings):

| Weekday | X | Window | Max concurrent |
|---|---|---|---|
| Sun, Mon | 0 (closed) | — | — |
| Tue–Fri | 3 | 12:00–17:15 | 1 |
| Sat | 6 | 11:00–17:15 | 1 |

Showroom row: `slug vancouver`, `name Biktrix Vancouver`, `timezone America/Vancouver`, `address_line 2825 Grandview Hwy, Vancouver, BC V5M 2E1`, `phone 1-866-245-8749 ext. 803`.

---

## 15. Stack, milestones, go-live

**Stack**: Next.js (current stable, App Router, TypeScript, server actions), Postgres on Neon, Drizzle ORM + migrations, Auth.js (email magic link), Tailwind, Zod, date-fns-tz (or Temporal polyfill) for `America/Vancouver`, Vercel Cron, Klaviyo Events API, pino. Tests: Vitest for availability/booking/clock logic (pure functions over an in-memory or test DB), Playwright for the customer booking flow.

| Milestone | Contents | Done when |
|---|---|---|
| M1 Core booking | schema, auth, showroom seed, arrivals + invite, customer landing + booking + manage, capacity template/overrides + Settings, Klaviyo `Bike Arrived` / `Booked` / `Rescheduled` / `Cancelled` | a staff member receives a test unit, the invite lands, the customer books, and a second concurrent booking for the last slot fails cleanly |
| M2 Clock and reminders | clock job, nudges, hold-ending, day-before reminder, idempotency, watchlist sections for unbooked/hold-ending/unrecorded | replaying the job for the same day sends nothing twice; every message type verified in Klaviyo |
| M3 Floor operations | today view + handover checklist, build board, no-show, extension, storage display/accrual (flag), release/defer (flag), waitlist match | full lifecycle demonstrable end to end with storage and release flags on in staging |
| M4 Reports and hardening | reports, CSV export, rate limits, accessibility pass, Sentry, runbook | metrics match hand-counted values for the staging data set |

**Go-live checklist (Vancouver)**

1. Capacity template and holiday overrides entered; `X` confirmed per weekday.
2. Twelve Klaviyo flows built and test-sent to a staff phone; SMS consent branch verified.
3. Existing pre-orders imported with `terms_version = 1`.
4. Pickup terms paragraph (Appendix C) live at checkout and in the confirmation email → new orders get `terms_version = 2`.
5. Staff briefed: receive → invite → build board → handover → watchlist. Manager briefed on extensions and X.
6. Flags at go-live: `storage_fee_enabled = false`, `release_rule_enabled = false`, `defer_enabled = true`. Review at week 2; enable storage for v2 orders when the terms have been live for the full pre-order cycle.
7. Reports baseline captured (floor-days of built bikes today, by hand).

---

## 16. Open decisions

| # | Decision | Proposed | Needed by |
|---|---|---|---|
| D1 | X per weekday for Vancouver | Tue–Fri 3, Sat 6 | M1 |
| D2 | Window hours (posted hours are Tue–Sat 11–6) | Tue–Fri 12:00–17:15, Sat 11:00–17:15 | M1 |
| D3 | `max_concurrent` on Saturdays | 1, raise to 2 if two floor staff are rostered | M1 |
| D4 | Klaviyo transactional SMS vs Twilio | Klaviyo, behind `Notifier` | M1 |
| D5 | Turn storage on at go-live for `terms_version = 2` orders, or after week 2 | after week 2 | go-live |
| D6 | Turn release rule on during pilot | on at week 2 if a waitlist exists | week 2 |
| D7 | Early-bird reward and whether to enable in pilot | free accessory install; enable at go-live if agreed | go-live |
| D8 | Who runs day-10 phone calls | showroom staff; Retell agent later | M2 |
| D9 | Data region for Neon/Vercel | nearest available to Vancouver | M1 |
| D10 | Customer-facing name | "Book your pickup" only | M1 |

---

## Appendix A — CSV import (existing pre-orders)

UTF-8, header row required. One row per bike (a customer with two bikes = two rows).

```
order_ref,source,customer_name,customer_email,customer_phone,model,size,colour,order_date,payment_status,balance_cents,notes
LS-48213,lightspeed,Jane Doe,jane@example.com,+16045550123,Juggernaut Ultra Beast 2,Regular,Matte Black,2026-06-14,deposit,125000,wants rack installed
SH-100421,shopify,Sam Lee,sam@example.com,+17785550199,Swift Step-Thru,One size,Sage,2026-07-02,paid,0,
```

Validation: `source ∈ {lightspeed, shopify, manual}`; `payment_status ∈ {paid, deposit}`; phone normalised to E.164 (assume +1 if 10 digits); `order_date` ISO; duplicates on `(source, order_ref)` are rejected with a row error. Imported rows get `terms_version = 1` and `status = open`.

## Appendix B — Message copy (Klaviyo templates)

Placeholders in braces map to §9.2 properties.

1. **Bike Arrived** — SMS: "Your {model} is at Biktrix Vancouver! Book your pickup and we'll have it built, charged and fitted for you: {booking_url}. We hold it free until {pickup_by_date}." Email subject: "Your {model} has arrived — book your pickup". Body adds address, what happens at handover, hold window, and (if enabled) "Book by {early_bird_deadline} and get {reward_text}."
2. **Booked** — Email subject: "You're booked: {slot_start_local}". Body: date/time, address, bring ID and helmet, 45-minute handover, balance due if any, storage estimate if any, Reschedule/Cancel link, .ics. SMS: "Booked: {slot_start_local} at Biktrix Vancouver. Change it here: {manage_url}".
2a. **Rescheduled** — SMS + email: "Updated: your pickup is now {slot_start_local} at Biktrix Vancouver. Change it again here: {manage_url}".
2b. **Cancelled** — Email: "Your pickup on {slot_start_local} is cancelled. Your bike stays reserved; book a new time before {pickup_by_date}: {booking_url}."
3. **Reminder Day Before** — SMS: "Tomorrow {slot_start_local} at Biktrix Vancouver, 2825 Grandview Hwy. Your bike is built and charging. Need to change it? {manage_url}".
4. **Nudge Day 3** — Email subject: "Saturday is filling up". Body: "{remaining_saturday_display} Saturday slots left this week. Book your pickup: {booking_url}."
5. **Nudge Day 7** — SMS: "Your bike has been waiting a week at Biktrix Vancouver. Free hold ends {pickup_by_date}. Book: {booking_url}".
6. **Hold Ending** — Email + SMS: "Your free hold ends {pickup_by_date}. Book now: {booking_url}. Can't make it? Pick up later with storage at {storage_rate_display} (max {storage_cap_display}), or move to our next shipment at no charge: {defer_url}."
7. **Storage Started** — Email: "Storage of {storage_rate_display} per day started today (max {storage_cap_display}), payable at pickup. Book your pickup: {booking_url}."
8. **Missed** — SMS: "We missed you today. Your bike is built and waiting — book a new time: {rebook_url}." (if `second_missed`: add "Storage now applies at {storage_rate_display}/day.")
9. **Completed** — Email: thanks, first-ride tips, battery care; 2-day follow-up with review ask (Klaviyo time delay).

Deferred (customer or release): Email: "Your order is reserved from our next shipment{next_shipment_eta}. You keep your place in line and we'll invite you the moment it lands."

## Appendix C — Pickup terms paragraph (v2, for checkout and confirmation)

> **Showroom pickup.** Showroom pickup is by appointment. When your bike arrives at your chosen showroom we will invite you to book a pickup time; slots are offered first come, first served, and the number of pickups each day is limited. We hold your bike at no charge for 21 days from the arrival notice. After that, storage of $10 per day (to a maximum of $150) applies and is payable at pickup. If you have not booked within 14 days of the arrival notice and another customer is waiting for the same bike, we may assign your unit to them and reserve one for you from our next shipment; your order keeps its place in line and we will tell you the expected date. You may also choose, at any time and at no charge, to move your order to our next shipment.

Not legal advice: have counsel review before it goes live, particularly the reassignment clause and disclosure placement (BC's consumer-contract disclosure rules changed on 1 August 2026).
