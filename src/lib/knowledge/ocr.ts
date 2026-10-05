import path from 'node:path';
import { tmpdir } from 'node:os';
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

/**
 * Where the English language data lives, shipped with the application.
 *
 * Left to itself tesseract.js downloads this from a CDN the first time it reads
 * anything. On a laptop that is a two-second pause nobody notices. On a server
 * it is an outbound call that can simply hang - which it did: a document sat at
 * "reading" for a quarter of an hour on three per cent CPU, waiting for a file
 * that never arrived, while the same document took six seconds locally.
 *
 * A 5 MB file in the bundle buys a reader that works the same on a laptop, on
 * App Service and on the Windows machine this has to run on, with nothing to
 * fetch and nothing to configure.
 */
const LANG_PATH = path.join(process.cwd(), 'tessdata');

export type PdfText = { text: string; pages: number };

/**
 * Nothing here may hang.
 *
 * Every stage is a WebAssembly module or a file read, and when one of them
 * stalls there is no error, no CPU and no end to it - the document simply says
 * "reading" for ever and the person is left to guess. A stage that runs out of
 * time says which stage it was, which is the difference between a bug report
 * and a shrug.
 */
async function within<T>(stage: string | (() => string), ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Read lazily: the useful part of the label is how far it had got, which
      // is only known once it has stopped getting any further.
      const where = typeof stage === 'function' ? stage() : stage;
      reject(new Error(`Timed out after ${Math.round(ms / 1000)}s while ${where}`));
    }, ms);
  });
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer!);
  }
}

export async function readPdf(buffer: Buffer): Promise<PdfText> {
  // Loaded when it is needed, not when the module is: mupdf awaits at the top
  // level to bring up its WebAssembly, which a CommonJS require cannot do.
  const mupdf = await import('mupdf');

  const document = mupdf.Document.openDocument(buffer, 'application/pdf');
  const pages = document.countPages();
  if (!pages) throw new Error('The file has no pages');

  // Tesseract starts in three steps - spawn the thread, compile the core, read
  // the language - and any of them can be the one that stalls. Keeping the last
  // thing it reported means a failure can say which, instead of leaving the next
  // person to work it out from a CPU graph.
  let step = 'spawning the worker thread';
  const worker = await within(
    () => `starting the text recogniser (got as far as: ${step})`,
    90_000,
    createWorker('eng', undefined, {
      langPath: LANG_PATH,
      // The file is shipped uncompressed, so do not look for eng.traineddata.gz.
      gzip: false,
      cachePath: tmpdir(),
      logger: (m: { status?: string; progress?: number }) => {
        if (m?.status) step = `${m.status} ${Math.round((m.progress ?? 0) * 100)}%`;
      },
    }),
  );
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
      const { data } = await within(
        `reading page ${index + 1} of ${pages}`,
        120_000,
        worker.recognize(Buffer.from(pixmap.asPNG())),
      );
      const text = data.text.trim();
      if (text) parts.push(`--- page ${index + 1} ---\n${text}`);
    }
    return { text: parts.join('\n\n'), pages };
  } finally {
    await worker.terminate();
  }
}
