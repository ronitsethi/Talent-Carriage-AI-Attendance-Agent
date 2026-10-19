/**
 * Replays an employee's side of a call through the real conversation model, on
 * the local database, and prints what the agent would say back. For checking a
 * change to how the agent talks against calls that went wrong.
 *
 *   npx tsx scripts/replay-call.ts <voice> "<employee line>" "<employee line>" ...
 *
 * A line starting "~" is said while the agent's last reply was still playing:
 * the agent's reply is marked as not heard. Each run rehearses a fresh call (see
 * rehearse-call.ts) and needs OPENAI_API_KEY and OPENAI_BASE_URL.
 */
import { execFileSync } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { withPlatformScope, withTenant } from '@/db';
import { calls, cases, employees, tenants } from '@/db/schema';
import { buildContext } from '@/lib/runtime';
import { prepareGrounding, talkTurn } from '@/lib/conversation/talk';

async function main() {
  const [voice = 'ritu', ...lines] = process.argv.slice(2);
  const callId = execFileSync('npx', ['tsx', 'scripts/rehearse-call.ts'], { encoding: 'utf8' }).trim().split('\n').at(-1)!;
  const tenant = await withPlatformScope((tx) => tx.query.tenants.findFirst({ where: eq(tenants.slug, 'demo-industries') }));

  let caseId: string | null = null;
  const say = async (said: string | null, heard?: string) => {
    await withTenant(tenant!.id, async (tx) => {
      const base = await buildContext(tx, tenant!.id);
      const ctx = { ...base, settings: { ...base.settings, agentVoice: voice } };
      const call = await tx.query.calls.findFirst({ where: eq(calls.id, callId) });
      const caseRow = await tx.query.cases.findFirst({ where: eq(cases.id, caseId ?? call!.caseId!) });
      const employee = await tx.query.employees.findFirst({ where: eq(employees.id, call!.employeeId) });
      if (said !== null) {
        prepareGrounding(`call:${callId}`, async () => ({ passages: [], attendance: '' }));
        console.log(`EMPLOYEE: ${said}${heard !== undefined ? '   [cut the agent off]' : ''}`);
      }
      let text = '';
      let language = '';
      const result = await talkTurn(
        ctx,
        { mode: 'first_contact', employee: employee!, call: call!, caseRow: caseRow!, said, heard, preparedKey: `call:${callId}` },
        (event) => (event.type === 'text' ? (text += event.text) : (language = event.language)),
      );
      caseId = result.nextCaseId ?? caseId;
      console.log(`AGENT [${language}]: ${text}${result.done ? '   [call ends]' : ''}`);
    });
  };

  await say(null);
  for (const line of lines) {
    if (line.startsWith('~')) await say(line.slice(1), '');
    else await say(line);
  }
}

main().then(() => process.exit(0));
