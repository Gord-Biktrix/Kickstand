@AGENTS.md

# Biktrix Pickup Program

Spec: `SPEC.md` (§ references in code comments point here). Operating notes and deviations: `README.md`.

- `pnpm dev` (needs local Postgres, `.env.local`), `pnpm test` (uses `pickup_test`), `pnpm typecheck`, `pnpm lint`.
- Schema changes: edit `src/db/schema.ts` → `pnpm db:generate` → `pnpm db:migrate`.
- Business rules live in `src/lib/` as pure functions where possible (`capacity.ts`, `storage.ts`, `settings.ts`); DB mutations in `booking.ts`, `units.ts`, `clock.ts`. Every staff mutation goes through a server action in `src/app/app/actions.ts` that calls `requireActor(role)`.
- Customer-facing times: always `America/Vancouver` via `src/lib/time.ts`; never use a fixed offset.
