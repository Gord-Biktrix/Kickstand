# Kickstand Chat: build plan

Two-way customer texting inside Kickstand on Twilio, replacing Ikeono. Mock: the "Kickstand Messages" canvas
(Main, PhoneList, PhoneThread, AutoTexts).

## What it does

- A **Messages** tab (next to Schedule / Workshop / Customers) with an unread badge.
- One conversation per **store number + customer phone**. Customers keep texting the store's own number.
- Staff read and reply from Kickstand (desktop, iPad, phone). Customer photos show in the thread; staff can send a photo.
- Automatic texts (Booked, Reminder, Checked in, Needs your OK, Ready, Thanks) go out from the same number and show
  in the same thread, so staff see everything the customer was sent.
- New texts ping the store's Slack channel.
- STOP / START / HELP are honoured; an opted-out customer can't be texted from Kickstand.

Out of the first version: Ikeono history import, web chat, review requests, payment links, assigning a thread to
one person, full-text search (search covers name, phone and WO #).

## Off until a store is turned on

Nothing reaches a customer until **both** are true:

1. `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` are set (Vercel). Without them Kickstand logs texts instead of sending.
2. That store's line is switched on in Settings › Texts (a per-store `enabled` flag, off by default).

Inbound texts are recorded as soon as Twilio sends them, even while a store is off, so we can test receiving first.

## Phases

| | What | Done when |
|---|---|---|
| **a** | Twilio plumbing: `src/lib/sms.ts` (a `TextSender` like the `Notifier`: Twilio, console, memory for tests). `POST /api/twilio/inbound` and `POST /api/twilio/status`, both checking Twilio's signature. STOP/START/HELP recorded on the conversation; sends to an opted-out number are refused. | Tests send, receive, update status and opt out with signed fake requests. |
| **b** | Tables (below) and a migration. | `pnpm db:migrate` clean; tests use them. |
| **c** | Inbox per the mock: thread list (search, All / Unread / Waiting on OK, job chips), conversation (in / out / auto bubbles, photos, delivery status, quick replies, attach photo, Send), right panel (open job + tracker, pending finding, history, Send tracker link, Book a visit, texts allowed). Phone layout: list, then thread. Polls every 5 s while the tab is open. "+ New" text to a phone number. | Working locally with tests. |
| **d** | Unread badge in the nav (polled) and a Slack post per new inbound text to the store's channel. | |
| **e** | Automatic texts on Twilio: a `TwilioNotifier` behind the existing `Notifier`, templates per store in Settings › Automatic texts, quiet hours (held texts go out when they end), store numbers with porting state. Klaviyo keeps email and marketing. | Each automatic text is on/off per store. |

This session builds **a–c**. d and e follow.

## Tables

All new; none of the existing tables change.

- **`chat_lines`**: one per store. `showroom_id` (pk), `number` (E.164, unique), `enabled` (default false),
  `number_state` (`not_started` / `porting` / `hosted` / `live`), `quiet_start`, `quiet_end`, `templates` (jsonb, phase e).
- **`chat_conversations`**: `id`, `showroom_id`, `phone` (E.164), `name` (cached from the order or customer),
  `last_message_at`, `last_preview`, `last_inbound_at`, `read_at` (shared by the whole store, as the mock says),
  `opted_out_at`. Unique on (`showroom_id`, `phone`).
- **`chat_messages`**: `id`, `conversation_id`, `showroom_id`, `direction` (`in` / `out`), `kind` (`manual` / `auto`),
  `auto_tag` (`READY`, `NEEDS YOUR OK`…), `body`, `media` (jsonb list: Twilio URL or our own photo id, content type),
  `twilio_sid` (unique), `status` (`queued` / `sent` / `delivered` / `undelivered` / `failed` / `received`),
  `error_code`, `staff_user_id`, `staff_name`, `segments`, `created_at`.
- **`chat_photos`**: photos staff attach (small JPEG), served to Twilio from an unguessable URL.

Job chips, "Waiting on OK" and the right panel are read from what Kickstand already has: the customer's open work
order (`ls_workorders`), job log, findings and bookings, matched by phone.

## Routes

- `POST /api/twilio/inbound`: Twilio's "A message comes in" webhook. Signature check, store found by the `To` number,
  conversation by `From`, message saved, empty TwiML reply.
- `POST /api/twilio/status`: delivery callbacks (`sent`, `delivered`, `undelivered`, `failed` + error code).
- `GET /api/chat/media/<message>/<n>`: staff-only proxy for customer photos (Twilio media needs our credentials).
- `GET /chat-photo/<token>`: the photo Twilio fetches when staff send one.
- `GET /api/chat/poll`: the inbox's polling endpoint (staff-only).
- `/app/messages` (list) and `/app/messages?c=<id>` (thread). Server actions for send, mark read, new conversation.

## What Gord sets up in Twilio

1. **Account**: sign up at twilio.com, upgrade (add a card, ~$20 credit). Copy the **Account SID** and **Auth Token**
   into Vercel as `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`. Check `APP_BASE_URL` is the https address Twilio will call.
2. **A test number now**: buy one Canadian local number (~$1.15/month) for the pilot and for testing while the real
   numbers move. Under the number's *Messaging configuration*, "A message comes in" → Webhook,
   `https://<kickstand host>/api/twilio/inbound`, HTTP POST.
3. **Store numbers**: for each store, either
   - **Port** the number to Twilio (calls move too; only if the store no longer needs it with its phone provider), or
   - **Hosted SMS / "bring your own"** (keeps calls with the current provider, moves only texting to Twilio).
     Twilio sends a Letter of Authorization to sign. Because Ikeono texts from these numbers today, Ikeono (or
     whoever they host texting with) has to release them first; ask Ikeono what they need.
   Start this now for the pilot store; it takes days to weeks and runs alongside the build.
4. **Opt-out**: leave Twilio's *Advanced Opt-Out* on (the default). Twilio answers STOP/HELP itself and blocks
   texts to opted-out numbers; Kickstand records the same so staff can see it.
5. **US customers**: texting US numbers from a Canadian number may need A2P 10DLC registration. Most customers are
   Canadian; check with Twilio if US texting matters.
6. **Before going live**: confirm none of Ikeono's automations fire on the Lightspeed statuses Kickstand uses
   (Open / In Progress / Parts On Order / Finished and anything else mapped), or customers get two texts.
   Move Kickstand to Vercel Pro before live customer texting (Hobby has no uptime guarantee and short timeouts).

## Cost note

Texts are charged per segment: 160 plain characters, or 70 if the text has any curly quote, emoji or accented letter.
Kickstand straightens curly quotes in templates and shows a segment count while typing.
