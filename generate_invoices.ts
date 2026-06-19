/**
 * Generate one PDF per row in invoices.csv.
 *
 * Input:  invoices.csv with columns
 *         invoice_number, date, vendor, customer, items,
 *         subtotal, tax, discount, total
 * Output: invoices/INV-NNN.pdf
 *
 * Run:    npm start  (builds TS, then runs the compiled JS)
 */

import * as fs from 'fs';
import * as path from 'path';
import PDFDocument = require('pdfkit');

interface Row {
  invoice_number: string;
  date: string;
  vendor: string;
  customer: string;
  items: string;
  subtotal: string;
  tax: string;
  discount: string;
  total: string;
}

interface Item {
  name: string;
  qty: number | '';
  price: number | '';
}

// The compiled JS lives in dist/, so the project root (where invoices.csv and
// the output directory live) is one level up.
const HERE = path.resolve(__dirname, '..');
const CSV_PATH = path.join(HERE, 'invoices.csv');
const OUT_DIR = path.join(HERE, 'invoices');

// "Name x Qty @ Price" or "Name × Qty @ Price"
const ITEM_RE = /^(?<name>.+?)\s*[x×]\s*(?<qty>\d+)\s*@\s*(?<price>[\d.]+)$/;

// RFC-4180-ish CSV parser: handles quoted fields and commas inside quotes.
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function parseItems(raw: string): Item[] {
  return raw
    .split('|')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((piece): Item => {
      const m = piece.match(ITEM_RE);
      if (!m || !m.groups) return { name: piece, qty: '', price: '' };
      return {
        name: m.groups.name.trim(),
        qty: parseInt(m.groups.qty, 10),
        price: parseFloat(m.groups.price),
      };
    });
}

function fmtMoney(v: string | number | null | undefined): string {
  const s = String(v ?? '').trim();
  if (!s || s === '0' || s === '0.00') return '-';
  const n = parseFloat(s);
  if (Number.isNaN(n)) return s;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function buildPdf(row: Row, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: 54, bottom: 54, left: 54, right: 54 },
      info: { Title: `Invoice ${row.invoice_number}` },
    });

    const stream = fs.createWriteStream(outPath);
    stream.on('finish', resolve);
    stream.on('error', reject);
    doc.pipe(stream);

    // ---- Title ----
    doc.font('Helvetica-Bold').fontSize(22).text(`INVOICE ${row.invoice_number}`);
    doc.moveDown(0.3);

    // ---- Meta block: two columns of label/value pairs ----
    const metaY = doc.y;
    const colLabelW = 70;
    const colValueW = 220;
    const rowGap = 16;

    // Column 1: Date, Bill To
    doc.font('Helvetica-Bold').fontSize(10).text('Date:', 54, metaY, { width: colLabelW });
    doc.font('Helvetica').fontSize(10).text(row.date, 54 + colLabelW, metaY, { width: colValueW });

    // Column 2: Vendor
    doc.font('Helvetica-Bold').fontSize(10).text('Vendor:', 54 + colLabelW + colValueW + 30, metaY, { width: colLabelW });
    doc.font('Helvetica').fontSize(10).text(
      row.vendor,
      54 + colLabelW + colValueW + 30 + colLabelW,
      metaY,
      { width: 220 }
    );

    // Row 2: Bill To (spans both columns)
    doc.font('Helvetica-Bold').fontSize(10).text('Bill To:', 54, metaY + rowGap, { width: colLabelW });
    doc.font('Helvetica').fontSize(10).text(row.customer, 54 + colLabelW, metaY + rowGap, { width: 460 });

    doc.y = metaY + rowGap + 30;
    doc.moveDown(1);

    // ---- Items section ----
    doc.font('Helvetica-Bold').fontSize(12).text('Items');
    doc.moveDown(0.3);

    const items = parseItems(row.items);
    const tableX = 54;
    const tableW = 504; // page width 612 - 2*54 margin
    const colWidths = {
      num: 36,
      desc: 252,
      qty: 60,
      price: 78,
      total: 78,
    };

    const startY = doc.y;
    const headerH = 22;
    const rowH = 20;

    // Header background
    doc.save().rect(tableX, startY, tableW, headerH).fill('#2c3e50').restore();
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10);
    let cx = tableX + 6;
    doc.text('#', cx, startY + 6, { width: colWidths.num - 6, align: 'center' });
    cx += colWidths.num;
    doc.text('Description', cx, startY + 6, { width: colWidths.desc - 6 });
    cx += colWidths.desc;
    doc.text('Qty', cx, startY + 6, { width: colWidths.qty - 6, align: 'right' });
    cx += colWidths.qty;
    doc.text('Unit Price', cx, startY + 6, { width: colWidths.price - 6, align: 'right' });
    cx += colWidths.price;
    doc.text('Line Total', cx, startY + 6, { width: colWidths.total - 6, align: 'right' });

    // Body rows
    let y = startY + headerH;
    items.forEach((it, i) => {
      const isAlt = i % 2 === 1;
      if (isAlt) doc.save().rect(tableX, y, tableW, rowH).fill('#f4f6f8').restore();

      doc.fillColor('#000000').font('Helvetica').fontSize(10);
      cx = tableX + 6;
      doc.text(String(i + 1), cx, y + 5, { width: colWidths.num - 6, align: 'center' });
      cx += colWidths.num;
      doc.text(it.name, cx, y + 5, { width: colWidths.desc - 6 });
      cx += colWidths.desc;
      if (it.qty === '') {
        doc.text('', cx, y + 5, { width: colWidths.qty - 6, align: 'right' });
        cx += colWidths.qty;
        doc.text('', cx, y + 5, { width: colWidths.price - 6, align: 'right' });
        cx += colWidths.price;
        doc.text('', cx, y + 5, { width: colWidths.total - 6, align: 'right' });
      } else {
        const { qty, price } = it as { name: string; qty: number; price: number };
        const lineTotal = price * qty;
        doc.text(String(qty), cx, y + 5, { width: colWidths.qty - 6, align: 'right' });
        cx += colWidths.qty;
        doc.text(`$${price.toFixed(2)}`, cx, y + 5, { width: colWidths.price - 6, align: 'right' });
        cx += colWidths.price;
        doc.text(`$${lineTotal.toFixed(2)}`, cx, y + 5, { width: colWidths.total - 6, align: 'right' });
      }

      // Row separator
      doc.save().strokeColor('#cccccc').lineWidth(0.25)
        .moveTo(tableX, y + rowH).lineTo(tableX + tableW, y + rowH).stroke().restore();

      y += rowH;
    });

    doc.y = y + 14;

    // ---- Totals (right-aligned) ----
    const totalsX = tableX + tableW - 160;
    const totalsLabelW = 70;
    const totalsValueW = 90;

    function totalsRow(label: string, value: string, opts: { bold?: boolean; big?: boolean } = {}) {
      const yy = doc.y;
      doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(opts.big ? 13 : 11);
      doc.fillColor('#000000');
      doc.text(label, totalsX, yy, { width: totalsLabelW, align: 'right' });
      doc.text(value, totalsX + totalsLabelW, yy, { width: totalsValueW, align: 'right' });
      doc.y = yy + (opts.big ? 22 : 18);
    }

    totalsRow('Subtotal:', fmtMoney(row.subtotal));
    totalsRow('Tax:', fmtMoney(row.tax));
    totalsRow('Discount:', fmtMoney(row.discount));
    doc.save().strokeColor('#000000').lineWidth(0.75)
      .moveTo(totalsX, doc.y - 4).lineTo(totalsX + totalsLabelW + totalsValueW, doc.y - 4).stroke().restore();
    totalsRow('TOTAL:', fmtMoney(row.total), { bold: true, big: true });

    doc.end();
  });
}

async function main(): Promise<void> {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`ERROR: missing ${CSV_PATH}`);
    process.exit(1);
  }
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const text = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = parseCSV(text);
  const header = rows.shift();
  if (!header) {
    console.error('ERROR: empty CSV');
    process.exit(1);
  }
  const idx = (name: string): number => header.indexOf(name);

  let count = 0;
  for (const r of rows) {
    const inv = (r[idx('invoice_number')] || '').trim();
    if (!inv) continue;

    const row: Row = {
      invoice_number: inv,
      date: r[idx('date')],
      vendor: r[idx('vendor')],
      customer: r[idx('customer')],
      items: r[idx('items')],
      subtotal: r[idx('subtotal')],
      tax: r[idx('tax')],
      discount: r[idx('discount')],
      total: r[idx('total')],
    };

    const outPath = path.join(OUT_DIR, `${inv}.pdf`);
    await buildPdf(row, outPath);
    console.log(`  wrote ${path.relative(HERE, outPath)}`);
    count++;
  }
  console.log(`\nDone. ${count} PDF(s) written to ${path.relative(HERE, OUT_DIR)}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
