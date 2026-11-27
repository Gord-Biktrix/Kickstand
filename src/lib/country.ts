/**
 * Where a booking came from, when the website embed says so (data-country="US" on the US site). Sent to Klaviyo
 * as the profile's country, so segments that exclude a country (e.g. "Americans lost in Canada") catch the
 * customer straight away instead of waiting for Klaviyo to guess it from an IP.
 */
export const COUNTRY_NAMES = { US: "United States", CA: "Canada" } as const;
export type CountryCode = keyof typeof COUNTRY_NAMES;

export function countryCode(v: string | null | undefined): CountryCode | null {
  const c = (v ?? "").trim().toUpperCase();
  return c in COUNTRY_NAMES ? (c as CountryCode) : null;
}

export function countryName(v: string | null | undefined): string | null {
  const c = countryCode(v);
  return c ? COUNTRY_NAMES[c] : null;
}
