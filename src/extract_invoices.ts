/**
 * Extract invoice data back out of the generated PDFs into SQLite.
 *
 * This is the reverse of generate_invoices.ts: it reads every invoices/*.pdf,
 * recovers header fields, line items, and totals, and writes them into
 * invoices.db (two tables: invoices + invoice_items).
 *
 * Why pdfjs-dist and not pdftotext: pdfkit draws text at absolute positions,
 * so a flat text dump interleaves the header/table/totals by drawing order and
 * mixes column values across rows. pdfjs-dist exposes each fragment's x/y
 * (transform[4], transform[5]), which is the only way to reconstruct the table.
 *
 * COLUMN GEOMETRY MUST MATCH generate_invoices.ts:163-169. The items-table
 * x-buckets below are hard-coded to the pdfkit layout. If that layout changes,
 * this extractor silently breaks.
 *
 * Re-run behavior: an invoice already present in the DB is skipped. To
 * re-extract a regenerated PDF, delete its row (or invoices.db) first.
 *
 * Run: npm run extract
 */

import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';

// pdfjs-dist 4.x ships ESM only (.mjs). tsc emits CommonJS here, which would
// downlevel a literal import() to require() and fail on the ESM package. This
// Function wrapper preserves a true dynamic import at runtime.
const importDynamic = new Function('s', 'return import(s)') as (s: string) => Promise<any>;

// Compiled JS lives in dist/src/, so the project root is two levels up.
const HERE = path.resolve(__dirname, '..', '..');
const INVOICES_DIR = path.join(HERE, 'invoices');
const DB_PATH = path.join(HERE, 'invoices.db');

// Items-table x-buckets, derived from generate_invoices.ts:163-169
// (tableX=54; widths num=36, desc=252, qty=60, price=78, total=78).
// pdfjs and pdfkit share the same x axis, so these are used as-is.
const COL = {
  num: { lo: 54, hi: 90 },
  desc: { lo: 90, hi: 342 },
  qty: { lo: 342, hi: 402 },
  unit_price: { lo: 402, hi: 480 },
  total: { lo: 480, hi: 558 },
};

const META_LABELS = ['Date:', 'Vendor:', 'Bill To:'];
const TOTAL_LABELS = ['Subtotal:', 'Tax:', 'Discount:', 'TOTAL:'];

interface Frag {
  x: number;
  y: number;
  str: string;
}

interface Row {
  date: string;
  vendor: string;
  customer: string;
  subtotal: number;
  tax: number;
  discount: number;
  total: number;
  items: ItemRow[];
}

interface ItemRow {
  line_no: number | null;
  description: string;
  qty: number | null;
  unit_price: number | null;
  line_total: number | null;
}

// "$1,234.56" / "-" / "" -> number. The generator renders zero/empty as "-".
function parseMoney(s: string): number {
  const t = s.replace(/[$,\s]/g, '');
  if (!t || t === '-') return 0;
  const n = parseFloat(t);
  return Number.isNaN(n) ? 0 : n;
}

function bucketOf(x: number): keyof typeof COL | null {
  for (const key of Object.keys(COL) as (keyof typeof COL)[]) {
    if (x >= COL[key].lo && x < COL[key].hi) return key;
  }
  return null;
}

// Group fragments into visual rows by y (4pt tolerance), sorted top-to-bottom,
// each row's fragments sorted left-to-right.
function groupRows(frags: Frag[]): Frag[][] {
  const sorted = [...frags].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: Frag[][] = [];
  for (const f of sorted) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last[0].y - f.y) <= 4) {
      last.push(f);
    } else {
      rows.push([f]);
    }
  }
  for (const r of rows) r.sort((a, b) => a.x - b.x);
  return rows;
}

async function extractFrags(pdfPath: string): Promise<Frag[]> {
  const pdfjs = await importDynamic('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
  const frags: Frag[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    for (const it of tc.items as any[]) {
      const str = (it.str ?? '').trim();
      if (!str) continue;
      frags.push({ x: it.transform[4], y: it.transform[5], str });
    }
  }
  await doc.destroy();
  return frags;
}

function parseInvoice(frags: Frag[]): Row {
  const rows = groupRows(frags);

  // ---- Header meta block: Date / Vendor / Bill To ----
  // Date and Vendor share one visual row; walk left-to-right and assign each
  // run of non-label fragments to the most recent label.
  const meta: Record<string, string> = {};
  for (const row of rows) {
    let current: string | null = null;
    const parts: Record<string, string[]> = {};
    for (const f of row) {
      if (META_LABELS.includes(f.str)) {
        current = f.str;
        parts[current] = [];
      } else if (current) {
        parts[current].push(f.str);
      }
    }
    for (const [label, vals] of Object.entries(parts)) {
      if (vals.length) meta[label] = vals.join(' ');
    }
  }

  // ---- Items table ----
  // An item row has an integer in the num bucket. The header row ("#") and the
  // totals rows (all x > 400) are naturally excluded by that test.
  const items: ItemRow[] = [];
  for (const row of rows) {
    const cells: Partial<Record<keyof typeof COL, string[]>> = {};
    for (const f of row) {
      const b = bucketOf(f.x);
      if (!b) continue;
      (cells[b] ??= []).push(f.str);
    }
    const numText = cells.num?.join('') ?? '';
    if (!/^\d+$/.test(numText)) continue; // not an item body row
    items.push({
      line_no: parseInt(numText, 10),
      description: (cells.desc ?? []).join(' '),
      qty: cells.qty ? parseInt(cells.qty.join('').replace(/,/g, ''), 10) : null,
      unit_price: cells.unit_price ? parseMoney(cells.unit_price.join('')) : null,
      line_total: cells.total ? parseMoney(cells.total.join('')) : null,
    });
  }

  // ---- Totals block: look up each label by name on its row ----
  const totals: Record<string, number> = {};
  for (const row of rows) {
    const label = row.find((f) => TOTAL_LABELS.includes(f.str));
    if (!label) continue;
    const value = row.filter((f) => f !== label).map((f) => f.str).join(' ');
    totals[label.str] = parseMoney(value);
  }

  return {
    date: meta['Date:'] ?? '',
    vendor: meta['Vendor:'] ?? '',
    customer: meta['Bill To:'] ?? '',
    subtotal: totals['Subtotal:'] ?? 0,
    tax: totals['Tax:'] ?? 0,
    discount: totals['Discount:'] ?? 0,
    total: totals['TOTAL:'] ?? 0,
    items,
  };
}

function initDb(db: InstanceType<typeof DatabaseSync>): void {
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS invoices (
      invoice_number  TEXT PRIMARY KEY,
      date            TEXT,
      vendor          TEXT,
      customer        TEXT,
      subtotal        REAL,
      tax             REAL,
      discount        REAL,
      total           REAL,
      source_pdf      TEXT
    );
    CREATE TABLE IF NOT EXISTS invoice_items (
      id              INTEGER PRIMARY KEY,
      invoice_number  TEXT NOT NULL REFERENCES invoices(invoice_number),
      line_no         INTEGER,
      description     TEXT,
      qty             INTEGER,
      unit_price      REAL,
      line_total      REAL
    );
  `);
}

async function main(): Promise<void> {
  if (!fs.existsSync(INVOICES_DIR)) {
    console.error(`ERROR: missing ${INVOICES_DIR}`);
    process.exit(1);
  }

  const db = new DatabaseSync(DB_PATH);
  initDb(db);

  const exists = db.prepare('SELECT 1 FROM invoices WHERE invoice_number = ?');
  const insInvoice = db.prepare(
    `INSERT INTO invoices
       (invoice_number, date, vendor, customer, subtotal, tax, discount, total, source_pdf)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insItem = db.prepare(
    `INSERT INTO invoice_items
       (invoice_number, line_no, description, qty, unit_price, line_total)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  const pdfs = fs
    .readdirSync(INVOICES_DIR)
    .filter((f) => f.toLowerCase().endsWith('.pdf'))
    .sort();

  let wrote = 0;
  let skipped = 0;
  let errors = 0;

  for (const file of pdfs) {
    const invoiceNumber = file.replace(/\.pdf$/i, '');
    if (exists.get(invoiceNumber)) {
      console.log(`  skipped ${invoiceNumber}`);
      skipped++;
      continue;
    }
    try {
      const frags = await extractFrags(path.join(INVOICES_DIR, file));
      const row = parseInvoice(frags);
      const relPdf = path.join('invoices', file);

      db.exec('BEGIN');
      try {
        insInvoice.run(
          invoiceNumber,
          row.date,
          row.vendor,
          row.customer,
          row.subtotal,
          row.tax,
          row.discount,
          row.total,
          relPdf
        );
        for (const it of row.items) {
          insItem.run(
            invoiceNumber,
            it.line_no,
            it.description,
            it.qty,
            it.unit_price,
            it.line_total
          );
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }

      console.log(`  wrote ${invoiceNumber} (${row.items.length} items)`);
      wrote++;
    } catch (e) {
      console.error(`  ERROR ${invoiceNumber}: ${(e as Error).message}`);
      errors++;
    }
  }

  db.close();
  console.log(
    `\nDone. ${wrote} new, ${skipped} skipped, ${errors} errors. DB at ${path.relative(HERE, DB_PATH)}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
