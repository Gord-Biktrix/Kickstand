import { formatInTimeZone } from "date-fns-tz";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  appointments,
  lightspeedConnections,
  orders,
  units,
  type Appointment,
  type LightspeedConnection,
  type Order,
  type Unit,
} from "@/db/schema";
import { buildDeadline } from "./build-schedule";
import { logger } from "./logger";
import { baseUrl, customerUrls, metricKey, type Metric } from "./messages";
import { getCapacityConfig, type ShowroomCtx } from "./showroom";
import { formatDateTime, formatLongDate, formatLongDateFromLocal, formatShortDateFromLocal, type LocalDate } from "./time";
import { decryptToken, encryptToken } from "./tokens";

/**
 * Lightspeed R-Series bridge (README "Lightspeed bridge").
 *
 * Kickstand mirrors each unit as a Lightspeed work order: the Customer Item block carries
 * model / colour / size, hookIn carries the box tag, etaOut carries the pickup slot, and the
 * work order STATUS carries the last customer message. Ikeono's "text on work order status
 * change" automations then send the SMS from the showroom's own number and route replies to
 * the showroom inbox — no Ikeono API needed.
 *
 * Everything here is best-effort: a Lightspeed failure never fails the booking. The caller
 * (sendUnitMessage) records success or failure on the message event.
 */

const OAUTH_TOKEN = "https://cloud.lightspeedapp.com/auth/oauth/token";
const API = "https://api.lightspeedapp.com/API/V3";

export class LightspeedError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "LightspeedError";
  }
}

let fetchOverride: typeof fetch | null = null;
/** Tests inject a fake transport. */
export function setLightspeedFetch(f: typeof fetch | null) {
  fetchOverride = f;
}
const doFetch: typeof fetch = (...args) => (fetchOverride ?? fetch)(...args);

/** Lightspeed returns an object for one result and an array for many; normalise. */
export type SaleLineInfo = { description: string; qty: number; model: string; size: string | null; colour: string | null };

/**
 * Model / size / colour from a Lightspeed item. Biktrix item descriptions look like
 * "86-Juggernaut Lite Plus - Limited Edition Green": a numeric vendor prefix, the matrix (model)
 * name, then the variant values appended. Attributes come from the item's attribute set, whose
 * names are matched loosely (Color/Colour, Size); the model is the matrix name when known,
 * otherwise the description with the prefix and trailing variant values stripped.
 */
export function splitItemDescription(
  description: string,
  attributes: Record<string, string>,
  matrixName: string | null = null,
): { model: string; size: string | null; colour: string | null } {
  const stripPrefix = (s: string) => s.replace(/^\s*\d+\s*-\s*/, "").trim();
  const find = (re: RegExp) => Object.entries(attributes).find(([k]) => re.test(k))?.[1] ?? null;
  const colour = find(/colou?r/i);
  const size = find(/size/i);
  let model = stripPrefix(matrixName ?? description);
  if (!matrixName) {
    // Variant values are appended in any order ("… - Blue / 19"); peel them off the end until none match.
    const values = Object.values(attributes).filter(Boolean);
    let changed = true;
    while (changed) {
      changed = false;
      for (const v of values) {
        const re = new RegExp(`[\\s/-]*${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
        const next = model.replace(re, "").trim();
        if (next !== model) { model = next; changed = true; }
      }
    }
    model = model.replace(/[\s/-]+$/, "").trim();
  }
  return { model: model || stripPrefix(description), size, colour };
}

export function asList<T>(obj: Record<string, unknown> | undefined, key: string): T[] {
  const v = obj?.[key];
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? (v as T[]) : [v as T];
}

export function lightspeedEnabled(showroom: ShowroomCtx): boolean {
  const ls = showroom.settings.lightspeed;
  return ls.enabled && ls.shop_id !== null;
}

// ── connection / tokens ─────────────────────────────────────────────────────

export async function getConnection(dbx: Db): Promise<LightspeedConnection | null> {
  const [row] = await dbx.select().from(lightspeedConnections).orderBy(desc(lightspeedConnections.updatedAt)).limit(1);
  return row ?? null;
}

export async function saveConnection(
  dbx: Db,
  c: { accountId: string; accessToken: string; refreshToken: string; expiresIn: number; scope?: string | null },
): Promise<LightspeedConnection> {
  const values = {
    accountId: c.accountId,
    accessTokenEnc: encryptToken(c.accessToken),
    refreshTokenEnc: encryptToken(c.refreshToken),
    accessExpiresAt: new Date(Date.now() + (c.expiresIn - 60) * 1000),
    scope: c.scope ?? null,
    lastError: null,
  };
  const [row] = await dbx
    .insert(lightspeedConnections)
    .values(values)
    .onConflictDoUpdate({ target: lightspeedConnections.accountId, set: values })
    .returning();
  return row;
}

function clientCreds() {
  const id = process.env.LS_CLIENT_ID;
  const secret = process.env.LS_CLIENT_SECRET;
  if (!id || !secret) throw new LightspeedError("LS_CLIENT_ID / LS_CLIENT_SECRET not set");
  return { client_id: id, client_secret: secret };
}

/**
 * Refresh under a row lock. Refresh tokens rotate, so two concurrent refreshes would revoke
 * each other; the lock serialises them and the second caller reuses the first's result.
 */
async function refreshAccessToken(dbx: Db, conn: LightspeedConnection): Promise<LightspeedConnection> {
  return dbx.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(lightspeedConnections)
      .where(eq(lightspeedConnections.id, conn.id))
      .for("update");
    if (locked.accessTokenEnc !== conn.accessTokenEnc) return locked; // someone else refreshed
    const res = await doFetch(OAUTH_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        ...clientCreds(),
        refresh_token: decryptToken(locked.refreshTokenEnc),
        grant_type: "refresh_token",
      }),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      await tx
        .update(lightspeedConnections)
        .set({ lastError: `refresh ${res.status}: ${JSON.stringify(json).slice(0, 300)}` })
        .where(eq(lightspeedConnections.id, conn.id));
      throw new LightspeedError(`Token refresh failed (${res.status})`, res.status, json);
    }
    const [updated] = await tx
      .update(lightspeedConnections)
      .set({
        accessTokenEnc: encryptToken(String(json.access_token)),
        refreshTokenEnc: encryptToken(String(json.refresh_token ?? decryptToken(locked.refreshTokenEnc))),
        accessExpiresAt: new Date(Date.now() + (Number(json.expires_in ?? 3600) - 60) * 1000),
        scope: typeof json.scope === "string" ? json.scope : locked.scope,
        lastError: null,
      })
      .where(eq(lightspeedConnections.id, conn.id))
      .returning();
    return updated;
  });
}

// ── API client ──────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LightspeedClient {
  private conn: LightspeedConnection | null = null;

  constructor(private dbx: Db) {}

  private async connection(): Promise<LightspeedConnection> {
    if (!this.conn) this.conn = await getConnection(this.dbx);
    if (!this.conn) throw new LightspeedError("Lightspeed is not connected — run scripts/ls-setup.ts");
    if (this.conn.accessExpiresAt.getTime() <= Date.now()) this.conn = await refreshAccessToken(this.dbx, this.conn);
    return this.conn;
  }

  /** `path` is relative to /Account/{id}/ unless absolute. */
  async request<T = Record<string, unknown>>(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
    attempt = 0,
  ): Promise<T> {
    const conn = await this.connection();
    const url = path.startsWith("http") ? path : `${API}/Account/${conn.accountId}/${path}`;
    const res = await doFetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${decryptToken(conn.accessTokenEnc)}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && attempt === 0) {
      this.conn = await refreshAccessToken(this.dbx, conn);
      return this.request(method, path, body, 1);
    }
    if (res.status === 429 && attempt < 2) {
      const wait = Math.min(Number(res.headers.get("retry-after") || 1), 5);
      await sleep(wait * 1000);
      return this.request(method, path, body, attempt + 1);
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      throw new LightspeedError(`${method} ${path} → ${res.status}`, res.status, json);
    }
    return json as T;
  }

  // Typed helpers -----------------------------------------------------------

  async listWorkorderStatuses(): Promise<{ workorderStatusID: string; name: string; sortOrder: string }[]> {
    const res = await this.request("GET", "WorkorderStatus.json?limit=100");
    return asList(res, "WorkorderStatus");
  }

  async createCustomer(order: Order): Promise<string> {
    const [firstName, ...rest] = order.customerName.trim().split(/\s+/);
    const body = {
      firstName: firstName || "Customer",
      lastName: rest.join(" ") || "—",
      Contact: {
        ...(order.customerEmail
          ? { Emails: { ContactEmail: [{ address: order.customerEmail, useType: "Primary" }] } }
          : {}),
        ...(order.customerPhone
          ? { Phones: { ContactPhone: [{ number: order.customerPhone, useType: "Mobile" }] } }
          : {}),
      },
    };
    const res = await this.request<{ Customer?: { customerID: string } }>("POST", "Customer.json", body);
    return String(res.Customer?.customerID);
  }

  /** The Customer Item block on a work order is a separate Serialized record. */
  async createSerialized(unit: Unit, customerID: string): Promise<string> {
    const res = await this.request<{ Serialized?: { serializedID: string } }>("POST", "Serialized.json", {
      customerID: Number(customerID),
      description: unit.model,
      ...(unit.colour ? { colorName: unit.colour } : {}),
      ...(unit.size ? { sizeName: unit.size } : {}),
    });
    return String(res.Serialized?.serializedID);
  }

  /** Customer as Kickstand needs it: name and primary contact. */
  async getCustomer(customerID: string): Promise<{ customerID: string; name: string; email: string | null; phone: string | null } | null> {
    const res = await this.request<Record<string, unknown>>("GET", `Customer/${customerID}.json?load_relations=${encodeURIComponent('["Contact"]')}`);
    const c = res.Customer as Record<string, unknown> | undefined;
    if (!c) return null;
    const contact = c.Contact as Record<string, unknown> | undefined;
    const emails = asList<{ address: string }>(contact?.Emails as Record<string, unknown>, "ContactEmail");
    const phones = asList<{ number: string; useType?: string }>(contact?.Phones as Record<string, unknown>, "ContactPhone");
    const mobile = phones.find((p) => p.useType === "Mobile") ?? phones[0];
    return {
      customerID: String(c.customerID),
      name: `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim(),
      email: emails[0]?.address ?? null,
      phone: mobile?.number ?? null,
    };
  }

  /** Sale lines with their item descriptions — the bike(s) the customer bought. */
  async getSale(saleID: string): Promise<{ saleID: string; customerID: string | null; createDate: string | null; lines: SaleLineInfo[] } | null> {
    const res = await this.request<Record<string, unknown>>("GET", `Sale/${saleID}.json?load_relations=${encodeURIComponent('["SaleLines","SaleLines.Item"]')}`);
    const sale = res.Sale as Record<string, unknown> | undefined;
    if (!sale) return null;
    const lines = await this.describeSaleLines(asList<Record<string, unknown>>(sale.SaleLines as Record<string, unknown>, "SaleLine"));
    return {
      saleID: String(sale.saleID),
      customerID: sale.customerID && String(sale.customerID) !== "0" ? String(sale.customerID) : null,
      createDate: typeof sale.createTime === "string" ? sale.createTime.slice(0, 10) : null,
      lines,
    };
  }

  /**
   * Special-order items that have not been completed onto a sale yet. On the register they sit on
   * the customer's Special Order tab; in the API they are SaleLines with saleID 0, isSpecialOrder
   * true and the customerID set — Sale/{id} does not include them. Newest first.
   */
  async getSpecialOrderLines(customerID: string): Promise<SaleLineInfo[]> {
    const res = await this.request<Record<string, unknown>>(
      "GET",
      `SaleLine.json?customerID=${encodeURIComponent(customerID)}&isSpecialOrder=true&load_relations=${encodeURIComponent('["Item"]')}`,
    );
    const rows = asList<Record<string, unknown>>(res, "SaleLine")
      .filter((l) => String(l.itemID ?? "0") !== "0" && String(l.isWorkorder) !== "true")
      .sort((a, b) => String(b.createTime ?? "").localeCompare(String(a.createTime ?? "")));
    return this.describeSaleLines(rows);
  }

  /** Public paginated fetch for other modules (work-order mirror). */
  listAllRows(path: string, key: string, max = 2000): Promise<Record<string, unknown>[]> {
    return this.listAll(path, key, max);
  }

  /** Follow Lightspeed's `@attributes.next` cursor and return every row of a collection. */
  private async listAll(path: string, key: string, max = 2000): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    let url: string | null = path;
    while (url && out.length < max) {
      const res: Record<string, unknown> = await this.request<Record<string, unknown>>("GET", url);
      out.push(...asList<Record<string, unknown>>(res, key));
      const next = (res["@attributes"] as { next?: string } | undefined)?.next;
      url = next ? next.replace(/^.*\/Account\/\d+\//, "") : null;
    }
    return out;
  }

  /**
   * Uncompleted special-order lines for a shop (saleID 0 — see getSpecialOrderLines). Raw rows with
   * Item loaded; `since` (ISO) trims old ones — the shop has hundreds of stale open special orders.
   */
  async listOpenSpecialOrderLines(shopID: number, since?: string): Promise<Record<string, unknown>[]> {
    const q = new URLSearchParams({ isSpecialOrder: "true", saleID: "0", shopID: String(shopID), limit: "100", load_relations: '["Item"]' });
    if (since) q.set("createTime", `>,${since}`);
    return this.listAll(`SaleLine.json?${q.toString()}`, "SaleLine");
  }

  /** categoryID → full path ("Bikes/Juggernauts/Ultra FS"). */
  async listCategories(): Promise<Map<string, string>> {
    const rows = await this.listAll("Category.json?limit=100", "Category");
    return new Map(rows.map((c) => [String(c.categoryID), String(c.fullPathName ?? c.name ?? "")]));
  }

  /**
   * Turn sale lines into model / size / colour. Lightspeed nests neither ItemAttributes nor
   * ItemMatrix under a sale line (400), so each distinct item costs one extra call, plus one per
   * matrix and one for the attribute-set names (cached on the client). Failures fall back to the
   * plain description so the prefill never blocks the form.
   */
  async describeSaleLines(rows: Record<string, unknown>[]): Promise<SaleLineInfo[]> {
    const out: SaleLineInfo[] = [];
    for (const l of rows) {
      const item = l.Item as Record<string, unknown> | undefined;
      const description = String(item?.description ?? l.description ?? "").trim();
      if (!description) continue;
      const qty = Number(l.unitQuantity ?? 1);
      const itemID = String(l.itemID ?? item?.itemID ?? "0");
      let info: SaleLineInfo = { description, qty, ...splitItemDescription(description, {}) };
      if (itemID !== "0") {
        try {
          info = { description, qty, ...(await this.describeItem(itemID, description)) };
        } catch (err) {
          logger.warn({ err: err instanceof Error ? err.message : String(err), itemID }, "lightspeed: item attributes unavailable");
        }
      }
      out.push(info);
    }
    return out;
  }

  private attributeSets: Promise<Map<string, string[]>> | null = null;
  private matrixNames = new Map<string, Promise<string>>();

  private async describeItem(itemID: string, description: string): Promise<Omit<SaleLineInfo, "description" | "qty">> {
    const res = await this.request<Record<string, unknown>>("GET", `Item/${itemID}.json?load_relations=${encodeURIComponent('["ItemAttributes"]')}`);
    const item = (res.Item ?? {}) as Record<string, unknown>;
    const attrs = (item.ItemAttributes ?? null) as Record<string, unknown> | null;
    const named: Record<string, string> = {};
    if (attrs) {
      this.attributeSets ??= this.request<Record<string, unknown>>("GET", "ItemAttributeSet.json").then((r) => {
        const m = new Map<string, string[]>();
        for (const set of asList<Record<string, unknown>>(r, "ItemAttributeSet")) {
          m.set(String(set.itemAttributeSetID), [String(set.attributeName1 ?? ""), String(set.attributeName2 ?? ""), String(set.attributeName3 ?? "")]);
        }
        return m;
      });
      const names = (await this.attributeSets).get(String(attrs.itemAttributeSetID ?? "")) ?? ["", "", ""];
      (["attribute1", "attribute2", "attribute3"] as const).forEach((k, i) => {
        const v = String(attrs[k] ?? "").trim();
        if (v) named[names[i] || k] = v;
      });
    }
    const matrixID = String(item.itemMatrixID ?? "0");
    let matrixName: string | null = null;
    if (matrixID !== "0") {
      let p = this.matrixNames.get(matrixID);
      if (!p) {
        p = this.request<Record<string, unknown>>("GET", `ItemMatrix/${matrixID}.json`).then((r) => String((r.ItemMatrix as Record<string, unknown> | undefined)?.description ?? ""));
        this.matrixNames.set(matrixID, p);
      }
      matrixName = (await p) || null;
    }
    return splitItemDescription(description, named, matrixName);
  }

  async createWorkorder(body: Record<string, unknown>): Promise<string> {
    const res = await this.request<{ Workorder?: { workorderID: string } }>("POST", "Workorder.json", body);
    return String(res.Workorder?.workorderID);
  }

  async updateWorkorder(id: string, body: Record<string, unknown>): Promise<void> {
    await this.request("PUT", `Workorder/${id}.json`, body);
  }
}

// ── sync ────────────────────────────────────────────────────────────────────

/** Human status name shown in Lightspeed (and matched by Ikeono automations). */
export function statusNameFor(key: string): string {
  const words = key.replace(/_/g, " ");
  return `Pickup: ${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** Message keys that Lightspeed statuses exist for, in Lightspeed sort order. */
export const STATUS_KEYS = [
  "bike_arrived",
  "booked",
  "rescheduled",
  "reminder_day_before",
  "nudge_day_3",
  "nudge_day_7",
  "hold_ending",
  "storage_started",
  "cancelled",
  "missed",
  "deferred",
  "completed",
] as const;

export type SyncArgs = {
  showroom: ShowroomCtx;
  unit: Unit;
  order: Order | null;
  metric: Metric;
};

export type SyncResult =
  | { workorderID: string; workorderStatusID: number | null; created: boolean; datesOnly?: boolean }
  | { skipped: true; reason: string };

async function activeAppointment(dbx: Db, unitId: string): Promise<Appointment | null> {
  const [a] = await dbx
    .select()
    .from(appointments)
    .where(and(eq(appointments.unitId, unitId), eq(appointments.status, "booked")))
    .orderBy(desc(appointments.startsAt))
    .limit(1);
  return a ?? null;
}

/** "Saturday 10:00 am (5 Sep)" — weekday and time first, the date as a tie-breaker. Fits Hook Out. */
function shortWhen(instant: Date, tz: string): string {
  return `${formatInTimeZone(instant, tz, "EEEE h:mm aaa")} (${formatInTimeZone(instant, tz, "d MMM")})`;
}

function receiptNote(showroom: ShowroomCtx, unit: Unit, appt: Appointment | null, buildBy: LocalDate | null, assemblyDue: Date | null): string {
  const tz = showroom.timezone;
  const bike = [unit.model, unit.colour, unit.size].filter(Boolean).join(" · ");
  const slot = appt ? `CUSTOMER PICKUP ${formatDateTime(appt.startsAt, tz)}` : "Pickup not booked yet";
  const build = assemblyDue
    ? `BUILD BY: ${formatDateTime(assemblyDue, tz)} (Due on this work order)`
    : buildBy
      ? `BUILD BY: end of ${formatLongDateFromLocal(buildBy)}`
      : "";
  const hold = unit.pickupBy ? `Free hold until ${formatLongDate(unit.pickupBy, tz)}` : "";
  const urls = customerUrls(unit);
  // Build deadline before the pickup slot: the mechanic reads this top-down.
  return [`PICKUP · ${bike} · box ${unit.boxTag}`, build, slot, hold, urls ? `Manage: ${urls.manage_url}` : ""]
    .filter(Boolean)
    .join("\n");
}

/**
 * Mirror one customer message onto the unit's Lightspeed work order, creating the customer,
 * Customer Item and work order on first contact. Idempotent per message: re-running with the
 * same metric sets the same status.
 */
export async function syncUnitToLightspeed(dbx: Db, args: SyncArgs): Promise<SyncResult> {
  const { showroom, metric } = args;
  const ls = showroom.settings.lightspeed;
  if (!lightspeedEnabled(showroom)) throw new LightspeedError("Lightspeed bridge is not enabled for this showroom");
  const key = metricKey(metric);
  const statusID: number | undefined = ls.statuses[key];

  // Re-read ids: the caller's snapshot may predate an earlier sync in the same flush.
  const [unit] = await dbx.select().from(units).where(eq(units.id, args.unit.id));
  // Unmapped messages are Klaviyo-only for *status* purposes (README "Lightspeed bridge") — but when the
  // work order already exists, its dates, Hook Out and note must still follow a reschedule or
  // cancellation. So: no work order + unmapped → skip; existing work order → update dates, keep status.
  if (statusID === undefined && !unit.lsWorkorderId) return { skipped: true, reason: `no status mapped for '${key}'` };
  const order = unit.orderId
    ? ((await dbx.select().from(orders).where(eq(orders.id, unit.orderId)))[0] ?? args.order)
    : args.order;
  if (!order) throw new LightspeedError("Unit has no order to mirror");

  const client = new LightspeedClient(dbx);
  const appt = await activeAppointment(dbx, unit.id);
  // Assembly deadline (src/lib/build-schedule.ts): in "assembly" mode the instant becomes the work
  // order's Due; in "pickup" mode Due stays the customer's slot and only the date is noted.
  let buildBy: LocalDate | null = null;
  let assemblyDue: Date | null = null;
  if (appt) {
    const { rules, overrides } = await getCapacityConfig(dbx, showroom.id);
    const d = buildDeadline(showroom, appt, rules, overrides);
    buildBy = d.date;
    assemblyDue = d.at;
  }

  let customerID = order.lsCustomerId;
  if (!customerID) {
    customerID = await client.createCustomer(order);
    await dbx.update(orders).set({ lsCustomerId: customerID }).where(eq(orders.id, order.id));
  }
  let serializedID = unit.lsSerializedId;
  if (!serializedID) {
    serializedID = await client.createSerialized(unit, customerID);
    await dbx.update(units).set({ lsSerializedId: serializedID }).where(eq(units.id, unit.id));
  }

  const common: Record<string, unknown> = {
    ...(statusID !== undefined ? { workorderStatusID: statusID } : {}),
    note: receiptNote(showroom, unit, appt, buildBy, assemblyDue),
    internalNote: `Kickstand unit ${baseUrl()}/app/units/${unit.id}`,
    hookIn: unit.boxTag,
    // ETA Out drives Lightspeed's work-order calendar and Ikeono's {ETA Out} smart field, so it is
    // always the customer's pickup slot when booked; the assembly deadline rides in Hook Out and
    // the note. Unbooked: end of the free hold (Lightspeed would default it to "now").
    ...(appt
      ? assemblyDue
        ? {
            etaOut: assemblyDue.toISOString(),
            // Build deadline first and loud — that is what the mechanic reads off Hook Out.
            hookOut: `BUILD BY: ${shortWhen(assemblyDue, showroom.timezone)} · Pickup ${shortWhen(appt.startsAt, showroom.timezone)}`,
          }
        : {
            etaOut: appt.startsAt.toISOString(),
            hookOut: `BUILD BY: end of ${formatShortDateFromLocal(buildBy!)} · Pickup ${shortWhen(appt.startsAt, showroom.timezone)}`,
          }
      : unit.pickupBy
        ? { etaOut: unit.pickupBy.toISOString(), hookOut: `Not booked · hold until ${formatLongDate(unit.pickupBy, showroom.timezone)}` }
        : {}),
  };

  let workorderID = unit.lsWorkorderId;
  let created = false;
  if (!workorderID) {
    if (statusID === undefined) return { skipped: true, reason: `no status mapped for '${key}'` };
    // Create in the neutral "Open" status, then apply the mapped status as a separate change so
    // Ikeono's status-change automations always see a transition (a work order that appears
    // already in a status is not reliably treated as a change).
    workorderID = await client.createWorkorder({
      shopID: ls.shop_id,
      customerID: Number(customerID),
      serializedID: Number(serializedID),
      ...(ls.employee_id ? { employeeID: ls.employee_id } : {}),
      timeIn: (unit.receivedAt ?? new Date()).toISOString(),
      warranty: false,
      ...common,
      workorderStatusID: ls.open_status_id,
    });
    created = true;
    await dbx.update(units).set({ lsWorkorderId: workorderID }).where(eq(units.id, unit.id));
    if (statusID !== ls.open_status_id) await client.updateWorkorder(workorderID, { workorderStatusID: statusID });
  } else {
    await client.updateWorkorder(workorderID, common);
  }
  logger.info({ unitId: unit.id, workorderID, key, statusID: statusID ?? null, created, datesOnly: statusID === undefined }, "lightspeed sync");
  return { workorderID, workorderStatusID: statusID ?? null, created, ...(statusID === undefined ? { datesOnly: true } : {}) };
}
