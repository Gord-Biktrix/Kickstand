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

**Sender prefix:** Klaviyo automatically prepends the account name ("Biktrix Canada:") to every SMS, so do **not** start the copy with "Biktrix:" — drop that word from the drafts below.

**Before any text can go out:** Klaviyo → Settings → SMS → finish the **toll-free number registration** (business details form). Until Klaviyo shows the number as registered, it will not deliver SMS to Canadian or US numbers; the editor shows a red banner about it. Registration can take up to 10 days — start it now.

**Several bikes in one visit:** every event also carries `bike_count` (number) and `bikes` (list, e.g.
"Juggernaut Lite Plus 2.0 · Green"). Write copy that reads well either way:
`{% if event.bike_count > 1 %}your {{ event.bike_count }} bikes{% else %}your {{ event.model }}{% endif %}`.
Bike Arrived may also carry `joined_existing_pickup: true` with `slot_start_local` — the new bike has been added to
a pickup the customer already booked: "your second bike is here — we've added it to your pickup on {{ event.slot_start_local }}".

---

## 1. Pickup: Bike Arrived  — the invite (unit received, link minted)
Extra: `order_kind` (`preorder` = a Lightspeed special order or an order placed 3+ days before the invite;
`stock` = bought within the last couple of days), `days_waited`, `early_bird_deadline`, `reward_text`,
`days_left_display`, and for a later bike that joined an existing visit `joined_existing_pickup` + `slot_start_local`.

The same event covers a pre-sale someone waited weeks for and a floor bike bought yesterday, so keep the
base copy neutral and let one line vary on `order_kind`.

**SMS**
> {% if event.joined_existing_pickup %}Good news {{ person.first_name|default:"there" }} — your {% if event.bike_count > 1 %}other bikes are{% else %}{{ event.model }} is{% endif %} here too. We've added it to your pickup on {{ event.slot_start_local }}; nothing to do. Change it: {{ event.manage_url }}{% else %}Great news {{ person.first_name|default:"there" }}: your {% if event.bike_count > 1 %}{{ event.bike_count }} bikes are{% else %}{{ event.model }} is{% endif %} here and heading into the workshop.{% if event.order_kind == "preorder" %} Thanks for your patience — worth the wait.{% endif %} Pick a collection time and we'll have {% if event.bike_count > 1 %}them{% else %}it{% endif %} built, checked and ready: {{ event.booking_url }} Please book by {{ event.book_by_date }}.{% endif %}

**Email** (subject: *Pick a time to collect your {% if event.bike_count > 1 %}bikes{% else %}{{ event.model }}{% endif %}*)
Same structure as the Booked template: greeting; the neutral line above; `{% if event.order_kind == "preorder" %}` "Thanks for your patience." `{% endif %}` (Gord: keep customer detail light — no build-time or 21-point-check lines); a **Pick my collection time** button → `booking_url`; what happens at pickup; the free hold until
`{{ event.pickup_by_date }}` and what happens after (`storage_rate_display` for terms v2); the balance line if any.

## 2. Pickup: Booked
Extra: `slot_start_local`, `slot_end_local`, `calendar_ics_url`, `storage_estimate_display`.

**SMS** (quiet hours OFF)
> you're booked to collect your {{ event.model }} on {{ event.slot_start_local }} at {{ event.showroom }}, {{ event.showroom_address }}.
> {% if event.balance_display %}Balance due at pickup: {{ event.balance_display }}. {% endif %}Change or cancel: {{ event.manage_url }}

**Email**

Subject: `Your pickup is booked — {{ event.slot_start_local }}`
Preview text: `{% if event.bike_count > 1 %}{{ event.bike_count }} bikes{% else %}{{ event.model }}{% endif %} at {{ event.showroom }}. Everything you need to know is inside.`

Body (use a simple one-column template; headings in bold, one button):

> Hi {{ person.first_name|default:"there" }},
>
> **You're booked.** {% if event.bike_count > 1 %}Your {{ event.bike_count }} bikes ({{ event.bikes|join:", " }}) are{% else %}Your {{ event.model }}{% if event.colour %} in {{ event.colour }}{% endif %} is{% endif %} being built for you and will be ready to collect on:
>
> **{{ event.slot_start_local }}**
> {{ event.showroom }} · {{ event.showroom_address }}
>
> [Add to calendar]({{ event.calendar_ics_url }})
>
> **What happens at pickup** — allow about 45 minutes. We'll fit the bike to you, walk through the display, charging and locking, and do the 21-point safety check with you.
>
> **Please bring**
> - Photo ID
> - Your order confirmation (this email is fine)
> {% if event.balance_display %}- The card you'd like to pay the remaining balance with — **{{ event.balance_display }}** is due at pickup{% endif %}
>
> **Need to change it?** You can reschedule or cancel up to 24 hours before your slot, free of charge, here:
> [Manage my pickup]({{ event.manage_url }})
> Inside 24 hours a change counts as a missed pickup, so please give us a shout early.
>
> Questions? Call {{ event.showroom }} on {{ event.showroom_phone }} or reply to this email.
>
> See you soon,
> The Biktrix team

Notes: button links use `event.manage_url` and `event.calendar_ics_url` (both absolute). Mark the email
**transactional** too, Smart Sending off. Use the same body for **Pickup: Rescheduled** with the heading
"Your pickup has moved" and a line "Previously: {{ event.old_slot_start_local }}".

## 3. Pickup: Reminder Day Before
Extra: `slot_start_local`, `bring_list`, `built` (true/false).

**SMS**
> see you tomorrow, {{ event.slot_start_local }}, for your {{ event.model }} at {{ event.showroom }}.
> Bring: {{ event.bring_list }}. Need to change it? {{ event.manage_url }}

## 4. Pickup: Rescheduled
Extra: `old_slot_start_local`, `slot_start_local`, `slot_end_local`, `late_change`, `calendar_ics_url`.

**SMS** (quiet hours OFF)
> your pickup has moved to {{ event.slot_start_local }} (was {{ event.old_slot_start_local }}).
> Manage: {{ event.manage_url }}

## 5. Pickup: Cancelled
Extra: `cancelled_by` (`customer` or `shop`), `slot_start_local`, `days_left_display`, `late_change`.
Use a **conditional split on `event.cancelled_by`**:

**SMS — `cancelled_by` = shop** (quiet hours OFF)
> sorry — we've had to cancel your pickup on {{ event.slot_start_local }}. Your {{ event.model }} is safe with us.
> Please pick a new time: {{ event.rebook_url }}

**SMS — `cancelled_by` = customer**
> your pickup on {{ event.slot_start_local }} is cancelled. Your {{ event.model }} is held until {{ event.pickup_by_date }} — rebook any time: {{ event.rebook_url }}

## 6. Pickup: Missed  — no-show recorded
Extra: `slot_start_local`, `no_show_count`.

**SMS**
> we missed you at {{ event.slot_start_local }}. Your {{ event.model }} is still here — book a new time: {{ event.rebook_url }}
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

---

# Parts & accessories flows (separate from bikes)

Only the **arrival** differs: parts fire **Parts: Order Arrived** instead of Pickup: Bike Arrived, so that is
the one new flow to build (P1 below). Booked, Rescheduled, Cancelled and Completed **share the bike flows**
unchanged — for parts, `model` is the item name and `bikes` lists the items, so "you're booked to collect
your Front Cargo Basket on Saturday…" reads correctly. The Booked email template branches on
`event.item_kind` so it says "is ready for you" rather than "is being built" for parts.

No reminder, nudge, hold-ending or storage messages exist for parts. Items are in `event.bikes` (a list of
item names, quantity suffixed, e.g. "Fat Bike Inner Tube 20x4 ×2"); `event.bike_count` is the number of items.

## P1. Parts: Order Arrived ("your order is in")
**SMS** (quiet hours ON)
> Good news {{ person.first_name|default:"there" }}: your order from {{ event.showroom }} is in — {{ event.bikes|join:", " }}. Pick any time to collect it: {{ event.booking_url }}

**Email**: template "Parts: Order ready to collect (Kickstand)" — subject `Your order is ready to collect`.

(Booked / Rescheduled / Cancelled for parts: the shared bike flows — no separate flow needed.)
