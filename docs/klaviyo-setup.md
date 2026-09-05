# Connecting Klaviyo to Kickstand — step by step

The API key is already in Vercel (health check shows `klaviyo_key: true`). Every customer message
Kickstand sends is an *event* in Klaviyo named `Pickup: …`. Klaviyo **flows** turn those events into texts
and emails. Copy for each flow is in `klaviyo-flows.md`.

## 0. Register the sending number (blocks everything else)
Klaviyo → Settings → SMS: complete the **toll-free number registration** for the Biktrix Canada number. Until it is approved (up to 10 days) Klaviyo will not deliver any SMS to Canadian/US numbers, however the flows are set up. The SMS editor shows a red "Finish registering your toll free number" banner while this is pending.

## 1. Make the events exist
Klaviyo only lists a metric in the flow builder after it has received one event of that kind.
1. In Kickstand, book a test bike with **your own phone**, ticking "agrees to text reminders". → fires `Pickup: Booked`.
2. On the bike page: **Reschedule** → `Pickup: Rescheduled`; **Cancel booking** (Customer asked) → `Pickup: Cancelled`; book again.
3. Invite an on-order test bike (Bikes → On order → Invite) → `Pickup: Bike Arrived`.
4. Check the bike's Timeline: each Message row should say `sent`.
5. Klaviyo → Audience → Profiles → search your phone: events under Activity, and "SMS transactional" consent.

## 2. Build a flow (do this once per metric)
1. Klaviyo → Flows → **Create flow** → **Build your own**. Name it after the metric (e.g. `Pickup: Booked`).
2. Trigger: **Metric** → pick the `Pickup: …` metric. No trigger filter, no profile filter.
3. Drag an **SMS** action under the trigger. In its settings:
   - Body: paste from `klaviyo-flows.md`.
   - **Transactional: ON** — without it Klaviyo treats the text as marketing and will not send to these customers.
   - **Smart sending: OFF**.
   - **Quiet hours**: OFF for Booked / Rescheduled / Cancelled; ON for Bike Arrived, Reminder, Missed.
   - **Shorten links: ON**.
4. Preview with your profile (it has real events) to see the variables fill in.
5. Set the SMS action **Live**, then the flow **Live** (top right).
6. Fire the event again from Kickstand → the text arrives on your phone.

## 3. Which flows to build (Klaviyo) — and which NOT to
| Metric | Build in Klaviyo? | Notes |
|---|---|---|
| Pickup: Bike Arrived | yes | the invite with the booking link |
| Pickup: Reminder Day Before | yes | fires from the hourly clock (needs GitHub Actions secrets) |
| Pickup: Rescheduled | yes | |
| Pickup: Cancelled | yes | add a **Conditional split** on `event.cancelled_by equals shop` — apology text on yes, standard on no |
| Pickup: Missed | yes | |
| Pickup: Nudge Day 3 / Day 7, Hold Ending, Storage Started, Deferred | later | |
| Pickup: Booked, Completed (and "ready") | **no, if Ikeono texts these** | otherwise the customer gets two texts. Fine to build Booked temporarily to test the pipe — switch it off before the Ikeono status is attached. |

Multi-bike visits: events carry `bike_count` and `bikes` (a list like "Juggernaut Lite Plus 2.0 · Green").
Use `{% if event.bike_count > 1 %}your {{ event.bike_count }} bikes{% else %}your {{ event.model }}{% endif %}`.

## 4. Check it is working
- Bike Timeline in Kickstand: `sent` = Klaviyo accepted the event. `failed` = see Alerts → Message failures.
- Klaviyo → Analytics → Metrics: `Pickup: …` metrics with counts.
- Klaviyo → the flow → Analytics: recipients / delivered.
