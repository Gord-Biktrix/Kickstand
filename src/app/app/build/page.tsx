import { redirect } from "next/navigation";

/** The build board is now the "Booked" filter on the Bikes page (build-by dates and Build buttons live there). */
export default function BuildBoardRedirect() {
  redirect("/app/bikes?filter=booked");
}
