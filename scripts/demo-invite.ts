import { config } from "dotenv";
import { eq } from "drizzle-orm";
import { createDb } from "../src/db/client";
import { orders } from "../src/db/schema";
import { customerUrls } from "../src/lib/messages";
import { getShowroom } from "../src/lib/showroom";
import { inviteUnit, receiveUnit } from "../src/lib/units";

config({ path: process.env.ENV_FILE ?? ".env.local" });

/**
 * Dev/staging helper: receive a box for an open order and send the invite, printing the
 * customer link. Usage: pnpm demo:invite <order_ref> <box_tag>
 */
async function main() {
  const [orderRef, boxTag] = process.argv.slice(2);
  if (!orderRef || !boxTag) {
    console.error("Usage: pnpm demo:invite <order_ref> <box_tag>");
    process.exit(1);
  }
  const db = createDb(process.env.DATABASE_URL!);
  const showroom = await getShowroom(db);
  const [order] = await db.select().from(orders).where(eq(orders.orderRef, orderRef));
  if (!order) throw new Error(`No order with ref ${orderRef}`);
  const unit = await receiveUnit(db, { showroom, orderId: order.id, boxTag, actor: "demo-script" });
  const { unit: invited } = await inviteUnit(db, { showroom, unitId: unit.id, actor: "demo-script" });
  console.log(`${order.customerName} — ${invited.model} (box ${boxTag})`);
  console.log(customerUrls(invited)?.landing_url);
  await db.$client.end();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
