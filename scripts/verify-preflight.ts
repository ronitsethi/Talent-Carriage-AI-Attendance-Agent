/**
 * Checks everything Meta's verification call depends on, before you press
 * Verify.
 *
 *   npm run verify:check
 *
 * Meta rings within seconds of the button and allows very few attempts, so it
 * is worth knowing the path is intact rather than finding out afterwards. On
 * 21 September the call arrived and died with "Error Reaching Answer URL"; this
 * is the check that would have caught it.
 */
import 'dotenv/config';

const AUTH_ID = process.env.PLIVO_AUTH_ID;
const AUTH_TOKEN = process.env.PLIVO_AUTH_TOKEN;
const BASE = process.env.APP_BASE_URL;
const NUMBER = (process.env.PLIVO_FROM_NUMBER ?? '').replace(/[^\d]/g, '');

const tick = (ok: boolean) => (ok ? '  ok  ' : ' FAIL ');
let failures = 0;

function report(ok: boolean, label: string, detail = '') {
  if (!ok) failures++;
  console.log(`[${tick(ok)}] ${label}${detail ? ` - ${detail}` : ''}`);
}

async function main() {
  if (!AUTH_ID || !AUTH_TOKEN || !BASE || !NUMBER) {
    throw new Error('PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN, PLIVO_FROM_NUMBER and APP_BASE_URL must all be set in .env');
  }
  const auth = 'Basic ' + Buffer.from(`${AUTH_ID}:${AUTH_TOKEN}`).toString('base64');

  // 1. The tunnel and the app, reached exactly as Plivo reaches them: a plain
  //    server request, no browser headers.
  let answerXml = '';
  try {
    const response = await fetch(`${BASE}/api/plivo/answer`, {
      method: 'POST',
      headers: { 'User-Agent': 'PlivoAPI/1.0' },
    });
    answerXml = await response.text();
    report(response.ok, 'answer URL reachable', `${response.status} from ${BASE}`);
    report(answerXml.includes('<Record'), 'answer URL records the call', answerXml.includes('<Dial') ? 'it is still forwarding' : '');
  } catch (error) {
    report(false, 'answer URL reachable', error instanceof Error ? error.message : String(error));
  }

  // 2. The recording callback, which Plivo hits when the call ends.
  try {
    const response = await fetch(`${BASE}/api/plivo/recording`, { method: 'POST' });
    report(response.ok, 'recording callback reachable', String(response.status));
  } catch (error) {
    report(false, 'recording callback reachable', error instanceof Error ? error.message : String(error));
  }

  // 3. The number must point at an application whose answer URL is ours. This
  //    is the link that was broken when the first verification call failed.
  const numberResponse = await fetch(`https://api.plivo.com/v1/Account/${AUTH_ID}/Number/${NUMBER}/`, {
    headers: { Authorization: auth },
  });
  const numberRow = (await numberResponse.json()) as { application?: string; number?: string };
  const appId = (numberRow.application ?? '').replace(/\/$/, '').split('/').pop();
  report(Boolean(appId), `+${NUMBER} is attached to an application`, appId ?? 'none');

  if (appId) {
    const appResponse = await fetch(`https://api.plivo.com/v1/Account/${AUTH_ID}/Application/${appId}/`, {
      headers: { Authorization: auth },
    });
    const app = (await appResponse.json()) as { app_name?: string; answer_url?: string };
    const expected = `${BASE}/api/plivo/answer`;
    report(app.answer_url === expected, `application "${app.app_name}" points here`, app.answer_url ?? '');
    if (app.answer_url !== expected) console.log(`         expected exactly: ${expected}`);
  }

  console.log(
    failures
      ? `\n${failures} problem(s). Fix them before pressing Verify - a failed attempt is an attempt spent.`
      : '\nAll clear. Press Verify, choose "Phone call", then run `npm run verify:code` when the call ends.',
  );
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
