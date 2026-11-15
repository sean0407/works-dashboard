# Astra implementation report

Scope: approved design and Task 2 of `../docs/superpowers/plans/2026-11-14-dashboard.md`.

## Delivered source

- `app/page.tsx`, `app/layout.tsx`: dynamic private-workspace entry with the Sites ChatGPT sign-in helper; Traditional Chinese metadata and no indexing.
- `components/dashboard.tsx`, `app/globals.css`, `public/favicon.svg`: responsive dark-green/warm-white dashboard, six views, financial metrics, observed-month trends, customer ranking, follow-ups, stages, quotation versions and items, invoice balances, reconciliation, and accessible case details.
- `lib/domain/analytics.ts`: financial/date/filter/state rules independent of React.
- `lib/domain/schema.json`: copy of the current canonical workbook contract, including quote tax rate/discount and independent revision-signing date/document fields.
- `lib/domain/workbook.ts`: typed canonical parsing; exact header checks; trusted-target read-only connector orchestration; metadata plus ID-column scanning and bounded data pages.
- `lib/server/source-target.json`: verified nonsecret workbook and archive identifiers. Imported only by the server route, so source-based rebuilding does not depend on ignored local files.
- `app/api/data/route.ts`: authenticated same-origin POST, no caller-selected target/actions, private/no-store responses, original connector failure diagnostics and server-generated sign-in recovery path.
- `.openai/hosting.json`: preserved existing Site identity, one eligible Google Drive plugin, connector read-only declaration, no storage or static-only deployment.
- `tests/analytics.test.mjs`, `tests/workbook.test.mjs`: synthetic test data only.
- `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.json`: reproducible pnpm configuration and Node test/typecheck commands. The supplied Vinext Worker, request-scoped connector binding, sign-in, and Sites build integration are preserved.

## Verification to date

- `pnpm test`: **35 passed, 0 failed**. New rules were exercised RED then GREEN, including all three fresh-review regressions and the final closure/payment independence regression.
- `pnpm typecheck`: **passed**.
- Sites `build-site.mjs`: **passed** after all three review fixes, exit 0, with Worker routes `/` and `/api/data`. The controller's connector preview driver was stopped for this final build.
- HTTP `GET http://127.0.0.1:5173/`: **200**. Dev server session 34374 was left running for controller browser verification.
- Canonical source QA: the offline normalized file was passed through the same sheet parser and analytics, outside the application runtime. All 12 collections parsed and reconciled to the controller's totals. No fixture is imported or loaded by the website.
- Client build scan: no native spreadsheet ID, source control totals, or `normalized.json` reference found in `dist/client`. The public source asset directory contains only the authored favicon.
- Built hosting declaration matches the source declaration and preserves the controller's existing Site ID.
- Vinext reports a nonfatal lucide barrel-import optimization warning; compilation and output still succeed.

## Business rules and rulings

- Historical effective invoices establish won/closed and the earliest valid invoice date. Missing final sale amounts remain unknown. Case numbers are display fields; internal IDs are authoritative.
- Unconfirmed case relationships are excluded from the certified opportunity rate. Additions retain their financial scope but do not add another original opportunity. Effective versions within one group cannot be counted twice.
- Recorded invoice net is retained even when tax confirmation is missing; no tax or net is inferred from gross. Tax uncertainty is displayed separately. Unknown collections are not marked unpaid.
- New sales require a linked document record and original decision date. A later effective quotation requires a separate `revisionSignedDate` no earlier than the latest quote and a distinct valid `revisionSignedSourceId`. Original decision date and original evidence remain unchanged. Without new evidence, original win history remains while current amount and closure stay unconfirmed. Actual document authenticity and same-day edits remain governed by the owner's evidence and Sheets records; this read-only dashboard does not inspect signatures inside PDFs or maintain a separate audit database.
- New closure requires confirmed invoice milestones, each linked to a distinct effective invoice matching its expected gross, plus a matching full expected total. Execution and payment are separate states.
- Verified receipts are counted once. Case-scoped collection uses valid allocations; unallocated bank entries do not become a selected case's collection. Invalid/overallocated relationships prevent a certified invoice balance.
- Pending quote amounts remain separate and use the selected quotation-date period, matching the quote table. No quotes in that period gives zero quoted amount; the separately labeled operational pending count remains current-state. Where one selected-period group has competing unselected versions or incomplete amounts, pending totals remain unknown instead of guessing a final version.
- Month/quarter/year views use Asia/Taipei dates and each metric's own date basis. Activity overlap is optional and never prorates revenue. Same-progress comparisons require explicit complete `coverage_start`/`coverage_end` settings and a nonzero known prior baseline.
- Case/follow-up views show the current operational state; their labels explicitly explain that the financial period does not hide current work. Invoice customer filters follow the invoice buyer, including mismatches with the case buyer. Unlinked valid invoices remain in overall finance and are queued for reconciliation.
- Quote correction line amounts/quantities may be negative. Receipt and allocation amounts must remain nonnegative.

## Live connector contract

Fixed connector: `connector_5f3c8c41a1e54ad7a76272c89e2554fa`.

Only these two server-selected actions are used:

1. `get_spreadsheet_metadata({ spreadsheet_id })` for the exact configured native workbook.
2. `get_spreadsheet_range({ spreadsheet_id, sheet_name, range, value_render_option: "UNFORMATTED_VALUE" })` for the 12 canonical sheet names.

Every refresh rereads metadata. Each sheet's ID/key column is scanned through its declared row count, then full rows are read through the last populated ID in pages of at most 250 rows. Blank intermediate pages are retained, so later appended records participate. Sheets over 10,000 grid rows fail explicitly instead of producing a partial total. New editable records must have their required internal ID/key populated.

At the current workbook size the expected refresh is 25 native reads: metadata once, 12 ID scans, 12 data ranges. Three sheet readers run concurrently. No credentials, financial snapshots, cross-visitor caches, localStorage, or write connector calls exist in the app. A failed refresh preserves only the current browser session's previous data and marks it stale.

## Controller handoff

The controller owns native source synchronization, independent review, private publication, live preview pumping and hosted-visitor verification. This agent has not created a replacement Site/workbook or published. The final integration correction is locally committed with controller authorization. Native initial read/Refresh, final desktop/mobile browser checks, hosted consent, and hosted private reads must be recorded separately by the controller; a successful build alone does not verify these.

Final publication should use the saved Worker output from the exact reviewed source. Do not bundle `.sites-runtime`, offline source files, or test-generated financial fixtures into public assets.

## Fresh review fixes after controller checkpoint `c0e1291`

1. **P1 duplicate internal invoice ID:** added collision validation for both internal IDs and invoice numbers before allocation/closure consumers. Distinct invoice numbers retain their actual turnover, but every ambiguous reference gets unknown paid/balance and cannot certify new closure. Regression reproduces two invoices totaling 2,100 and a single receipt of 1,050; neither can be certified fully paid. RED: balance incorrectly 0; GREEN: balances/paid unknown, both closures false, issue queued.
2. **P2 original/revision signing date:** copied the controller's two appended canonical columns, used separate revision evidence, and surfaced it in case details. Regression preserves the October original win after valid November revision signing; missing/old evidence remains blocked. RED: re-signed amount stayed null; GREEN: original October count/amount retained, November count zero, valid closure allowed.
3. **P2 pending-period consistency:** filtered pending financial quotes by their quote date before group/version checks. Regression has an October and November version; November is 700, December quoted amount is 0, operational pending count stays 1. RED: November incorrectly unknown; GREEN: expected period amounts match.

（實際資料筆數已移至本機 PRIVATE-NOTES.md）（實際資料筆數已移至本機 PRIVATE-NOTES.md）

Final verification commands after the fix pass:

```text
pnpm test
  tests 34; pass 34; fail 0; exit 0
pnpm typecheck
  tsc --noEmit; exit 0
node <Sites plugin>/scripts/build-site.mjs
  Build complete; dynamic / and API /api/data; exit 0
```

## Final integration correction — 2026-11-15

Separated `ambiguousInvoiceIdentity` from general `invalidInvoice` accounting errors. Missing/duplicate invoice identifiers still prevent new-case invoicing closure. Receipt-allocation errors continue to invalidate receivable balances and remain visible in reconciliation, but do not block an otherwise fully invoiced case from closing. This preserves the approved independence of invoicing closure and payment tracking.

Regression `fully invoiced new case closes independently of invalid receipt allocations`: signed new case, valid 1,050 invoice and matching confirmed milestone, receipt 500 incorrectly allocated as 600. RED reproduced `closed=false`; GREEN verifies `closed=true`, unknown balance and visible allocation issue. The duplicate-internal-ID closure regression still passes with closure blocked.

Final commands: `pnpm test` → 35 passed / 0 failed; `pnpm typecheck` → exit 0; Sites `build-site.mjs` → exit 0, Worker `/` and `/api/data` built. The existing nonfatal lucide import-optimization warning is unchanged. No provider writes or other functionality changes were made.
