function icsDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function escape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

export function buildIcs(args: {
  uid: string;
  startsAt: Date;
  endsAt: Date;
  summary: string;
  description: string;
  location: string;
  url?: string;
}): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Biktrix//Pickup//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${args.uid}@pickup.biktrix.com`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(args.startsAt)}`,
    `DTEND:${icsDate(args.endsAt)}`,
    `SUMMARY:${escape(args.summary)}`,
    `DESCRIPTION:${escape(args.description)}`,
    `LOCATION:${escape(args.location)}`,
    ...(args.url ? [`URL:${args.url}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.join("\r\n") + "\r\n";
}
