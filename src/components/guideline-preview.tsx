'use client';

import { useId, useRef, useState } from 'react';
import { ExternalLink, X } from 'lucide-react';

/**
 * A guideline's name that opens it. The PDF is shown as uploaded, in the
 * browser's own viewer; a document added before files were kept shows the
 * text the agent reads from it instead. Nothing loads until it is opened.
 */
export function GuidelinePreview({ id, title, filename, hasFile }: { id: string; title: string; filename: string; hasFile: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const url = `/api/guidelines/${id}`;

  function show() {
    setOpen(true);
    dialog.current?.showModal();
    if (!hasFile && text === null) {
      fetch(`${url}?text`)
        .then((response) => (response.ok ? response.text() : Promise.reject(new Error(String(response.status)))))
        .then(setText, () => setFailed(true));
    }
  }

  return (
    <>
      <button type="button" className="doc-open" onClick={show} aria-label={`Preview ${title}`}>
        {title}
      </button>

      <dialog className="modal doc-preview" ref={dialog} aria-labelledby={headingId} onClose={() => setOpen(false)}>
        <div className="doc-preview-head">
          <div className="doc-preview-name">
            <h2 id={headingId}>{title}</h2>
            <div className="hint">{filename}</div>
          </div>
          {hasFile ? (
            <a className="btn small quiet" href={url} target="_blank" rel="noopener">
              <ExternalLink size={14} aria-hidden /> Open in new tab
            </a>
          ) : null}
          <button type="button" className="btn small quiet" onClick={() => dialog.current?.close()} aria-label="Close preview">
            <X size={16} aria-hidden />
          </button>
        </div>

        {open ? (
          hasFile ? (
            <iframe className="doc-preview-frame" src={url} title={title} />
          ) : (
            <div className="doc-preview-text">
              <p className="notice info inline">
                The original file was not kept for documents added before previews existed. This is the text the agent
                reads from it; upload the PDF again to see it as it looks.
              </p>
              {failed ? (
                <p className="hint">The text could not be loaded.</p>
              ) : text === null ? (
                <p className="hint">Loading…</p>
              ) : text.trim() ? (
                <div className="doc-preview-body">{text}</div>
              ) : (
                <p className="hint">Nothing was read from this document.</p>
              )}
            </div>
          )
        ) : null}
      </dialog>
    </>
  );
}
