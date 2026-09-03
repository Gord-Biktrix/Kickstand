---
name: ux-review
description: Run a four-reviewer UX panel over the pickup app (navigation/IA, customer UI, staff UI, first-day learnability), then synthesise into one prioritised proposal. Use when asked to review, simplify or critique the app's screens, navigation or copy.
---

# UX review panel

Four independent reviewers read the actual UI source and the spec, each from a fixed
viewpoint, and return findings in one shared format. The caller (main session) then
synthesises them into a single prioritised proposal. Reviewers never edit files.

## Inputs every reviewer gets

- Repo root, and the fact that the UI is small enough to read in full:
  `src/app/app/**` (staff), `src/app/b/**` (customer), `src/app/login/page.tsx`,
  `src/components/**`, `src/app/app/layout.tsx` (top nav), `src/app/globals.css`.
- `SPEC.md` §4 (roles), §10 (screens and routes), §3 (business rules the UI must expose).
- The current nav: Today · Arrivals · Build board · Watchlist · Capacity · Program · Reports,
  plus per-unit and per-order pages reached by links, and the customer pages
  `/b/[token]` (status), `/b/[token]/book` (slot picker), `/b/[token]/manage`.
- If a dev server is running on `http://localhost:3000`, customer pages can be fetched
  with curl using a token from the unit page; staff pages need a session cookie and are
  usually reviewed from source.

## Reviewer roles (spawn all four in parallel, `general-purpose`, read-only)

1. **Navigation & information architecture** — Can a user predict what is behind each
   label? Which top-level items are daily work vs. occasional configuration? Propose a
   target nav (≤ 5 primary items) and say where every current screen lands. Check
   role gating (staff vs manager vs admin) matches §4.
2. **Customer experience** — The three `/b` pages as a first-time customer on a phone,
   arriving from an SMS. Clarity of the offer, the hold window, what to bring, balance
   and storage messaging, error/expired-token states, reschedule/cancel paths,
   accessibility basics (labels, focus, contrast, tap targets).
3. **Staff back-office experience** — The daily loop (Arrivals → Build board → Today →
   handover) and the exception loop (Watchlist). Steps per task, dead ends, duplicated
   information, missing affordances, table/card density, what a busy Saturday looks like.
4. **First-day learnability & consistency** — A new hire with no training. Terminology
   consistency (unit/box/bike, invited/ready/booked, hold/book-by/pick-up-by), empty
   states, microcopy, badge meanings, whether the nav order matches the workflow order,
   and whether the same concept looks the same on every screen.

## Finding format (every reviewer, every finding)

```
### <short title>
Severity: blocker | major | minor | polish
Where: <file:line or route>
What: one or two sentences describing the problem as a user would meet it.
Why it matters: one sentence.
Fix: concrete, smallest change that resolves it.
```

End with: **Top 3** (the three changes with the best payoff) and **Keep** (two or
three things that already work well and must not be lost in a redesign).

## Synthesis (main session)

Merge the four reports: de-duplicate, keep the strongest evidence for each finding,
resolve conflicts explicitly, and produce (a) a target navigation with a mapping from
every current screen, (b) a prioritised change list, (c) the "keep" list. Present it
before changing any code; nav changes are a scope decision for the user.
