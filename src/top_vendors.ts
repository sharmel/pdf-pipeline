/**
 * Print the top 5 vendors by total spend from invoices.db.
 *
 * Reads the DB written by extract_invoices.ts. Run `npm run extract` first.
 *
 * Run: npm run top-vendors
 */

import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.resolve(__dirname, '..', '..');
const DB_PATH = path.join(HERE, 'invoices.db');

// Same money formatting the generator uses: "$1,234.56".
function fmtMoney(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function main(): void {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`ERROR: ${path.relative(HERE, DB_PATH)} not found. Run "npm run extract" first.`);
    process.exit(1);
  }

  const db = new DatabaseSync(DB_PATH);
  const rows = db
    .prepare(
      `SELECT vendor, ROUND(SUM(total), 2) AS spend, COUNT(*) AS invoices
       FROM invoices
       GROUP BY vendor
       ORDER BY spend DESC
       LIMIT 5`
    )
    .all() as { vendor: string; spend: number; invoices: number }[];
  db.close();

  if (!rows.length) {
    console.log('No invoices in the database.');
    return;
  }

  const vendorW = Math.max(6, ...rows.map((r) => r.vendor.length));
  const spendStrs = rows.map((r) => fmtMoney(r.spend));
  const spendW = Math.max(5, ...spendStrs.map((s) => s.length));

  const header = `${'Vendor'.padEnd(vendorW)}  ${'Spend'.padStart(spendW)}  Invoices`;
  console.log(header);
  console.log('-'.repeat(header.length));
  rows.forEach((r, i) => {
    console.log(
      `${r.vendor.padEnd(vendorW)}  ${spendStrs[i].padStart(spendW)}  ${String(r.invoices).padStart(8)}`
    );
  });
}

main();
