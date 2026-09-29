/**
 * Plivo answer XML.
 *
 * `GetInput` with `inputType="dtmf speech"` is what lets the employee press a
 * key *or* just talk - keypad first, as agreed, speech understood the same way
 * a typed WhatsApp reply is.
 */

const escape = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export type PromptOptions = {
  /** The question. Kept short, because this is what the caller answers. */
  speak: string;
  /**
   * Anything said before the question. It is played *outside* GetInput, so a
   * greeting or a backlog summary never counts against the seconds the employee
   * has to press a key - `executionTimeout` covers the whole element, nested
   * speech included.
   */
  intro?: string;
  actionUrl: string;
  /** Voice and language Plivo speaks and listens in. */
  language?: string;
  timeoutSeconds?: number;
};

/** Plivo allows 5-60 seconds; the default of 15 is short for a spoken menu. */
const DEFAULT_TIMEOUT = 20;

export function promptXml({
  speak,
  intro,
  actionUrl,
  language = 'en-IN',
  timeoutSeconds = DEFAULT_TIMEOUT,
}: PromptOptions): string {
  const timeout = Math.min(60, Math.max(5, Math.round(timeoutSeconds)));

  return xml(
    [
      intro ? `  <Speak language="${language}">${escape(intro)}</Speak>` : null,
      getInput(speak, actionUrl, language, timeout),
      // Reached only when nothing at all was entered or said: Plivo falls
      // through to the next element rather than calling the action URL. One
      // short second chance beats hanging up on someone who was still reaching
      // for the keypad.
      getInput(`Sorry, we did not hear anything. ${optionsFrom(speak)}`, actionUrl, language, timeout),
      `  <Speak language="${language}">We did not receive a response. We will contact you again. Goodbye.</Speak>`,
      '  <Hangup/>',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

/**
 * The keys, without the context that came before them.
 *
 * A second pass does not need to explain the date again - the caller has just
 * heard it - so the re-ask keeps only the "Press N ..." sentences. If a prompt
 * ever has none, the whole thing is repeated rather than nothing at all.
 */
function optionsFrom(speak: string): string {
  const options = speak
    .split(/(?<=\.)\s+/)
    .filter((sentence) => sentence.startsWith('Press '));
  return options.length ? options.join(' ') : speak;
}

function getInput(speak: string, actionUrl: string, language: string, timeout: number): string {
  return (
    `  <GetInput action="${escape(actionUrl)}" method="POST" inputType="dtmf speech" numDigits="1" ` +
    `language="${language}" speechModel="command_and_search" executionTimeout="${timeout}" ` +
    `digitEndTimeout="2" speechEndTimeout="2" retries="1" ` +
    `hints="absent,working,leave,regularisation,done,not done,help,one,two,three,four">\n` +
    `    <Speak language="${language}">${escape(speak)}</Speak>\n` +
    `  </GetInput>`
  );
}

/**
 * A prompt for an open question, rather than one of four answers.
 *
 * The keypad prompt above is the wrong shape for this and was being reused: it
 * completes on a single digit, uses a speech model built for short commands,
 * and carries hints listing "absent, working, leave, one, two, three, four".
 * None of that can hear "how many days was I absent in August", which is why an
 * incoming call sat silent and then gave up.
 */
export function questionXml({
  speak,
  intro,
  actionUrl,
  language = 'en-IN',
  timeoutSeconds = 20,
}: PromptOptions): string {
  const listen = (prompt: string | null) =>
    `  <GetInput action="${escape(actionUrl)}" method="POST" inputType="speech" ` +
    `language="${language}" speechModel="phone_call" executionTimeout="${Math.min(60, Math.max(5, timeoutSeconds))}" ` +
    // Long enough to let somebody finish a sentence, and to sit through the
    // pause in the middle of one.
    `speechEndTimeout="3" profanityFilter="false" retries="1">\n` +
    (prompt ? `    <Speak language="${language}">${escape(prompt)}</Speak>\n` : '') +
    `  </GetInput>`;

  return xml(
    [
      intro ? `  <Speak language="${language}">${escape(intro)}</Speak>` : null,
      listen(speak),
      listen('Sorry, I did not catch that. Please say it once more.'),
      `  <Speak language="${language}">I could not hear you. Please call again, or contact your H R team. Goodbye.</Speak>`,
      '  <Hangup/>',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

export function speakAndHangupXml(speak: string, language = 'en-IN'): string {
  return xml(`  <Speak language="${language}">${escape(speak)}</Speak>\n  <Hangup/>`);
}

function xml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${body}\n</Response>`;
}

export function xmlResponse(body: string): Response {
  return new Response(body, { headers: { 'Content-Type': 'application/xml' } });
}
