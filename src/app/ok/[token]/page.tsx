import { redirect } from "next/navigation";
import { db } from "@/db/client";
import { requestByToken } from "@/lib/findings";
import { ensureTracker } from "@/lib/tracker";

export const metadata = { title: "Your bike" };

/**
 * The link in the "Needs your OK" text. What was found is answered on the customer's repair tracker, together with
 * where the bike is at, so this opens the tracker (made now if the job doesn't have one yet).
 */
export default async function FindingsLink({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const found = await requestByToken(db, token);
  if (!found) {
    return (
      <div className="flex min-h-full flex-1 flex-col bg-[#edebe7]">
        <main className="mx-auto w-full max-w-md px-4 py-10">
          <h1 className="text-2xl font-extrabold">This link doesn&apos;t work</h1>
          <p className="mt-2 text-muted">It may have been typed wrong. Call the shop and we&apos;ll sort it out.</p>
        </main>
      </div>
    );
  }
  const { url } = await ensureTracker(db, { showroomId: found.request.showroomId, workorderId: found.request.workorderId, customerName: found.request.customerName });
  redirect(`${new URL(url).pathname}#found`);
}
