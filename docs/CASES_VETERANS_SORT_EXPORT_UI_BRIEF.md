# UI Brief — Sortable column headers + Excel export on the Cases AND Veterans lists

Audience: ChatGPT (compact-EMR frontend). Ryan 2026-06-03. **Frontend-only** — no backend change
needed at current scale (each list fits one page). If a list ever exceeds one page, switch to
backend sort/export params (follow-up note at the bottom).

Files:
- Cases list: `frontend/src/routes/cases/CasesPage.tsx` (table headers at line ~84: Case, Veteran,
  Condition, Type, Status, Updated, v)
- Veterans list: `frontend/src/routes/veterans/VeteransPage.tsx` (columns: Veteran, DOB, Branch,
  Active Cases, Last Activity)

(Ryan dropped the earlier "Assigned RN / Physician columns" idea — those are per-case, not list-level.
Do NOT add them.)

## 1. Sortable column headers (both pages)
Make each column header a clickable sort control over the **already-loaded rows** (client-side):
- Click a header → sort by that column ascending; click again → descending; a third click → back to
  default order (the server's existing order). Show a ▲/▼ indicator on the active column.
- Keep it accessible: header is a `<button>` inside the `<th>`, `aria-sort="ascending|descending|none"`.
- Sort comparators by column type:
  - **Text** (Veteran name, Condition, Type, Status label, Branch): case-insensitive `localeCompare`.
  - **Date** (Updated, Last Activity, DOB): compare by timestamp; treat null/"—" as oldest.
  - **Number** (v / version, Active Cases): numeric.
- Sort the array the table maps over; don't refetch. Default (unsorted) view stays exactly as today.

## 2. Excel export button (both pages)
Add an **"Export to Excel"** button near the page heading / filter row.
- On click, export the **currently displayed rows** — i.e. after the active filters AND the active
  sort — to a **CSV** file (Excel opens CSV natively; no new dependency required). If you prefer a
  true .xlsx, `jszip` is already a dependency, but CSV is simpler and sufficient — your call.
- Columns = the visible table columns, with a header row. For Cases: Case ID, Veteran, Condition,
  Type, Status (the human label, e.g. "Drafting"), Updated (ISO or the displayed date), Version.
  For Veterans: Veteran, MRN, DOB, Branch, Active Cases, Last Activity.
- CSV correctness: quote any field containing a comma, quote, or newline; escape `"` as `""`; UTF-8.
- Filename: `cases-export-YYYY-MM-DD.csv` / `veterans-export-YYYY-MM-DD.csv`. Trigger via a Blob +
  a temporary `<a download>` (no server round-trip).
- A tiny shared helper (`exportRowsToCsv(filename, headers, rows)`) used by both pages keeps it DRY.

## Tests
- A unit test for the CSV helper (escaping: a value with a comma + a value with a quote round-trip
  correctly; header row present).
- A sort test on one page: clicking a header reorders rows asc → desc → default; the indicator
  reflects state.

## Follow-up (NOT now)
Sorting/exporting only covers the loaded page. At current volume both lists are a single page, so
this is complete. When either list routinely exceeds one page, add backend `sortBy`/`sortDir` query
params (the Cases list endpoint already has `where`-building; add an `orderBy` switch) and have the
export hit a server endpoint that streams all matching rows — so sort/export reflect the full set,
not just the visible page. Flagging so it's a conscious choice, not a silent cap.
