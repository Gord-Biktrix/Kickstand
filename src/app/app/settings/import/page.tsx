import { Card, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { CsvImport } from "./csv-import";

export const metadata = { title: "Import" };

/**
 * One-off migration of existing pre-orders (SPEC Appendix A). Lives under Settings rather than on
 * Arrivals (a deviation from §10.2, see README) because it is not delivery-day work.
 */
export default async function ImportPage() {
  await requireUser("manager");
  return (
    <div>
      <PageHeader title="Import" subtitle="Load existing pre-orders from a CSV. Preview first; rows with errors are rejected individually." />
      <Card title="Import existing pre-orders (CSV)">
        <p className="mb-3 text-xs text-muted">
          Header: order_ref, source, customer_name, customer_email, customer_phone, model, size, colour, order_date, payment_status, balance_cents, notes. One row per bike. Rows import with terms v1.
        </p>
        <CsvImport />
      </Card>
    </div>
  );
}
