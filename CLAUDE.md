# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

It contains two things: (1) project-specific facts about `pdf-pipeline/`, and (2) general behavioral guidelines that govern how changes should be made here. Keep both when updating.

---

## Project Overview

`pdf-pipeline/` converts `invoices.csv` into one PDF per invoice row. Two parallel implementations exist:

- **Python** — `generate_invoices.py` (reportlab)
- **Node.js / TypeScript** — `generate_invoices.ts` (pdfkit), compiled to `dist/generate_invoices.js` via `tsc`

Both produce visually equivalent PDFs into `invoices/<invoice_number>.pdf`. The two implementations are kept in sync — when changing layout, parser rules, or output, update both files.

A reverse direction also exists (TypeScript only, no Python counterpart):

- **`src/extract_invoices.ts`** — reads every `invoices/*.pdf` and writes the recovered data into `invoices.db` (SQLite, two tables: `invoices` + `invoice_items`).
- **`src/top_vendors.ts`** — queries `invoices.db` for the top 5 vendors by total spend.

`pdftotext` is unusable here: pdfkit draws at absolute positions, so a flat dump interleaves blocks and mixes columns across rows. The extractor uses **`pdfjs-dist`** (per-fragment x/y from `transform[4]/[5]`) to reconstruct the table, and the **built-in `node:sqlite`** module (Node 22+) so no native SQLite dependency is needed. `invoices.db` is generated output (gitignored, like `invoices/`); re-running skips invoices already in the DB.

⚠️ **The extractor's items-table x-buckets are hard-coded to match `generate_invoices.ts:163-169`.** If you change the generator's column layout, `src/extract_invoices.ts` silently breaks — update both.

**Why two implementations exist:** the project has no documented history, so the dual-language approach is treated as an intentional cross-check (same input → same output via two independent code paths), not redundancy to be consolidated. Confirm with the user before deleting either file.

**Why this file exists:** there is no README, no design doc, and no test suite. The only way a new contributor (or a future Claude instance) can recover the project's intent and constraints is from this file and the source. When making non-trivial changes, extend the relevant section below — don't leave decisions implicit.

## Commands

Run from `pdf-pipeline/`.

**Python:**
```bash
pip install reportlab
python generate_invoices.py
```

**Node.js:**
```bash
npm install
npm start          # CSV -> PDFs
npm run extract    # invoices/*.pdf -> invoices.db
npm run top-vendors# query: top 5 vendors by spend
```

No test suite, linter, or build step exists today. Verification of the existing scripts = run one, open a generated PDF, eyeball the layout. The PDFs in `invoices/` are not committed reference output — regenerate them as part of verifying any change. New code should add tests and (for JS work) a TypeScript build setup — see "Defaults for Future Changes" below.

## Architecture

Each script is a single-file CLI with the same shape:

1. **CSV reader** — Python uses `csv.DictReader`; the TypeScript impl uses a hand-rolled RFC-4180-ish `parseCSV` (handles quoted fields, embedded commas, `""` escapes).
2. **`parseItems`** — splits the `items` column on `|` into rows, then regex-matches each piece as `Name x Qty @ Price` (also accepts `×`). Non-matching pieces fall back to raw text with empty qty/price, so a malformed line never aborts the run.
3. **`fmtMoney` / `fmt_money`** — formats numeric strings as `$1,234.56`; empty/`0`/`0.00` renders as `-`.
4. **PDF builder** — title block, 2-column meta block (Date/Vendor/Bill To), items table with header + zebra striping (`#2c3e50` header, `#f4f6f8` alt rows), right-aligned totals with a rule above `TOTAL`.
5. **`main`** — iterates rows, skips blank `invoice_number`, writes `<invoice_number>.pdf`, prints progress.

The visual output is the contract, not either implementation in isolation. If you change layout in one script, the other must change to match, and a diff in `invoices/` should be the verification artifact.

## CSV Schema

`invoices.csv` columns: `invoice_number, date, vendor, customer, items, subtotal, tax, discount, total`

The `items` cell uses `|` between line items and the regex pattern `Name x Qty @ Price` per item — accepts `x` or `×`, single-space delimiters, `@` separator. Whitespace-tolerant on either side of delimiters.

## Environment Notes

- Windows host; PowerShell is the primary shell. `pip` and `python` may need explicit paths — see `.claude/settings.local.json` for the patterns already allowlisted in this session.
- `node_modules/` contains ~80MB of pdfkit/fontkit deps after `npm install`.

---

## Working Style (apply to this project)

These are general behavioral guidelines, included here so a future Claude instance sees them alongside the project facts. They bias toward caution over speed; for trivial tasks use judgment.

**Think before coding.** State assumptions. If multiple interpretations exist, present them rather than picking silently. If a simpler approach exists, say so and push back. If something is unclear, stop and ask rather than guess.

**Simplicity first.** Minimum code that solves the problem; nothing speculative. No features beyond what was asked, no abstractions for single-use code, no flexibility or configurability that wasn't requested, no error handling for impossible scenarios. If 200 lines could be 50, rewrite.

**Surgical changes.** Touch only what the request demands. Don't "improve" adjacent code, comments, or formatting. Don't refactor things that aren't broken. Match existing style, even if you'd do it differently. If you notice unrelated dead code, mention it — don't delete it. Remove only the imports/variables/functions your own changes made unused. Every changed line should trace directly to the user's request.

**Goal-driven execution.** Define success criteria before coding. "Add validation" → "write tests for invalid inputs, then make them pass." "Fix the bug" → "write a test that reproduces it, then make it pass." "Refactor X" → "ensure tests pass before and after." For multi-step work, state a brief plan with a verify step for each item, then loop until verified.

**Default to clarifying questions.** The project has no documentation of its decisions; guessing wrong here costs more than asking. If a change is non-trivial, the user is the source of truth for intent — ask before implementing.

**Working software beats complete software.** The current state is "works, but undocumented." Improving that means leaving the codebase in a state where the next person can answer "what is this" and "why is it this way" without running it. Update this file when you make decisions that aren't obvious from the code.

## Defaults for Future Changes

These are the project's standing preferences. Apply them to any new feature or non-trivial edit; the existing scripts follow them only because they predate this section.

**Prefer TypeScript for new JS work.** New JS files should be written as TypeScript (`.ts`) with a proper `tsconfig.json` and a build step. The Node implementation now lives in `generate_invoices.ts` (compiled to `dist/` by `tsc`); the original `generate_invoices.js` was its predecessor and has been removed. Keep new Node work in TypeScript.

**New features must ship with tests.** When adding a new function or behavior, add a real test (no mocks) that exercises it through its public interface. For this project that means spawning the actual script/parser and asserting on its real output — not stubbing `pdfkit` or `fs`. If a function is too tightly coupled to I/O to test directly, that's a signal to extract the pure logic first (see "Simplicity First" above — but here it's "extractability," not "abstraction for its own sake").
