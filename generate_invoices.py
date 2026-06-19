"""
Generate one PDF per row in invoices.csv.

Input:  invoices.csv with columns
        invoice_number, date, vendor, customer, items,
        subtotal, tax, discount, total
Output: invoices/INV-NNN.pdf  (one per row)
"""

import csv
import re
import sys
from decimal import Decimal
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    SimpleDocTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

HERE = Path(__file__).resolve().parent
CSV_PATH = HERE / "invoices.csv"
OUT_DIR = HERE / "invoices"

# "Name x Qty @ Price" or "Name × Qty @ Price"
ITEM_RE = re.compile(r"^(?P<name>.+?)\s*[x×]\s*(?P<qty>\d+)\s*@\s*(?P<price>[\d.]+)$")


def parse_items(raw: str):
    """Split the items string into [(name, qty, price), ...] tuples."""
    rows = []
    for piece in raw.split("|"):
        piece = piece.strip()
        if not piece:
            continue
        m = ITEM_RE.match(piece)
        if not m:
            # Fall back: keep the raw text, no numeric breakdown
            rows.append((piece, "", ""))
            continue
        name = m.group("name").strip()
        qty = int(m.group("qty"))
        price = Decimal(m.group("price"))
        rows.append((name, qty, price))
    return rows


def fmt_money(value: str) -> str:
    """Format a numeric string as $1,234.56 (or '-' for empty/zero)."""
    s = (value or "").strip()
    if not s or s == "0" or s == "0.00":
        return "-"
    try:
        d = Decimal(s)
    except Exception:
        return s
    return f"${d:,.2f}"


def build_pdf(row: dict, out_path: Path) -> None:
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "Title", parent=styles["Title"], fontSize=22, spaceAfter=6
    )
    meta_style = ParagraphStyle(
        "Meta", parent=styles["Normal"], fontSize=10, leading=14
    )
    section_style = ParagraphStyle(
        "Section", parent=styles["Heading2"], fontSize=12, spaceBefore=10, spaceAfter=4
    )

    doc = SimpleDocTemplate(
        str(out_path),
        pagesize=LETTER,
        leftMargin=0.75 * inch,
        rightMargin=0.75 * inch,
        topMargin=0.75 * inch,
        bottomMargin=0.75 * inch,
        title=f"Invoice {row['invoice_number']}",
    )

    story = []

    # Title block
    story.append(Paragraph(f"INVOICE {row['invoice_number']}", title_style))
    story.append(Spacer(1, 6))

    meta_data = [
        ["Date:", row["date"], "Vendor:", row["vendor"]],
        ["Bill To:", row["customer"], "", ""],
    ]
    meta_table = Table(meta_data, colWidths=[0.9 * inch, 2.4 * inch, 0.9 * inch, 2.8 * inch])
    meta_table.setStyle(
        TableStyle(
            [
                ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
                ("FONTSIZE", (0, 0), (-1, -1), 10),
                ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
                ("FONTNAME", (2, 0), (2, -1), "Helvetica-Bold"),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
            ]
        )
    )
    story.append(meta_table)
    story.append(Spacer(1, 12))

    # Items section
    story.append(Paragraph("Items", section_style))

    items = parse_items(row["items"])
    table_data = [["#", "Description", "Qty", "Unit Price", "Line Total"]]
    for i, (name, qty, price) in enumerate(items, start=1):
        if qty == "":
            table_data.append([str(i), name, "", "", ""])
        else:
            line_total = price * qty
            table_data.append([str(i), name, str(qty), f"${price:,.2f}", f"${line_total:,.2f}"])

    items_table = Table(
        table_data,
        colWidths=[0.4 * inch, 3.4 * inch, 0.7 * inch, 1.1 * inch, 1.4 * inch],
    )
    items_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#2c3e50")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, 0), 10),
                ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
                ("FONTSIZE", (0, 1), (-1, -1), 10),
                ("ALIGN", (0, 0), (0, -1), "CENTER"),
                ("ALIGN", (2, 1), (-1, -1), "RIGHT"),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f4f6f8")]),
                ("LINEBELOW", (0, 0), (-1, 0), 0.75, colors.HexColor("#2c3e50")),
                ("LINEBELOW", (0, 1), (-1, -1), 0.25, colors.HexColor("#cccccc")),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    story.append(items_table)
    story.append(Spacer(1, 14))

    # Totals
    totals_data = [
        ["Subtotal:", fmt_money(row["subtotal"])],
        ["Tax:", fmt_money(row["tax"])],
        ["Discount:", fmt_money(row["discount"])],
        ["TOTAL:", fmt_money(row["total"])],
    ]
    totals_table = Table(totals_data, colWidths=[1.4 * inch, 1.4 * inch], hAlign="RIGHT")
    totals_table.setStyle(
        TableStyle(
            [
                ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
                ("FONTSIZE", (0, 0), (-1, -1), 11),
                ("ALIGN", (0, 0), (-1, -1), "RIGHT"),
                ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
                ("FONTSIZE", (0, -1), (-1, -1), 13),
                ("LINEABOVE", (0, -1), (-1, -1), 0.75, colors.black),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ]
        )
    )
    story.append(totals_table)

    doc.build(story)


def main() -> int:
    if not CSV_PATH.exists():
        print(f"ERROR: missing {CSV_PATH}", file=sys.stderr)
        return 1

    OUT_DIR.mkdir(exist_ok=True)

    count = 0
    with CSV_PATH.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            inv = row["invoice_number"].strip()
            if not inv:
                continue
            out_path = OUT_DIR / f"{inv}.pdf"
            build_pdf(row, out_path)
            count += 1
            print(f"  wrote {out_path.relative_to(HERE)}")

    print(f"\nDone. {count} PDF(s) written to {OUT_DIR.relative_to(HERE)}/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
