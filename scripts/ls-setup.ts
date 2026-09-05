import { config } from "dotenv";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createDb } from "../src/db/client";
import { getConnection, LightspeedClient, saveConnection, STATUS_KEYS, statusNameFor } from "../src/lib/lightspeed";
import { getShowroom, patchShowroomSettings } from "../src/lib/showroom";

config({ path: process.env.ENV_FILE ?? ".env.local" });

/**
 * One-time setup for the Lightspeed bridge (README "Lightspeed bridge").
 *
 *   pnpm ls:setup --shop 3 --employee 27 [--map booked=23 --map completed=5 …] [--disable]
 *                 [--due pickup|assembly|lead] [--due-time 10:00] [--lead-hours 8]
 *                 [--showroom vancouver] [--tokens scripts/.env] [--import-tokens]
 *
 * 1. Imports the OAuth token pair produced by scripts/ls-poc.mjs (LS_ACCESS_TOKEN,
 *    LS_REFRESH_TOKEN, LS_ACCOUNT_ID) into lightspeed_connections, encrypted — only when no
 *    connection exists yet, or with --import-tokens. Refresh tokens rotate, so importing a file
 *    copy over a live connection revokes the live one; after a successful import the token lines
 *    are removed from the file so a stale copy cannot be re-imported later.
 * 2. Builds the message → work-order-status map. Each message key (see STATUS_KEYS) is mapped
 *    from, in order: an explicit --map key=<statusID or exact status name>, else an existing
 *    status named "Pickup: <message>". Keys with neither are NOT mirrored (Klaviyo only) — Ikeono
 *    fires on status *change*, so only map messages you want texted from Lightspeed. Lightspeed
 *    does not allow creating statuses via the API (405); add any new ones under Settings › Work Orders.
 * 3. Writes shop, employee and the map into the showroom's settings and enables the bridge when at
 *    least one message is mapped (pass --disable to write the map but keep the bridge off).
 * Safe to re-run: tokens are replaced, the map is refreshed.
 */
function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function readTokens(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

async function main() {
  const shop = Number(arg("shop"));
  const employee = arg("employee") ? Number(arg("employee")) : null;
  if (!shop) throw new Error("usage: ls:setup --shop <shopID> [--employee <employeeID>] [--showroom slug]");
  const db = createDb(process.env.DATABASE_URL!);
  const showroom = await getShowroom(db, arg("showroom", process.env.DEFAULT_SHOWROOM ?? "vancouver"));

  const tokenFile = arg("tokens", "scripts/.env")!;
  const tokens = readTokens(tokenFile);
  const existingConn = await getConnection(db);
  const haveFileTokens = !!(tokens.LS_ACCESS_TOKEN && tokens.LS_REFRESH_TOKEN && tokens.LS_ACCOUNT_ID);
  if (haveFileTokens && (!existingConn || process.argv.includes("--import-tokens"))) {
    await saveConnection(db, {
      accountId: tokens.LS_ACCOUNT_ID,
      accessToken: tokens.LS_ACCESS_TOKEN,
      refreshToken: tokens.LS_REFRESH_TOKEN,
      expiresIn: 0, // unknown age → refresh on first use
      scope: tokens.LS_SCOPE ?? null,
    });
    // Scrub the file copy: from here on the database holds the only valid pair.
    const kept = readFileSync(tokenFile, "utf8")
      .split("\n")
      .filter((l) => !/^\s*LS_(ACCESS_TOKEN|REFRESH_TOKEN)\s*=/.test(l));
    writeFileSync(tokenFile, kept.join("\n"));
    console.log(`Imported token pair for account ${tokens.LS_ACCOUNT_ID} (removed from ${tokenFile})`);
  } else if (existingConn) {
    console.log(`Using the stored connection for account ${existingConn.accountId}` + (haveFileTokens ? " (file tokens ignored; pass --import-tokens to replace)" : ""));
  } else {
    throw new Error(`No Lightspeed connection and no token pair in ${tokenFile} — run scripts/ls-poc.mjs auth-url / exchange first`);
  }

  const client = new LightspeedClient(db);
  const existing = await client.listWorkorderStatuses();
  const byName = new Map(existing.map((s) => [s.name.trim().toLowerCase(), s]));
  const byId = new Map(existing.map((s) => [s.workorderStatusID, s]));

  // --map key=<id or name>, repeatable
  const explicit = new Map<string, string>();
  process.argv.forEach((a, i) => {
    if (a === "--map" && process.argv[i + 1]) {
      const [k, ...v] = process.argv[i + 1].split("=");
      explicit.set(k.trim(), v.join("=").trim());
    }
  });
  for (const k of explicit.keys()) {
    if (!(STATUS_KEYS as readonly string[]).includes(k)) throw new Error(`Unknown message key '${k}'. Valid: ${STATUS_KEYS.join(", ")}`);
  }

  const statuses: Record<string, number> = {};
  const unmapped: string[] = [];
  console.log("\nMessage → Lightspeed work-order status");
  for (const key of STATUS_KEYS) {
    const want = explicit.get(key);
    const found = want
      ? /^\d+$/.test(want)
        ? byId.get(want)
        : byName.get(want.toLowerCase())
      : byName.get(statusNameFor(key).toLowerCase());
    if (want && !found) throw new Error(`--map ${key}=${want}: no such work-order status in Lightspeed`);
    if (found) {
      statuses[key] = Number(found.workorderStatusID);
      console.log(`  ${key.padEnd(20)} → ${found.name} (#${found.workorderStatusID})`);
    } else {
      unmapped.push(key);
      console.log(`  ${key.padEnd(20)} → (not mirrored — Klaviyo only)`);
    }
  }
  const dupes = Object.entries(statuses).reduce<Record<number, string[]>>((acc, [k, id]) => ((acc[id] ??= []).push(k), acc), {});
  for (const [id, keys] of Object.entries(dupes)) {
    if (keys.length > 1) console.log(`  ⚠ ${byId.get(id)?.name} is shared by ${keys.join(", ")}: a second message in a row will not change the status, so Ikeono will not text again.`);
  }

  const enabled = !process.argv.includes("--disable") && Object.keys(statuses).length > 0;
  await patchShowroomSettings(db, showroom.id, {
    lightspeed: {
      ...showroom.settings.lightspeed,
      enabled,
      shop_id: shop,
      employee_id: employee,
      ...(arg("due") ? { due_mode: arg("due") as "pickup" | "assembly" | "lead" } : {}),
      ...(arg("lead-hours") ? { assembly_lead_work_hours: Number(arg("lead-hours")) } : {}),
      ...(arg("due-time") ? { assembly_due_time_local: arg("due-time")! } : {}),
      statuses,
    },
  });
  console.log(`\nLightspeed bridge ${enabled ? "ENABLED" : "written but DISABLED"} for ${showroom.name}: shop ${shop}, employee ${employee ?? "—"}, ${Object.keys(statuses).length} of ${STATUS_KEYS.length} messages mirrored.`);
  if (unmapped.length) console.log(`Not mirrored: ${unmapped.join(", ")}. Map them with --map <key>=<statusID|name>, or add "Pickup: …" statuses in Lightspeed and re-run.`);
  console.log("Ikeono: attach one work-order automation to each mapped status.");
  await db.$client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
