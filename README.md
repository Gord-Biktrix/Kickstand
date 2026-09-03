# Biktrix Pickup Program — Vancouver pilot

Web app that runs showroom pickups for pre-order bikes. A bike is built only for a booked pickup slot. Staff receive a box, tag it to an order and send an invite; the customer books from a tokened link; slots are first come, first served with a configurable number of pickups per day. Two dates run from the invite: **book by day 14, pick up by day 21**. Release and storage rules are feature-flagged.

Spec: `SPEC.md` (v0.1). This README covers running and operating the build.

## Stack

Next.js 16 (App Router, server actions), Postgres (Neon in prod, local Postgres 16 in dev), Drizzle ORM, Tailwind v4, Zod, date-fns-tz, pino, Vitest. Notifications go out as Klaviyo events behind a `Notifier` interface.

## Local development

```bash
pnpm install
cp .env.example .env.local          # then edit
createdb pickup_dev && createdb pickup_test
pnpm db:migrate                     # applies drizzle/*.sql
pnpm db:seed:sample                 # Vancouver showroom, capacity template, admin user, 3 sample orders
pnpm dev
```

Open http://localhost:3000/login. With `AUTH_DEV_SHOW_LINK=true` and no `RESEND_API_KEY`, the magic link is shown on the page after you submit an allow-listed email (`AUTH_ALLOWED_EMAILS`). The seed creates an **admin** for the first address in that list.

Tests run against `pickup_test` (`.env.test`) and apply migrations themselves:

```bash
pnpm test
pnpm typecheck
pnpm lint
```

## Environment

| Key | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection (Neon pooled URL in prod) |
| `AUTH_SECRET` | Signs nothing directly; derives the AES key that encrypts customer link tokens at rest |
| `AUTH_ALLOWED_DOMAIN`, `AUTH_ALLOWED_EMAILS` | Staff sign-in allow-list (domain **and** address list; leave the list empty to allow the whole domain) |
| `AUTH_EMAIL_FROM`, `RESEND_API_KEY` | Magic-link email. Console logging when the key is empty |
| `AUTH_DEV_SHOW_LINK` | Dev only: render the magic link on the login page |
| `KLAVIYO_PRIVATE_KEY`, `KLAVIYO_REVISION` | Klaviyo Events API. Console notifier when the key is empty |
| `CRON_SECRET` | Protects `/api/cron/clock` (`Authorization: Bearer …` or `x-cron-secret`) |
| `APP_BASE_URL` | Used in customer links and `.ics` URLs |
| `DEFAULT_SHOWROOM` | Slug the UI is scoped to (`vancouver`) |

## How the pieces map to the spec

| Spec | Code |
|---|---|
| §3 rules, §14 settings | `src/lib/settings.ts` (Zod schema + defaults + cross-field validation); values live in `showrooms.settings` JSONB, editable at `/app/settings/program` |
| §5 data model | `src/db/schema.ts`, migration in `drizzle/` |
| §6.1–6.2 capacity and slots | `src/lib/capacity.ts` (pure), `src/lib/availability.ts` (two queries per range) |
| §6.3 booking transaction | `src/lib/booking.ts` — counter row lock, `DAY_FULL` / `TIME_FULL`, cancel/reschedule/no-show |
| §7 lifecycle | `src/lib/units.ts` — receive, invite, build, ready, handover, extension, waive, defer, release/re-tag, attach |
| §8 clock job | `src/lib/clock.ts`, route `src/app/api/cron/clock/route.ts`, schedule in `vercel.json` (hourly) |
| §9 notifications | `src/lib/notifier.ts` (Klaviyo / console / memory), `src/lib/messages.ts` (properties, dedupe, outbox) |
| §10.1 customer | `src/app/b/[token]/…` — landing, book, manage; no sign-in |
| §10.2 staff | `src/app/app/…` — today, arrivals (+CSV import), build board, watchlist, unit/order detail, settings, reports |
| §10.3 API | `/api/cron/clock`, `/api/ics/[appointmentId]`, `/api/health`, `/api/reports/export` (admin) |
| §11 metrics | `pilotMetrics` in `src/lib/queries.ts`, page `/app/reports` |
| §13 security | tokens: 32 random bytes, SHA-256 lookup hash + AES-GCM copy for re-sends; rate limit in `src/proxy.ts`; roles enforced in every server action via `requireActor` |

## Decisions and deviations worth knowing

- **Auth** is a small in-house magic-link implementation (`magic_links`, `staff_sessions` tables, httpOnly cookie, 15-minute links, 30-day sessions, domain + address allow-list) rather than Auth.js. Same behaviour as the spec; fewer moving parts.
- **Customer tokens** are stored both hashed (`token_hash`, for lookup) and encrypted (`token_enc`), because nudges, hold-ending notices and the staff "copy link" button all need to reproduce the URL after the invite. A database dump alone does not expose links without `AUTH_SECRET`.
- **Book-by / pick-up-by** are stored as the *end* of the local day (invite date + 14 / + 21), so the whole displayed day is honoured. Storage starts the day after pick-up-by; the clock catches up if a run was missed.
- **Clock** runs hourly and only performs daily actions at `clock_run_hour_local` once per local date (`clock_last_run_date` marker); every message is deduped on `(unit_id, type, dedupe_key)` so replays never double-send. Force a run with `?force=daily|reminders|all`.
- **Deferred orders reopen on receipt.** Receiving a box for, or attaching an unassigned box to, a `deferred` order flips it back to `open` (event `order_reopened`); deferred orders sit on the waitlist with their original `order_date`. Arrivals lists unassigned boxes on hand with an inline Attach for managers.
- **Box tag is optional** at receiving: blank defaults to the order reference, with `-2`, `-3` suffixes if that tag already exists at the showroom. An explicit duplicate is refused.
- **No-show on an unbuilt bike** returns the unit to `invited` (so it counts as unbooked and, with the flag on, releasable); built bikes stay `ready` per R11.
- **Rate limiting** in `proxy.ts` is per-instance memory. On Vercel, add a WAF rule or Upstash for a hard limit.
- **Navigation** (after the 2026-09-03 UX panel): Today · Schedule · Arrivals · Build board · Watchlist · Settings, with Reports as an admin-only utility link. Capacity and Program are tabs under Settings, and the **CSV import moved from Arrivals to Settings › Import** — a deliberate deviation from §10.2, since it is a one-off migration rather than delivery-day work.
- The hourly tick comes from **GitHub Actions** (`.github/workflows/clock.yml`, secrets `APP_BASE_URL` and `CRON_SECRET`) because Vercel's Hobby plan only allows daily crons; `vercel.json` therefore declares none. The route accepts `GET` or `POST` with `Authorization: Bearer $CRON_SECRET`. Daily actions run at or after `clock_run_hour_local` once per local date; reminders at or after `reminder_send_hour_local`, deduped per appointment. Run it by hand from the Actions tab (workflow_dispatch, optional `force`).

## Lightspeed bridge

Lightspeed R-Series is the messaging bridge to Ikeono. Kickstand mirrors every unit as a Lightspeed work order (`src/lib/lightspeed.ts`): the Customer Item carries model / colour / size, `hookIn` the box tag, `etaOut` the pickup slot, the receipt note a customer-facing summary with the manage link, and the **work-order status** the last customer message. Ikeono's "text when work-order status changes" automations then send the SMS from the showroom's own number and route replies to that showroom's inbox. Klaviyo still receives every event (email and fallback).

- Hook point: `sendUnitMessage` in `src/lib/messages.ts`. The message → status map lives in `showrooms.settings.lightspeed.statuses`; a message with no mapping is Klaviyo-only (`lightspeed.skipped` on the event). Existing shop statuses can be reused (`pnpm ls:setup … --map booked=23`), or add statuses named `Pickup: <message>` and they map automatically. Sync is best-effort — a Lightspeed failure is written to the `msg_*` event payload (`lightspeed.error`) and never fails the booking.
- Ids: `orders.ls_customer_id`, `units.ls_workorder_id`, `units.ls_serialized_id`. Tokens live encrypted in `lightspeed_connections`; refresh tokens rotate, so the refresh runs under a row lock and the DB is the only copy that matters.
- Setup (once per account): register the OAuth client, get a token pair with `scripts/ls-poc.mjs` (see its header), set `LS_CLIENT_ID` / `LS_CLIENT_SECRET` in `.env.local`, then `pnpm ls:setup --shop <shopID> --employee <employeeID>`. Lightspeed does not allow creating work-order statuses via the API; the script prints the resulting map and enables the bridge when at least one message is mapped. Re-runnable. After it first runs, the token pair in `scripts/.env` is stale (rotated into the DB).
- Due date: `lightspeed.due_mode` decides what the work order's Due (`etaOut`) means. `pickup` = the customer's slot (Ikeono's `{ETA Out}` smart field can quote it). `assembly` (Vancouver) = the build deadline: `assembly_due_time_local` (10:00) on the pickup day, or the previous open day if the slot is earlier than that; the pickup time then lives in Hook Out and the note, and the Ikeono text must not use `{ETA Out}`. Set with `pnpm ls:setup … --due assembly --due-time 10:00`.
- **Never map messages onto statuses the service team uses.** Ikeono fires for any work order entering the status, so shared statuses text repair customers (this happened on 2026-09-03). Use dedicated `Pickup: …` statuses only.
- Ikeono: create one work-order automation per `Pickup: …` status. Statuses fire only on *change*, so a re-sent invite (same status) does not re-text; Klaviyo covers that.
- Not mirrored: build started / marked ready (no customer message, and the existing `Build for CU` / `CA# Ready for Pick up` statuses may already have Ikeono texts attached). Customers without a Lightspeed sale are created fresh in Lightspeed on first message; there is no duplicate check yet.

## Book pickup button

Staff can book on a customer's behalf at `/app/book` (also linked as **Book for customer** on any invited or built unit). From Lightspeed, add a Custom Button (Settings › Custom Menus › Open Web Page) on the sale / special-order and work-order screens pointing at `{APP_BASE_URL}/app/book`; Lightspeed appends `customerID`, `saleID`, `shopID`, `employeeID` and a signature. The page needs a Kickstand staff session (the register machine stays signed in for 30 days), so the signature is not verified. Flow: existing Kickstand unit for that customer → slot picker; otherwise a short form prefilled from the Lightspeed customer and sale lines creates the order (with `ls_customer_id`), receives the box and mints the link in one step (silent invite — no Bike Arrived message), then the slot picker. Staff may toggle **short notice** to book inside `min_lead_hours`; past times are never allowed. The booking goes through the normal path, so the Booked message, the Lightspeed work order and Ikeono text follow.

## Operations

- **Manual clock run:** `curl -X POST -H "Authorization: Bearer $CRON_SECRET" "$APP_BASE_URL/api/cron/clock?force=daily"`
- **Health:** `GET /api/health` reports DB connectivity and whether the Klaviyo key and cron secret are set.
- **Klaviyo:** twelve metrics named `Pickup: …` (see `METRIC` in `src/lib/messages.ts`); build one flow per metric. Every event carries `booking_url`, `manage_url`, `book_by_date`, `pickup_by_date`, `sms_consent` and the other §9.2 properties.
- **Go-live flags:** `storage_fee_enabled=false`, `release_rule_enabled=false`, `defer_enabled=true`. Set `terms_v2_effective_date` only once the Appendix C paragraph is live at checkout.
- **Lightspeed PoC:** `scripts/ls-poc.mjs` is a dependency-free CLI (`node scripts/ls-poc.mjs` lists commands; setup steps are in its header) that exercises the R-Series OAuth flow and creates/updates work orders with an ETA Out. It explores modelling the pickup slot as a Lightspeed work order, an alternative to the Sale/SaleLine polling seam in SPEC.md §12; nothing in the app depends on it. It reads `.env` from the directory you run it from, and the token pair rotates on every refresh.
