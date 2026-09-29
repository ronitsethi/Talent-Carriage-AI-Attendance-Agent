import { createWorker } from 'tesseract.js';

/**
 * Reads a PDF into text, page by page, with optical character recognition.
 *
 * Deliberately not a language model. A model asked to transcribe a policy
 * document produces plausible text, and for numbered clauses carrying figures
 * "plausible" means invented: in testing one merged two clauses and reported a
 * monthly cap as the annual carry-forward limit, and a stronger one wrote an
 * encashment clause that appears nowhere in the document. Employees are told
 * these figures as company rule. OCR can misread a character; it cannot make up
 * a rule.
 *
 * Both halves are WebAssembly - MuPDF renders, Tesseract reads - so this runs
 * wherever Node does, with nothing to install on the machine and no difference
 * between a developer's laptop and a Windows server.
 */

/** Enough for 9pt body text in a scanned guideline, small enough to stay quick. */
const DPI = 200;

export type PdfText = { text: string; pages: number };

export async function readPdf(buffer: Buffer): Promise<PdfText> {
  // Loaded when it is needed, not when the module is: mupdf awaits at the top
  // level to bring up its WebAssembly, which a CommonJS require cannot do.
  const mupdf = await import('mupdf');

  const document = mupdf.Document.openDocument(buffer, 'application/pdf');
  const pages = document.countPages();
  if (!pages) throw new Error('The file has no pages');

  const worker = await createWorker('eng');
  try {
    const parts: string[] = [];
    for (let index = 0; index < pages; index++) {
      const page = document.loadPage(index);
      const pixmap = page.toPixmap(
        mupdf.Matrix.scale(DPI / 72, DPI / 72),
        mupdf.ColorSpace.DeviceRGB,
        false,
        true,
      );
      const { data } = await worker.recognize(Buffer.from(pixmap.asPNG()));
      const text = data.text.trim();
      if (text) parts.push(`--- page ${index + 1} ---\n${text}`);
    }
    return { text: parts.join('\n\n'), pages };
  } finally {
    await worker.terminate();
  }
}
