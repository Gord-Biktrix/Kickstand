import Link from "next/link";
import { redirect } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { orders, units } from "@/db/schema";
import { StatusBadge } from "@/components/status-badge";
import { Alert, Card, Field, Flash, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { getAvailability } from "@/lib/availability";
import { groupUnitIds } from "@/lib/booking";
import { bookableSiblings } from "@/lib/units";
import type { DaySummary } from "@/lib/capacity";
import { sp, type SearchParams } from "@/lib/flash";
import { formatMoney } from "@/lib/format";
import { customerKey } from "@/lib/customers";
import { getConnection, LightspeedClient, type SaleLineInfo } from "@/lib/lightspeed";
import { logger } from "@/lib/logger";
import { getUnitView } from "@/lib/queries";
import { formatLongDateFromLocal, formatShortDateFromLocal, formatTime, toLocalDate } from "@/lib/time";
import { staffBookAction, staffPrepareUnitAction, staffRescheduleAction } from "../actions";
import { currentShowroom, showroomForLightspeedShop } from "@/lib/current-showroom";
import { listShowrooms } from "@/lib/showroom";

export const metadata = { title: "Book pickup" };

const ACTIVE = ["received", "invited", "booked", "building", "ready"] as const;

/**
 * Staff booking on the customer's behalf (README "Book pickup button").
 *
 * Entry points:
 *  - Lightspeed Custom Button ("Open Web Page" → {APP_BASE_URL}/app/book): Lightspeed appends
 *    customerID, saleID, shopID, employeeID … We use customerID / saleID to find or prefill.
 *  - Unit page "Book for customer": /app/book?unit=<id>.
 *
 * Steps: find an existing Kickstand unit for this customer → otherwise a short "new pickup" form
 * (prefilled from Lightspeed) that creates the order, receives the box and mints the link →
 * slot picker → confirm. Staff may allow short notice.
 */
export default async function StaffBookPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const q = await searchParams;
  const user = await requireUser("staff");
  const showroom = await currentShowroom();
  const tz = showroom.timezone;
  const now = new Date();
  const flash = <Flash ok={sp(q.ok)} error={sp(q.error)} />;

  // ── Step 3/4: slot picker for a known unit ─────────────────────────────────
  const unitParam = sp(q.unit);
  if (unitParam) {
    const view = await getUnitView(db, unitParam);
    if (!view) return <div><PageHeader title="Book pickup" />{flash}<Alert tone="danger">Unit not found.</Alert></div>;
    const { unit, order, appointment } = view;
    const reschedule = sp(q.reschedule) === "1" && !!appointment;
    if (appointment && !reschedule) {
      return (
        <div>
          <PageHeader title="Book pickup" subtitle={`${order?.customerName ?? "—"} · ${unit.model} · box ${unit.boxTag}`} />
          {flash}
          <Alert tone="ok">Already booked for {formatLongDateFromLocal(appointment.onDate)} at {formatTime(appointment.startsAt, tz)}.{" "}
            <Link className="underline" href={`/app/book?unit=${unit.id}&reschedule=1`}>Reschedule</Link> · <Link className="underline" href={`/app/units/${unit.id}`}>Open the bike</Link>
          </Alert>
        </div>
      );
    }
    if (!["invited", "building", "ready", ...(reschedule ? ["booked"] : [])].includes(unit.status)) {
      return <div><PageHeader title="Book pickup" />{flash}<Alert tone="warn">This unit is {unit.status} and can&apos;t be booked. <Link className="underline" href={`/app/units/${unit.id}`}>Open the unit</Link>.</Alert></div>;
    }
    const siblings = reschedule ? [] : await bookableSiblings(db, showroom, unit, order);
    const visitSize = reschedule && appointment ? (await groupUnitIds(db, appointment)).length : 1 + siblings.length;
    const days = (await getAvailability(db, { showroom, unit, order, now, count: visitSize })).filter((d) => !d.day.closed && !d.beyondHorizon);
    const selectedDate = sp(q.date);
    const selectedTime = sp(q.time);
    const shortNotice = sp(q.short) === "1";
    const selected: DaySummary | undefined = selectedDate ? days.find((d) => d.date === selectedDate) : undefined;
    const slot = selected && selectedTime ? selected.slots.find((sl) => sl.startLocal === selectedTime) : undefined;
    const base = `/app/book?unit=${unit.id}&${reschedule ? "reschedule=1&" : ""}${shortNotice ? "short=1&" : ""}`;
    const today = toLocalDate(now, tz);

    return (
      <div>
        <PageHeader
          title={reschedule ? "Reschedule pickup" : "Book pickup"}
          subtitle={<>{order?.customerName ?? "—"} · {unit.model} · {[unit.size, unit.colour].filter(Boolean).join(" · ")} · box {unit.boxTag} · <StatusBadge status={unit.status} />{visitSize > 1 && <> · {visitSize} bikes in this visit</>}</>}
          action={<Link href={`/app/units/${unit.id}`} className="btn btn-sm">Back to bike</Link>}
        />
        {flash}
        {reschedule && appointment && (
          <Alert tone="neutral">
            Currently {formatLongDateFromLocal(appointment.onDate)} at {formatTime(appointment.startsAt, tz)}. Pick the new time below; the customer is texted the change.
            {appointment.startsAt.getTime() - now.getTime() < showroom.settings.reschedule_cutoff_hours * 3600_000 && <> The slot is inside the {showroom.settings.reschedule_cutoff_hours}-hour cutoff, so moving it counts as a missed pickup.</>}
          </Alert>
        )}
        <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
          <Card title={slot ? "Confirm" : selected ? formatLongDateFromLocal(selected.date) : "Pick a day"}>
            {slot ? (
              <form action={(reschedule ? staffRescheduleAction : staffBookAction).bind(null, unit.id)} className="space-y-4">
                <input type="hidden" name="starts_at" value={slot.startsAt.toISOString()} />
                {shortNotice && <input type="hidden" name="short_notice" value="1" />}
                <p className="text-xl font-semibold">{formatLongDateFromLocal(selected!.date)}</p>
                <p className="text-lg">{formatTime(slot.startsAt, tz)} – {formatTime(slot.endsAt, tz)}</p>
                {slot.reason === "too_early" && shortNotice && <Alert tone="warn">Inside the {showroom.settings.min_lead_hours}-hour notice window. Make sure the bike can be built in time.</Alert>}
                {slot.storageApplies && slot.storageEstimateCents > 0 && <Alert tone="warn">Storage of about {formatMoney(slot.storageEstimateCents)} will be due at pickup.</Alert>}
                {order && order.balanceCents > 0 && <p className="text-sm text-muted">Balance due at handover: {formatMoney(order.balanceCents)}.</p>}
                {siblings.length > 0 && (
                  <fieldset className="rounded-lg border border-border p-3">
                    <legend className="px-1 text-sm font-medium">Collect together</legend>
                    <p className="mb-2 text-xs text-muted">This customer has other bikes in the building. Ticked bikes are booked into the same visit (each counts against capacity).</p>
                    {siblings.map((sib) => (
                      <label key={sib.unit.id} className="flex items-start gap-3 py-1 text-sm">
                        <input type="checkbox" name="unit_ids" value={sib.unit.id} defaultChecked className="mt-1 h-4 w-4" />
                        <span>{sib.unit.model} <span className="text-muted">· {[sib.unit.size, sib.unit.colour].filter(Boolean).join(" · ")} · box {sib.unit.boxTag} · {sib.order.source} {sib.order.orderRef}</span></span>
                      </label>
                    ))}
                  </fieldset>
                )}
                <label className="flex items-start gap-3 text-sm">
                  <input type="checkbox" name="sms_consent" defaultChecked={order?.smsConsent ?? false} className="mt-1 h-4 w-4" />
                  <span>Customer agrees to text reminders{order?.customerPhone ? ` at ${order.customerPhone}` : ""}.</span>
                </label>
                <div className="flex gap-2">
                  <Link href={`${base}date=${selected!.date}`} className="btn">Back</Link>
                  <button type="submit" className="btn btn-primary">{reschedule ? "Move booking" : "Confirm booking"}</button>
                </div>
              </form>
            ) : selected ? (
              <>
                <p className="mb-3 text-sm text-muted">{selected.remaining} of {selected.day.capacity} pickups left this day.</p>
                <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {selected.slots.map((sl) => {
                    const ok = sl.available || (shortNotice && sl.reason === "too_early");
                    return (
                      <li key={sl.startLocal}>
                        {ok ? (
                          <Link href={`${base}date=${selected.date}&time=${sl.startLocal}`} className={`btn w-full ${sl.available ? "" : "border-warn/40 bg-warn-soft"}`}>{formatTime(sl.startsAt, tz)}</Link>
                        ) : (
                          <span className="btn w-full cursor-not-allowed text-muted line-through">{formatTime(sl.startsAt, tz)}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
                <Link href={base} className="mt-3 inline-block text-sm text-accent underline">← All days</Link>
              </>
            ) : (
              <ul className="divide-y divide-border">
                {days.map((d) => {
                  const openable = d.bookable || (shortNotice && d.reason === "too_soon");
                  const label = d.reason === "too_soon" ? (shortNotice ? "short notice" : "too soon") : d.reason === "full" ? "full" : `${d.remaining} of ${d.day.capacity} left`;
                  return (
                    <li key={d.date} className="flex items-center gap-3 py-2 text-sm">
                      {openable ? (
                        <Link href={`${base}date=${d.date}`} className="font-medium hover:text-accent">{formatShortDateFromLocal(d.date)}{d.date === today ? " (today)" : ""}</Link>
                      ) : (
                        <span className="text-muted">{formatShortDateFromLocal(d.date)}</span>
                      )}
                      <span className={`ml-auto text-xs ${openable ? (d.bookable ? "text-ok" : "text-warn") : "text-muted"}`}>{label}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
          <div className="space-y-4">
            <Card title="Short notice">
              <p className="text-sm text-muted">Customers need {showroom.settings.min_lead_hours} hours&apos; notice so the bike can be built. Staff can book sooner when the bike is already built or the customer is waiting.</p>
              <Link href={`/app/book?unit=${unit.id}${reschedule ? "&reschedule=1" : ""}${shortNotice ? "" : "&short=1"}`} className={`btn btn-sm mt-3 ${shortNotice ? "btn-primary" : ""}`}>
                {shortNotice ? "Short notice: ON" : "Allow short notice"}
              </Link>
            </Card>
            {order && (
              <Card title="Customer">
                <p className="font-medium">{order.customerName}</p>
                <p className="text-sm text-muted">{order.customerEmail ?? "—"}<br />{order.customerPhone ?? "—"}</p>
                <p className="mt-2 text-xs text-muted">{order.source} {order.orderRef} · {order.paymentStatus === "deposit" ? `balance ${formatMoney(order.balanceCents)}` : "paid"}</p>
              </Card>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Step 1/2: from the Lightspeed button — find or prefill ─────────────────
  const customerID = sp(q.customerID) ?? "";
  const saleID = sp(q.saleID) ?? "";
  // The button is account-wide in Lightspeed, so every store sees it. shopID tells us which register
  // pressed it: switch to that store's showroom, or explain that pickups aren't live there yet.
  const shopID = sp(q.shopID) ?? "";
  if (shopID) {
    const target = await showroomForLightspeedShop(db, shopID);
    if (!target) {
      return (
        <div>
          <PageHeader title="Book pickup" />
          <Alert tone="neutral">
            Pickup booking isn&apos;t live at this location yet (Lightspeed shop #{shopID}). Nothing has been booked — you can close this tab.
            Live at: {(await listShowrooms(db)).filter((s) => s.settings.lightspeed.shop_id !== null).map((s) => s.name).join(", ") || "no store yet"}.
          </Alert>
        </div>
      );
    }
    if (target.id !== showroom.id) {
      const here = new URLSearchParams();
      for (const [k, v] of Object.entries(q)) { const val = sp(v); if (val) here.set(k, val); }
      redirect(`/app/switch?showroom=${encodeURIComponent(target.slug)}&next=${encodeURIComponent(`/app/book?${here.toString()}`)}`);
    }
  }
  const returnQuery = new URLSearchParams({ ...(customerID ? { customerID } : {}), ...(saleID ? { saleID } : {}) }).toString();

  // Existing Kickstand orders for this Lightspeed customer or sale, with any active unit.
  const matches = customerID || saleID
    ? await db
        .select({ order: orders, unit: units })
        .from(orders)
        .leftJoin(units, and(eq(units.orderId, orders.id), inArray(units.status, [...ACTIVE])))
        .where(
          and(
            eq(orders.showroomId, showroom.id),
            inArray(orders.status, ["open", "deferred"]),
            customerID ? eq(orders.lsCustomerId, customerID) : and(eq(orders.source, "lightspeed"), eq(orders.orderRef, saleID)),
          ),
        )
    : [];
  const withUnit = matches.filter((m) => m.unit);
  const forceNew = sp(q.new) === "1";
  // A sale number that differs from the bike we know about usually means a second bike for a
  // repeat customer — don't jump to the existing one, show both choices below instead.
  const saleMatchesKnownBike = !saleID || withUnit.some((m) => m.order.orderRef === saleID);
  if (!forceNew && saleMatchesKnownBike && withUnit.length === 1 && withUnit[0].unit && !["received"].includes(withUnit[0].unit.status)) {
    // One live bike → straight to its slot picker, with a way out for a different bike.
    return (
      <div>
        <PageHeader title="Book pickup" />
        <Alert tone="ok">
          Found {withUnit[0].order.customerName}&apos;s {withUnit[0].unit.model} (box {withUnit[0].unit.boxTag}).{" "}
          <Link className="underline" href={`/app/book?unit=${withUnit[0].unit.id}`}>Continue to the slot picker →</Link>
        </Alert>
        <p className="mt-3 flex flex-wrap gap-4 text-sm text-muted">
          <span>Different bike? <Link className="underline" href={`/app/book?${returnQuery}&new=1`}>Start a new pickup for this customer →</Link></span>
          <Link className="underline" href={`/app/customers/${encodeURIComponent(customerKey(withUnit[0].order))}`}>View customer</Link>
        </p>
      </div>
    );
  }
  const secondBike = withUnit.length > 0 && (forceNew || !saleMatchesKnownBike);

  // Prefill from Lightspeed when connected.
  let ls: { name: string; email: string | null; phone: string | null } | null = null;
  let sale: { createDate: string | null; lines: SaleLineInfo[] } | null = null;
  let lsError: string | null = null;
  let saleLines: SaleLineInfo[] = [];
  if ((customerID || saleID) && (await getConnection(db))) {
    try {
      const client = new LightspeedClient(db);
      if (saleID) sale = await client.getSale(saleID);
      const cid = customerID || (sale && "customerID" in sale ? (sale as { customerID: string | null }).customerID : null);
      if (cid) ls = await client.getCustomer(cid);
      // Special-order items are not on the sale until completed; they hang off the customer.
      if (cid && !(sale?.lines.length)) saleLines = await client.getSpecialOrderLines(cid);
    } catch (err) {
      lsError = err instanceof Error ? err.message : String(err);
      logger.warn({ err: lsError }, "book pickup: lightspeed prefill failed");
    }
  }
  if (sale?.lines.length) saleLines = sale.lines;
  const bike = saleLines[0];

  return (
    <div>
      <PageHeader title="Book pickup" subtitle="Book a pickup for a customer at the counter or on the phone. The bike must be in the building." />
      {flash}
      {lsError && <Alert tone="warn">Couldn&apos;t read from Lightspeed ({lsError}). Fill the details in by hand.</Alert>}
      {!customerID && !saleID && <Alert tone="neutral">Opened without a Lightspeed customer. Search the order on <Link className="underline" href="/app/arrivals">Arrivals</Link> instead, or fill in a new pickup below.</Alert>}
      {secondBike && <Alert tone="neutral">This customer already has a bike in Kickstand. If this sale is for that bike, use <strong>Book this bike</strong>; otherwise fill in the new pickup. <Link className="underline" href={`/app/customers/${encodeURIComponent(customerKey(withUnit[0].order))}`}>View customer</Link></Alert>}

      <div className="grid gap-6 lg:grid-cols-2">
        {matches.length > 0 && (
          <Card title="Existing orders for this customer">
            <ul className="divide-y divide-border">
              {matches.map(({ order, unit }) => (
                <li key={order.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div>
                    <p className="font-medium">{order.customerName} <span className="text-xs text-muted">{order.source} {order.orderRef}</span></p>
                    <p className="text-sm">{order.model} · {[order.size, order.colour].filter(Boolean).join(" · ")} <StatusBadge status={order.status} /></p>
                  </div>
                  {unit ? (
                    <Link href={`/app/book?unit=${unit.id}`} className="btn btn-primary btn-sm">Book this bike</Link>
                  ) : (
                    <form action={staffPrepareUnitAction} className="flex items-end gap-2">
                      <input type="hidden" name="order_id" value={order.id} />
                      <input type="hidden" name="return_query" value={returnQuery} />
                      <Field label="Box tag (optional)" htmlFor={`bt-${order.id}`}><input id={`bt-${order.id}`} name="box_tag" className="input w-36" placeholder={`blank = ${order.orderRef}`} /></Field>
                      <button type="submit" className="btn btn-primary btn-sm">Receive and book</button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card title="New pickup">
          <form action={staffPrepareUnitAction} className="grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="return_query" value={returnQuery} />
            <input type="hidden" name="ls_customer_id" value={customerID || ""} />
            <input type="hidden" name="source" value="lightspeed" />
            {forceNew && <input type="hidden" name="force_new" value="1" />}
            <Field label="Customer name" htmlFor="customer_name"><input id="customer_name" name="customer_name" required className="input" defaultValue={ls?.name ?? ""} /></Field>
            <Field label="Sale / order #" htmlFor="order_ref" hint={forceNew && withUnit.some((m) => m.order.orderRef === saleID) ? `Second bike on sale ${saleID} — it will be saved as ${saleID}-2 so each bike has its own number.` : "Lightspeed sale number. Any unique reference works."}><input id="order_ref" name="order_ref" required className="input" defaultValue={saleID || (customerID ? `C${customerID}-${toLocalDate(now, tz)}` : "")} /></Field>
            <Field label="Email" htmlFor="customer_email"><input id="customer_email" name="customer_email" type="email" className="input" defaultValue={ls?.email ?? ""} /></Field>
            <Field label="Mobile" htmlFor="customer_phone"><input id="customer_phone" name="customer_phone" className="input" defaultValue={ls?.phone ?? ""} /></Field>
            <Field label="Model" htmlFor="model" hint={saleLines.length > 1 ? `Sale lines: ${saleLines.map((l) => l.description).join("; ")}` : undefined}>
              <input id="model" name="model" required className="input" defaultValue={bike?.model ?? ""} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Size" htmlFor="size"><input id="size" name="size" className="input" defaultValue={bike?.size ?? ""} /></Field>
              <Field label="Colour" htmlFor="colour"><input id="colour" name="colour" className="input" defaultValue={bike?.colour ?? ""} /></Field>
            </div>
            <Field label="Box tag (optional)" htmlFor="box_tag" hint="Blank uses the sale number."><input id="box_tag" name="box_tag" className="input" /></Field>
            <Field label="Order date" htmlFor="order_date"><input id="order_date" name="order_date" type="date" className="input" defaultValue={sale?.createDate ?? toLocalDate(now, tz)} /></Field>
            <Field label="Payment" htmlFor="payment_status">
              <select id="payment_status" name="payment_status" className="input" defaultValue="paid"><option value="paid">Paid in full</option><option value="deposit">Deposit — balance due</option></select>
            </Field>
            <Field label="Balance due ($)" htmlFor="balance"><input id="balance" name="balance" inputMode="decimal" className="input" defaultValue="0.00" /></Field>
            <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name="sms_consent" className="h-4 w-4" /> Customer agrees to text reminders</label>
            <div className="sm:col-span-2"><button type="submit" className="btn btn-primary">Receive and choose a time</button></div>
          </form>
          <p className="mt-3 text-xs text-muted">Signed in as {user.name}. Creating the order, receiving the box and minting the customer link happen together; the Bike Arrived message is skipped because you&apos;re booking now.</p>
        </Card>
      </div>
    </div>
  );
}
