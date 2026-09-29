import { redirect } from 'next/navigation';
import { getActiveTenantId, getSession, canManageSettings } from '@/lib/auth';
import { tenantSummary } from '@/lib/queries';
import { updateSettings } from '@/app/actions';
import { AGENT_VOICES } from '@/lib/voice/voices';
import { capabilities, env } from '@/lib/env';

export default async function SettingsPage() {
  const session = await getSession();
  if (!session) redirect('/login');
  const tenantId = await getActiveTenantId(session);
  if (!tenantId) redirect('/');

  const { tenant, settings } = await tenantSummary(tenantId);
  const caps = capabilities();
  if (!settings) return <p style={{ paddingTop: 40 }}>This customer has no settings row.</p>;
  const readOnly = !canManageSettings(session);

  return (
    <>
      <section className="page-head">
        <div className="eyebrow">⚙ Settings</div>
        <h1>{tenant?.name}</h1>
        <p>How the agent behaves for this customer. Everything here is per customer, not global.</p>
      </section>

      {/*
        Keyed on when the settings last changed.

        React resets an uncontrolled form to its original `defaultValue` once a
        server action finishes, and re-rendering does not refresh that value -
        so every field visibly snapped back to what it was before the save, and
        only looked right again after a reload. Changing the key remounts the
        form, which makes the freshly saved values the new defaults.
      */}
      <form action={updateSettings} key={String(settings.updatedAt)}>
        <div className="layout">
          <div>
            <section className="card pad">
              <div className="section-head">
                <h2>Daily check</h2>
              </div>
              <div className="row" style={{ padding: 0 }}>
                <div className="field" style={{ minWidth: 160 }}>
                  <label htmlFor="checkTime">Check time ({settings.timezone})</label>
                  <input className="input" type="time" id="checkTime" name="checkTime" defaultValue={settings.checkTime.slice(0, 5)} />
                </div>
                <div className="field" style={{ minWidth: 140 }}>
                  <label htmlFor="quietHoursStart">Quiet from</label>
                  <input className="input" type="time" id="quietHoursStart" name="quietHoursStart" defaultValue={settings.quietHoursStart.slice(0, 5)} />
                </div>
                <div className="field" style={{ minWidth: 140 }}>
                  <label htmlFor="quietHoursEnd">Quiet until</label>
                  <input className="input" type="time" id="quietHoursEnd" name="quietHoursEnd" defaultValue={settings.quietHoursEnd.slice(0, 5)} />
                </div>
              </div>
              <div className="field" style={{ marginTop: 14, maxWidth: 420 }}>
                <label htmlFor="operatingMode">How the agent runs</label>
                <select className="input" id="operatingMode" name="operatingMode" defaultValue={settings.operatingMode}>
                  <option value="manual">Manual — HR starts every check and reminder</option>
                  <option value="automatic">Automatic — the agent runs the daily check itself</option>
                </select>
                <p className="hint" style={{ marginTop: 6 }}>
                  Manual is the default, so a newly configured customer can never message anyone by surprise. In
                  automatic mode the daily check runs at the time above, and due reminders go out on their own.
                </p>
              </div>
              <label style={{ display: 'block', marginTop: 14, fontWeight: 600 }}>
                <input type="checkbox" name="sendingEnabled" defaultChecked={settings.sendingEnabled} /> Let the agent
                contact employees
              </label>
              <p className="hint" style={{ marginTop: 4 }}>
                The master switch for {tenant?.name}. Turn it off and absences are still found and cases still created,
                but no WhatsApp message and no call ever goes out — however many times anyone presses Contact. Leave it
                off while a new customer is being set up, or use it to stop everything at once.
              </p>
            </section>

            <section className="card pad" style={{ marginTop: 18 }}>
              <div className="section-head">
                <h2>The talking call</h2>
                <span className="hint">
                  {caps.voiceAgent ? 'LiveKit connected' : 'Not configured — calls use the keypad'}
                </span>
              </div>
              <div className="row" style={{ padding: 0 }}>
                <div className="field" style={{ minWidth: 240 }}>
                  <label htmlFor="agentVoice">Voice</label>
                  <select className="input" id="agentVoice" name="agentVoice" defaultValue={settings.agentVoice}>
                    <optgroup label="Female">
                      {AGENT_VOICES.filter((v) => v.gender === 'female').map((voice) => (
                        <option key={voice.id} value={voice.id}>
                          {voice.label}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Male">
                      {AGENT_VOICES.filter((v) => v.gender === 'male').map((voice) => (
                        <option key={voice.id} value={voice.id}>
                          {voice.label}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                </div>
                <div className="field" style={{ minWidth: 160 }}>
                  <label htmlFor="agentVoicePace">Speed</label>
                  <input
                    className="input"
                    type="number"
                    id="agentVoicePace"
                    name="agentVoicePace"
                    step="0.05"
                    min="0.7"
                    max="1.3"
                    defaultValue={Number(settings.agentVoicePace)}
                  />
                </div>
              </div>
              <p className="hint" style={{ marginTop: 8 }}>
                Indian voices, for employees set to Call · Talk. Slightly under 1.0 is easier to follow on a poor
                line. Run <code>npm run voices</code> to hear each one speak the real opening line before choosing.
              </p>
            </section>

            <section className="card pad">
              <div className="section-head">
                <h2>Backlog and escalation</h2>
              </div>
              <div className="row" style={{ padding: 0 }}>
                <div className="field" style={{ minWidth: 200 }}>
                  <label htmlFor="maxOutstandingQuestions">Outstanding questions cap</label>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    id="maxOutstandingQuestions"
                    name="maxOutstandingQuestions"
                    defaultValue={settings.maxOutstandingQuestions}
                  />
                </div>
                <div className="field" style={{ minWidth: 150 }}>
                  <label htmlFor="followUpAfterDays">Reminder after (days)</label>
                  <input className="input" type="number" min={1} id="followUpAfterDays" name="followUpAfterDays" defaultValue={settings.followUpAfterDays} />
                </div>
                <div className="field" style={{ minWidth: 150 }}>
                  <label htmlFor="callAfterDays">Call after (days)</label>
                  <input className="input" type="number" min={1} id="callAfterDays" name="callAfterDays" defaultValue={settings.callAfterDays} />
                </div>
                <div className="field" style={{ minWidth: 180 }}>
                  <label htmlFor="approvalTimeoutHours">Approval timeout (hours)</label>
                  <input className="input" type="number" min={1} id="approvalTimeoutHours" name="approvalTimeoutHours" defaultValue={settings.approvalTimeoutHours} />
                </div>
              </div>
              <p className="hint" style={{ marginTop: 6 }}>
                0 means no cap: every absent date is asked as it is found, and unanswered dates pile up until the
                employee starts answering. With a cap, the extras wait and are asked one at a time as earlier dates are
                answered.
              </p>
              <label style={{ display: 'block', marginTop: 10, fontWeight: 600 }}>
                <input type="checkbox" name="sendBacklogSummary" defaultChecked={settings.sendBacklogSummary} /> Send the
                &quot;N days still pending&quot; summary after each answer
              </label>
              <label style={{ display: 'block', marginTop: 8, fontWeight: 600 }}>
                <input type="checkbox" name="actionsEnabled" defaultChecked={settings.actionsEnabled} /> Let the agent
                apply leave and regularisation in the HRMS
              </label>
            </section>

            {!readOnly ? (
              <button className="btn primary" type="submit" style={{ marginTop: 16 }}>
                Save settings
              </button>
            ) : (
              <div className="notice info" style={{ marginTop: 16 }}>
                Your role can view these settings but not change them.
              </div>
            )}
          </div>

          <aside>
            <section className="card pad">
              <div className="section-head">
                <h2>Connection</h2>
              </div>
              <dl className="kv">
                <dt>Mode</dt>
                <dd>{env.DRY_RUN ? 'Dry run (simulator)' : 'Live'}</dd>
                <dt>Webhook URL</dt>
                <dd>
                  <code>{env.APP_BASE_URL}/api/webhook</code>
                </dd>
                <dt>Verify token</dt>
                <dd>{env.WA_VERIFY_TOKEN ? 'configured' : 'not set'}</dd>
                <dt>Language</dt>
                <dd>{settings.defaultLanguage}</dd>
                <dt>HRMS connector</dt>
                <dd>{env.HRMS_CONNECTOR}</dd>
              </dl>
            </section>
          </aside>
        </div>
      </form>
    </>
  );
}
