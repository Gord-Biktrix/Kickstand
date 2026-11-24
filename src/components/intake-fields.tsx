import { INTAKE_FIELDS, type Intake } from "@/lib/intake";

/**
 * The bike's condition at check-in, as form fields (odometer, then one row of choices per check). Used inside
 * New ticket's form and the job page's Check in form; posts intake_odometer and intake_<field>.
 */
export function IntakeFields({ value, idPrefix = "intake" }: { value?: Intake | null; idPrefix?: string }) {
  return (
    <div className="grid gap-2">
      <label className="grid grid-cols-[110px_minmax(0,1fr)] items-center gap-2 text-sm">
        <span className="font-semibold">Odometer</span>
        <span className="flex items-center gap-2">
          <input id={`${idPrefix}-odometer`} name="intake_odometer" aria-label="Odometer in km" inputMode="numeric" defaultValue={value?.odometer ?? ""} placeholder="0" className="input h-10 w-28 text-base" />
          <span className="text-muted">km</span>
        </span>
      </label>
      {INTAKE_FIELDS.map((f) => (
        <fieldset key={f.key} className="grid grid-cols-[110px_minmax(0,1fr)] items-center gap-2 text-sm">
          <legend className="sr-only">{f.label}</legend>
          <span aria-hidden className="font-semibold">{f.label}</span>
          <span className="flex flex-wrap gap-1.5">
            {Object.entries(f.options).map(([v, text]) => (
              <label key={v} className="inline-flex min-h-10 cursor-pointer items-center rounded-lg border border-border bg-card px-3 font-semibold has-checked:border-[#015d47] has-checked:bg-[#015d47] has-checked:text-white has-focus-visible:outline-2 has-focus-visible:outline-[#ff6b1a]">
                <input type="radio" name={`intake_${f.key}`} value={v} defaultChecked={value?.[f.key] === v} className="sr-only" />
                {text}
              </label>
            ))}
          </span>
        </fieldset>
      ))}
    </div>
  );
}
