/** Text helpers safe for the browser too (the Messages composer counts segments while typing). */

// GSM-7: what fits 160 characters to a segment. Anything else (emoji, curly quotes, most accents) drops it to 70.
const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXT = "^{}\\[~]|€\f";

/** How many SMS segments Twilio will charge for this body. */
export function segmentCount(body: string): number {
  if (!body) return 0;
  let gsm = true;
  let units = 0;
  for (const ch of body) {
    if (GSM_BASIC.includes(ch)) units += 1;
    else if (GSM_EXT.includes(ch)) units += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) return units <= 160 ? 1 : Math.ceil(units / 153);
  const len = [...body].reduce((n, ch) => n + (ch.codePointAt(0)! > 0xffff ? 2 : 1), 0);
  return len <= 70 ? 1 : Math.ceil(len / 67);
}

/** Curly quotes and dashes from phones and word processors would make every text cost 2–3× (see segmentCount). */
export function plainText(body: string): string {
  return body
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/ /g, " ");
}
