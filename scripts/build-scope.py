#!/usr/bin/env python3
"""Render docs/scope.html to the client-facing PDF.

Two passes, because the contents page needs real page numbers:
  1. render → find the page each section starts on
  2. write those numbers into the <span class="pg"> slots → render again
Then stamp a footer (page x of y) on every page except the cover.

Usage:  python3 scripts/build-scope.py
Needs:  Google Chrome, PyMuPDF (pip install --user pymupdf)
"""
import pathlib
import re
import subprocess
import sys
import tempfile

import fitz

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "docs" / "scope.html"
OUT = ROOT / "AI_Attendance_Agent_Scope_v1.0.pdf"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
FOOTER = "AI Attendance Agent  ·  Product Scope v1.0  ·  Talent Carriage"


def render(target: pathlib.Path) -> None:
    subprocess.run(
        ["perl", "-e", "alarm 120; exec @ARGV", CHROME, "--headless=new", "--disable-gpu",
         "--no-pdf-header-footer", f"--print-to-pdf={target}", "--virtual-time-budget=8000",
         SRC.as_uri()],
        check=True, capture_output=True,
    )


def toc_entries(html: str):
    """(row, needle) for every contents row, where needle matches its heading in the PDF."""
    rows = re.findall(r'<div class="toc-row"[^>]*>.*?</div>', html, re.S)
    out = []
    for row in rows:
        if 'class="pg"' not in row:
            continue
        ref = re.search(r'<span class="i">(.*?)</span>', row, re.S)
        title = re.search(r'<span class="t">(.*?)</span>', row, re.S)
        if not (ref and title):
            continue
        ref = ref.group(1).strip()
        title = re.sub(r"\s+", " ", title.group(1)).strip()
        # numbered sections are rendered as "4. Title"; appendix titles already carry their label
        out.append((row, f"{ref}. {title}" if ref.isdigit() else title))
    return out


# Headings sit at the page's left margin; contents rows are indented, so x tells them apart.
HEADING_MARGIN_X = 45


def heading_page(doc, needle: str):
    """First page where this text appears as a heading rather than a contents row."""
    for i in range(doc.page_count):
        if any(hit.x0 <= HEADING_MARGIN_X for hit in doc[i].search_for(needle)):
            return i + 1
    return None


def main() -> int:
    html = SRC.read_text()
    with tempfile.TemporaryDirectory() as tmp:
        pass1 = pathlib.Path(tmp) / "pass1.pdf"
        render(pass1)
        doc = fitz.open(pass1)

        missing = []
        for row, needle in toc_entries(html):
            page = heading_page(doc, needle)
            if page is None:
                missing.append(needle)
                continue
            html = html.replace(row, row.replace('<span class="pg"></span>',
                                                 f'<span class="pg">{page}</span>'), 1)
        doc.close()
        if missing:
            print(f"! could not locate in the PDF: {missing}", file=sys.stderr)

        SRC.write_text(html)
        pass2 = pathlib.Path(tmp) / "pass2.pdf"
        render(pass2)

        doc = fitz.open(pass2)
        total = doc.page_count
        grey, rule = (0.42, 0.51, 0.56), (0.80, 0.86, 0.89)
        for i, page in enumerate(doc):
            if i == 0:
                continue
            w, h = page.rect.width, page.rect.height
            y = h - 26
            page.draw_line(fitz.Point(43, y - 9), fitz.Point(w - 43, y - 9), color=rule, width=0.6)
            page.insert_text(fitz.Point(43, y + 1), FOOTER, fontname="helv", fontsize=7.4, color=grey)
            page.insert_text(fitz.Point(w - 85, y + 1), f"Page {i + 1} of {total}",
                             fontname="helv", fontsize=7.4, color=grey)
        doc.set_metadata({
            "title": "AI Attendance Agent — Product Scope v1.0",
            "author": "Talent Carriage Management Pvt Ltd",
            "subject": "Functional and technical scope for the AI Attendance Agent platform",
            "creator": "Talent Carriage",
        })
        doc.save(OUT, garbage=4, deflate=True)
        print(f"{OUT.name}: {total} pages")

        # numbers are only wrong if pass 2 reflowed; report it rather than hide it
        for row, needle in toc_entries(SRC.read_text()):
            claimed = re.search(r'<span class="pg">(\d+)</span>', row)
            actual = heading_page(doc, needle)
            if claimed and actual and int(claimed.group(1)) != actual:
                print(f"! contents says {claimed.group(1)}, actual {actual}: {needle}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
