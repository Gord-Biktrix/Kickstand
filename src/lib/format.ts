const cad = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" });

export function formatMoney(cents: number): string {
  return cad.format(cents / 100);
}

export function formatMoneyOrEmpty(cents: number): string {
  return cents > 0 ? formatMoney(cents) : "";
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function titleCase(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
