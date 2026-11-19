'use client';

import { useActionState, useState } from 'react';
import { savePrompt, tryPrompt, type TryState } from '@/app/prompt-actions';
import { ConfirmSubmit } from '@/components/confirm';

/**
 * The text box for one prompt, with Save and Try.
 *
 * Every field is controlled: React resets an uncontrolled form once a server
 * action finishes, and Try is one, so the draft would otherwise snap back to
 * the saved text after each try.
 */
export function PromptEditor({
  prompt,
  initial,
  customer,
  people,
}: {
  prompt: string;
  initial: string;
  customer: string;
  people: { id: string; name: string; code: string }[];
}) {
  const [body, setBody] = useState(initial);
  const [note, setNote] = useState('');
  const [onlyThis, setOnlyThis] = useState(false);
  const [question, setQuestion] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [channel, setChannel] = useState<'call' | 'chat'>('call');
  const [tried, tryAction, trying] = useActionState<TryState, FormData>(tryPrompt, null);
  const changed = body.trim() !== initial.trim();

  return (
    <form
      action={savePrompt}
      // Enter in a one-line box would submit the form's first button, which is
      // Save's own, and save without asking. Saving is only ever the button.
      onKeyDown={(event) => {
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault();
      }}
    >
      <input type="hidden" name="prompt" value={prompt} />
      <div className="form-section">
        <div className="field">
          <label htmlFor="body">Prompt text</label>
          <textarea
            className="input mono prompt-text"
            id="body"
            name="body"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            spellCheck={false}
            rows={24}
          />
        </div>
        <p className="field-help">
          Written once for calls and WhatsApp. Write HR and HRMS as they are; on a call they are spelt out for the voice.
          {changed ? ' You have unsaved changes.' : ''}
        </p>

        <div className="checks">
          <label className="check">
            <input type="checkbox" name="onlyThisCustomer" checked={onlyThis} onChange={(event) => setOnlyThis(event.target.checked)} />
            Use this version only for {customer}
          </label>
        </div>
        <p className="field-help">
          {onlyThis
            ? `Only ${customer} uses it. Every other customer keeps what it uses now.`
            : 'Unticked, every customer uses it, except a customer with its own version.'}
        </p>

        <div className="field" style={{ marginTop: 16, maxWidth: 520 }}>
          <label htmlFor="note">Note (optional)</label>
          <input
            className="input"
            id="note"
            name="note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={200}
            placeholder="What changed, e.g. shorter answers about salary"
          />
        </div>

        <div className="btn-row" style={{ marginTop: 16 }}>
          <ConfirmSubmit
            label="Save as new version"
            className="btn primary"
            title="Save and use this version?"
            message={
              <p>
                It is used straight away on calls and WhatsApp {onlyThis ? `for ${customer} only` : 'for every customer'}. You can go
                back to an earlier version at any time.
              </p>
            }
            confirmLabel="Save and use it"
            disabled={!body.trim()}
          />
          {changed ? (
            <button type="button" className="btn" onClick={() => setBody(initial)}>
              Undo my changes
            </button>
          ) : null}
        </div>
      </div>

      <div className="form-section">
        <h2>Try the text above</h2>
        <p className="field-help" style={{ marginTop: 0, marginBottom: 12 }}>
          Asks the AI a question with the text above in place of this prompt, for {customer}, without saving it. A call is
          answered as when an employee rings us; WhatsApp as a question they type. Nothing is sent to anyone.
        </p>
        <div className="row prompt-try">
          <div className="field" style={{ minWidth: 200 }}>
            <label htmlFor="employeeId">Asking as</label>
            <select className="input" id="employeeId" name="employeeId" value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>
              <option value="">Nobody in particular</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name} · {person.code}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ minWidth: 140 }}>
            <label htmlFor="channel">On</label>
            <select className="input" id="channel" name="channel" value={channel} onChange={(event) => setChannel(event.target.value as 'call' | 'chat')}>
              <option value="call">A call</option>
              <option value="chat">WhatsApp</option>
            </select>
          </div>
          <div className="field" style={{ flex: 1, minWidth: 240 }}>
            <label htmlFor="question">Question</label>
            <input
              className="input"
              id="question"
              name="question"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              maxLength={500}
              placeholder="e.g. Why is my salary less this month?"
            />
          </div>
          <div className="field">
            <label aria-hidden>&nbsp;</label>
            <button type="submit" className="btn" formAction={tryAction} disabled={trying || !question.trim()}>
              {trying ? 'Asking…' : 'Try it'}
            </button>
          </div>
        </div>
        {tried?.error ? <p className="prompt-answer err">{tried.error}</p> : null}
        {tried?.answer ? (
          <div className="prompt-answer">
            <div className="sub">
              {tried.channel === 'chat' ? 'On WhatsApp' : 'On a call'}, to “{tried.question}”:
            </div>
            {tried.answer}
          </div>
        ) : null}
      </div>
    </form>
  );
}
