#!/usr/bin/env python3
"""
Reads a PDF into text, page by page, using real optical character recognition.

Deliberately not a language model. A model asked to transcribe a policy
document produces plausible text, and for numbered clauses carrying figures
"plausible" means invented - in testing one merged two clauses and reported a
monthly cap as an annual carry-forward limit, and another wrote a clause that
does not exist. OCR can misread a character; it cannot make up a rule.

    python3 tools/ocr-pdf.py <file.pdf>

Pages are rendered with PyMuPDF and read with macOS Vision. On a server this
step is Azure Document Intelligence; the contract - bytes in, text out - is the
same, which is why it lives behind one function.
"""
import subprocess
import sys
import tempfile
from pathlib import Path

import fitz

OCR = Path(__file__).with_name("ocr")


def build_ocr() -> None:
    if OCR.exists():
        return
    source = Path(__file__).with_name("ocr.swift")
    subprocess.run(["swiftc", "-O", str(source), "-o", str(OCR)], check=True, capture_output=True)


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: ocr-pdf.py <file.pdf>", file=sys.stderr)
        return 2

    build_ocr()
    document = fitz.open(sys.argv[1])
    out: list[str] = []

    with tempfile.TemporaryDirectory() as workdir:
        for number, page in enumerate(document, start=1):
            image = Path(workdir) / f"p{number}.png"
            # 200 dpi: enough for 9pt body text, small enough to stay quick.
            page.get_pixmap(dpi=200).save(image)
            result = subprocess.run([str(OCR), str(image)], capture_output=True, text=True)
            text = result.stdout.strip()
            if text:
                out.append(f"--- page {number} ---\n{text}")

    print("\n\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
