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
  speak: string;
  actionUrl: string;
  /** Voice and language Plivo speaks and listens in. */
  language?: string;
  timeoutSeconds?: number;
};

export function promptXml({ speak, actionUrl, language = 'en-IN', timeoutSeconds = 12 }: PromptOptions): string {
  return xml(
    `  <GetInput action="${escape(actionUrl)}" method="POST" inputType="dtmf speech" numDigits="1" ` +
      `language="${language}" speechModel="command_and_search" executionTimeout="${timeoutSeconds}" retries="1" ` +
      `hints="absent,working,leave,regularisation,one,two,three,four">\n` +
      `    <Speak language="${language}">${escape(speak)}</Speak>\n` +
      `  </GetInput>\n` +
      // Reached only when nothing at all was entered or said.
      `  <Speak language="${language}">We did not receive a response. We will contact you again. Goodbye.</Speak>`,
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
