# Klaviyo flows for the Pickup Program

Kickstand fires one event per customer message (metric names below). Klaviyo flows own the wording and
channel. Build each flow as **Trigger: metric** → optional filter → **SMS** (and, where noted, an email).
Every event carries the properties in "Always available"; each metric adds a few more.

**Settings that matter**
- Mark every SMS in these flows **Transactional** (message settings → "This is a transactional message").
  Kickstand registers customers' consent as *transactional* SMS consent when they tick "agrees to text
  reminders"; marketing-only flows would not reach them.
- Turn **Smart Sending off** on every message — these are one-off operational notices, not a campaign.
- **Quiet hours:** leave on for nudges and hold-ending; turn off for Booked / Rescheduled / Cancelled so a
  confirmation lands while the customer is still at the counter.
- Sender: the Vancouver shop number if you have one in Klaviyo; otherwise the shared Biktrix number.

**Always available on every event** (`{{ event.<name> }}`)
`showroom`, `showroom_address`, `showroom_phone`, `order_ref`, `model`, `size`, `colour`, `booking_url`,
`manage_url`, `rebook_url`, `landing_url`, `book_by_date`, `pickup_by_date`, `payment_status`,
`balance_display` (empty when paid), `terms_version`, `storage_rate_display`, `storage_cap_display`.
Use `{{ person.first_name|default:"there" }}` for the name.

Links are long; let Klaviyo shorten them (message setting "Shorten links").

---

## 1. Pickup: Bike Arrived  — the invite (unit received, link minted)
Extra: none beyond the common set.

**SMS**
> Biktrix: hi {{ person.first_name|default:"there" }}, your {{ event.model }} has arrived at {{ event.showroom }}!
> Pick your collection time here: {{ event.booking_url }}
> Please book by {{ event.book_by_date }}. Reply STOP to opt out.

**Email** (subject: *Your {{ event.model }} is here — pick your collection time*)
Same content, plus what happens at pickup (fit, 21-point check, ~30 min) and the free hold until
`{{ event.pickup_by_date }}`. Button → `booking_url`.

## 2. Pickup: Booked
Extra: `slot_start_local`, `slot_end_local`, `calendar_ics_url`, `storage_estimate_display`.

**SMS** (quiet hours OFF)
> Biktrix: you're booked to collect your {{ event.model }} on {{ event.slot_start_local }} at {{ event.showroom }}, {{ event.showroom_address }}.
> {% if event.balance_display %}Balance due at pickup: {{ event.balance_display }}. {% endif %}Change or cancel: {{ event.manage_url }}

**Email** (subject: *Booked: {{ event.slot_start_local }}*) — add the calendar link `calendar_ics_url`,
what to bring, and the balance line if present.

## 3. Pickup: Reminder Day Before
Extra: `slot_start_local`, `bring_list`, `built` (true/false).

**SMS**
> Biktrix: see you tomorrow, {{ event.slot_start_local }}, for your {{ event.model }} at {{ event.showroom }}.
> Bring: {{ event.bring_list }}. Need to change it? {{ event.manage_url }}

## 4. Pickup: Rescheduled
Extra: `old_slot_start_local`, `slot_start_local`, `slot_end_local`, `late_change`, `calendar_ics_url`.

**SMS** (quiet hours OFF)
> Biktrix: your pickup has moved to {{ event.slot_start_local }} (was {{ event.old_slot_start_local }}).
> Manage: {{ event.manage_url }}

## 5. Pickup: Cancelled
Extra: `cancelled_by` (`customer` or `shop`), `slot_start_local`, `days_left_display`, `late_change`.
Use a **conditional split on `event.cancelled_by`**:

**SMS — `cancelled_by` = shop** (quiet hours OFF)
> Biktrix: sorry — we've had to cancel your pickup on {{ event.slot_start_local }}. Your {{ event.model }} is safe with us.
> Please pick a new time: {{ event.rebook_url }}

**SMS — `cancelled_by` = customer**
> Biktrix: your pickup on {{ event.slot_start_local }} is cancelled. Your {{ event.model }} is held until {{ event.pickup_by_date }} — rebook any time: {{ event.rebook_url }}

## 6. Pickup: Missed  — no-show recorded
Extra: `slot_start_local`, `no_show_count`.

**SMS**
> Biktrix: we missed you at {{ event.slot_start_local }}. Your {{ event.model }} is still here — book a new time: {{ event.rebook_url }}
> Free hold ends {{ event.pickup_by_date }}.

---

## Later (build once the six above are live)
- **Pickup: Nudge Day 3 / Nudge Day 7** — "still time to book" with `remaining_saturday_display`.
- **Pickup: Hold Ending** — the free hold ends `pickup_by_date`; storage `storage_rate_display` after that (terms v2 only — filter on `event.terms_version` = 2).
- **Pickup: Storage Started** — daily rate now applies; `storage_rate_display`, `storage_cap_display`.
- **Pickup: Deferred** — confirmation that the order moved to the next shipment.
- **Pickup: Completed** — thank-you after handover; a good place for the review ask.

## Checking it works
1. Book a test bike with your own phone (tick "agrees to text reminders").
2. Klaviyo → Profiles → search your number: the profile shows SMS transactional consent and a
   "Pickup: Booked" event under Activity.
3. Klaviyo → Analytics → Metrics: "Pickup: …" metrics appear after the first event of each kind.
4. Kickstand bike page → Timeline: each message row shows `sent` (Klaviyo accepted the event) or `failed`
   (see Alerts → Message failures). "sent" means Klaviyo has it; whether a text went out is on the flow.
