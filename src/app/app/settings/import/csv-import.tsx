"use client";

import { useActionState } from "react";
import { Alert } from "@/components/ui";
import { importCsvAction, type ImportState } from "../../actions";

export function CsvImport() {
  const [state, action, pending] = useActionState(importCsvAction, { stage: "idle" } as ImportState);
  return (
    <div className="space-y-3">
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.stage === "done" && (
        <Alert tone="ok">Imported {state.imported} order{state.imported === 1 ? "" : "s"}{state.errors?.length ? `; ${state.errors.length} row${state.errors.length === 1 ? "" : "s"} rejected` : ""}.</Alert>
      )}
      {state.stage === "preview" ? (
        <form action={action} className="space-y-3">
          <input type="hidden" name="text" value={state.text} />
          <input type="hidden" name="commit" value="1" />
          <p className="text-sm">
            <strong>{state.valid}</strong> row{state.valid === 1 ? "" : "s"} ready to import as <code>terms_version = 1</code>, status open.
            {state.errors?.length ? ` ${state.errors.length} row${state.errors.length === 1 ? "" : "s"} will be skipped.` : ""}
          </p>
          {state.sample && state.sample.length > 0 && (
            <ul className="text-xs text-muted">
              {state.sample.map((s) => (
                <li key={s.row}>Row {s.row}: {s.customer} — {s.model} ({s.orderRef})</li>
              ))}
              {(state.valid ?? 0) > state.sample.length && <li>…and {(state.valid ?? 0) - state.sample.length} more</li>}
            </ul>
          )}
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary btn-sm" disabled={pending || !state.valid}>{pending ? "Importing…" : `Import ${state.valid} rows`}</button>
            <button type="button" className="btn btn-sm" onClick={() => window.location.reload()}>Start over</button>
          </div>
        </form>
      ) : (
        <form action={action} className="space-y-3">
          <input type="file" name="file" accept=".csv,text/csv" required className="input" aria-label="CSV file" />
          <button type="submit" className="btn btn-sm" disabled={pending}>{pending ? "Checking…" : "Preview import"}</button>
        </form>
      )}
      {state.errors && state.errors.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-danger">{state.errors.length} row error{state.errors.length === 1 ? "" : "s"}</summary>
          <ul className="mt-2 space-y-1">
            {state.errors.map((e) => (
              <li key={e.row}><span className="font-mono">Row {e.row}:</span> {e.message}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
