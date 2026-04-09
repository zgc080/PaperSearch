#!/usr/bin/env python3
"""Generate a PDF from literature search results (JSON stdin -> PDF file)."""
import sys, json
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm, cm
from reportlab.platypus import (
    SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, PageBreak
)
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
import os, subprocess, tempfile

# --- CJK font setup ---
FONT_DIR = "/tmp/fonts"
NOTO_URL = "https://github.com/google/fonts/raw/main/ofl/notosanstc/NotoSansTC%5Bwght%5D.ttf"
NOTO_PATH = os.path.join(FONT_DIR, "NotoSansTC.ttf")

def ensure_cjk_font():
    """Download Noto Sans TC for CJK support if not cached."""
    if os.path.exists(NOTO_PATH):
        return True
    os.makedirs(FONT_DIR, exist_ok=True)
    try:
        subprocess.run(["curl", "-sL", "-o", NOTO_PATH, NOTO_URL],
                       check=True, timeout=30)
        return True
    except Exception:
        return False

def register_fonts():
    body_name = "Helvetica"
    bold_name = "Helvetica-Bold"
    if ensure_cjk_font():
        try:
            pdfmetrics.registerFont(TTFont("NotoSansTC", NOTO_PATH))
            body_name = "NotoSansTC"
            bold_name = "NotoSansTC"
        except Exception:
            pass
    return body_name, bold_name

def build_pdf(data, output_path):
    query = data.get("query", "Literature")
    results = data.get("results", [])
    body_font, bold_font = register_fonts()

    doc = SimpleDocTemplate(
        output_path,
        pagesize=landscape(A4),
        title=f"Literature Search: {query}",
        author="Perplexity Computer",
        leftMargin=1.2*cm, rightMargin=1.2*cm,
        topMargin=1.5*cm, bottomMargin=1.5*cm,
    )

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("Title2", parent=styles["Title"],
        fontName=bold_font, fontSize=14, spaceAfter=4*mm, alignment=TA_LEFT,
        textColor=colors.HexColor("#1a5276"))
    sub_style = ParagraphStyle("Sub", parent=styles["Normal"],
        fontName=body_font, fontSize=8, textColor=colors.HexColor("#666666"),
        spaceAfter=6*mm)
    cell_style = ParagraphStyle("Cell", fontName=body_font, fontSize=7,
        leading=9, alignment=TA_LEFT, wordWrap='CJK')
    cell_bold = ParagraphStyle("CellBold", parent=cell_style,
        fontName=bold_font, fontSize=7.5)
    link_style = ParagraphStyle("Link", parent=cell_style,
        textColor=colors.HexColor("#1a73e8"), fontSize=6.5)
    header_style = ParagraphStyle("Header", fontName=bold_font, fontSize=7.5,
        textColor=colors.white, alignment=TA_CENTER)

    story = []
    story.append(Paragraph(f"文獻搜尋結果：{query}", title_style))
    story.append(Paragraph(
        f"共 {len(results)} 篇 · IF ≥ {data.get('minIF', 4)} · "
        f"資料來源：OpenAlex", sub_style))

    # Build table
    col_widths = [8*mm, 85*mm, 55*mm, 35*mm, 12*mm, 15*mm, 55*mm]
    headers = ["#", "標題", "作者", "期刊", "IF", "日期", "連結"]
    header_row = [Paragraph(h, header_style) for h in headers]
    table_data = [header_row]

    for i, r in enumerate(results, 1):
        abstract_snip = (r.get("abstract", "") or "")[:120]
        if abstract_snip:
            abstract_snip = f"<br/><font size='6' color='#888888'>{abstract_snip}...</font>"
        title_p = Paragraph(
            f"<b>{r.get('title','')}</b>{abstract_snip}", cell_style)
        author_p = Paragraph(r.get("author", "")[:100], cell_style)
        journal_p = Paragraph(r.get("journal", ""), cell_style)
        if_val = str(r.get("impactFactor", ""))
        date_val = (r.get("publicationDate", "") or "")[:10]
        pub_url = r.get("pubUrl", "")
        link_p = Paragraph(
            f'<a href="{pub_url}" color="blue">Link</a>' if pub_url else "",
            link_style)
        table_data.append([
            Paragraph(str(i), cell_style), title_p, author_p,
            journal_p, Paragraph(if_val, cell_style),
            Paragraph(date_val, cell_style), link_p
        ])

    tbl = Table(table_data, colWidths=col_widths, repeatRows=1)
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1a5276")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTSIZE", (0, 0), (-1, -1), 7),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#cccccc")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1),
         [colors.white, colors.HexColor("#f8f9fa")]),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("LEFTPADDING", (0, 0), (-1, -1), 3),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3),
    ]))
    story.append(tbl)
    doc.build(story)

if __name__ == "__main__":
    data = json.load(sys.stdin)
    output = data.get("outputPath", "/tmp/export.pdf")
    build_pdf(data, output)
    print(json.dumps({"ok": True, "path": output}))
