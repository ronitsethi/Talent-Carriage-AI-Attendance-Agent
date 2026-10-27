import { redirect } from 'next/navigation';
import { getActiveTenantId, getSession, canManageSettings } from '@/lib/auth';
import { tenantSummary } from '@/lib/queries';
import { updateSettings } from '@/app/actions';
import { AGENT_VOICES } from '@/lib/voice/voices';
import { capabilities, env } from '@/lib/env';

/** Where attendance comes from decides who applies leave and regularisation: the employee, or the agent. */
const SOURCES = [
  {
    value: 'csv',
    title: 'CSV upload',
    copy: 'Attendance arrives as a file. The employee is asked whether they have applied it yet, is told to if not, and the manager is asked to approve it once it is in their system.',
  },
  {
    value: 'hrms',
    title: 'HRMS connected',
    copy: 'The agent offers to apply it in the HRMS itself - asking the leave type first - and applies it once the manager approves.',
  },
] as const;

const MODES = [
  { value: 'manual', title: 'Manual', copy: 'HR starts every check and reminder' },
  { value: 'automatic', title: 'Automatic', copy: 'The agent runs the daily check itself' },
] as const;

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
        <div className="eyebrow">Settings</div>
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
          <div className="card">
            {/* Still the sendingEnabled checkbox, drawn as a switch. The row
                turns red while it is off, because that stops everything. */}
            <div className="master">
              <div>
                <label className="master-title" htmlFor="sendingEnabled">
                  Let the agent contact employees
                </label>
                <p id="sendingEnabled-help">
                  The master switch for {tenant?.name}. Turn it off and absences are still found and cases still created,
                  but no WhatsApp message and no call ever goes out — however many times anyone presses Contact. Leave it
                  off while a new customer is being set up, or use it to stop everything at once.
                </p>
              </div>
              <input
                type="checkbox"
                role="switch"
                className="switch-input"
                id="sendingEnabled"
                name="sendingEnabled"
                aria-describedby="sendingEnabled-help"
                defaultChecked={settings.sendingEnabled}
              />
            </div>

            <div className="form-section">
              <h2>Daily check</h2>
              <div className="row">
                <div className="field" style={{ width: 190 }}>
                  <label htmlFor="checkTime">Check time ({settings.timezone})</label>
                  <input className="input" type="time" id="checkTime" name="checkTime" defaultValue={settings.checkTime.slice(0, 5)} />
                </div>
                <div className="field" style={{ width: 140 }}>
                  <label htmlFor="quietHoursStart">Quiet from</label>
                  <input className="input" type="time" id="quietHoursStart" name="quietHoursStart" defaultValue={settings.quietHoursStart.slice(0, 5)} />
                </div>
                <div className="field" style={{ width: 140 }}>
                  <label htmlFor="quietHoursEnd">Quiet until</label>
                  <input className="input" type="time" id="quietHoursEnd" name="quietHoursEnd" defaultValue={settings.quietHoursEnd.slice(0, 5)} />
                </div>
              </div>
              {/* Still the operatingMode radio, drawn as two cards. */}
              <fieldset style={{ marginTop: 16 }}>
                <legend className="label">How the agent runs</legend>
                <div className="choice-cards">
                  {MODES.map((mode) => (
                    <label key={mode.value} className="choice-card">
                      <input type="radio" name="operatingMode" value={mode.value} defaultChecked={settings.operatingMode === mode.value} />
                      <span className="choice-title">{mode.title}</span>
                      <span className="choice-copy">{mode.copy}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <p className="field-help">
                Manual is the default, so a newly configured customer can never message anyone by surprise. In automatic
                mode the daily check runs at the time above, and due reminders go out on their own.
              </p>
            </div>

            <div className="form-section">
              <div className="section-head">
                <h2>The talking call</h2>
                <span className={`flag ${caps.voiceAgent ? 'ok' : ''}`} style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink-600)' }}>
                  {caps.voiceAgent ? 'LiveKit connected' : 'Not configured — calls use the keypad'}
                </span>
              </div>
              <div className="row">
                <div className="field" style={{ width: 240 }}>
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
                <div className="field" style={{ width: 140 }}>
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
              <p className="field-help">
                Indian voices, for employees set to Call · Talk. Slightly under 1.0 is easier to follow on a poor line.
                Run <span className="mono" style={{ color: 'var(--ink-900)' }}>npm run voices</span> to hear each one speak
                the real opening line before choosing.
              </p>
            </div>

            <div className="form-section">
              <h2>Backlog and escalation</h2>
              <div className="field-grid">
                <div className="field">
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
                <div className="field">
                  <label htmlFor="followUpAfterDays">Reminder after (days)</label>
                  <input className="input" type="number" min={1} id="followUpAfterDays" name="followUpAfterDays" defaultValue={settings.followUpAfterDays} />
                </div>
                <div className="field">
                  <label htmlFor="callAfterDays">Call after (days)</label>
                  <input className="input" type="number" min={1} id="callAfterDays" name="callAfterDays" defaultValue={settings.callAfterDays} />
                </div>
                <div className="field">
                  <label htmlFor="approvalTimeoutHours">Approval timeout (hours)</label>
                  <input className="input" type="number" min={1} id="approvalTimeoutHours" name="approvalTimeoutHours" defaultValue={settings.approvalTimeoutHours} />
                </div>
              </div>
              <p className="field-help" style={{ maxWidth: '70ch' }}>
                0 means no cap: every absent date is asked as it is found, and unanswered dates pile up until the employee
                starts answering. With a cap, the extras wait and are asked one at a time as earlier dates are answered.
              </p>
              <div className="checks">
                <label className="check">
                  <input type="checkbox" name="sendBacklogSummary" defaultChecked={settings.sendBacklogSummary} />
                  Send the &quot;N days still pending&quot; summary after each answer
                </label>
              </div>
            </div>

            <div className="form-section">
              <div className="section-head">
                <h2>Leave and regularisation</h2>
              </div>
              <fieldset>
                <legend className="label">Where this customer&apos;s attendance comes from</legend>
                <div className="choice-cards">
                  {SOURCES.map((source) => (
                    <label key={source.value} className="choice-card">
                      <input
                        type="radio"
                        name="attendanceSource"
                        value={source.value}
                        defaultChecked={settings.attendanceSource === source.value}
                      />
                      <span className="choice-title">{source.title}</span>
                      <span className="choice-copy">{source.copy}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <p className="field-help">
                Either way the employee&apos;s manager is asked to approve it - on the number in the file&apos;s manager mobile
                column, or the manager code&apos;s own mobile. Each manager&apos;s contact settings are on the Managers page.
              </p>
            </div>

            <div className="card-foot">
              {!readOnly ? (
                <button className="btn primary lg" type="submit">
                  Save settings
                </button>
              ) : (
                <span>Your role can view these settings but not change them.</span>
              )}
            </div>
          </div>

          <section className="card pad">
            <div className="section-head">
              <h2>Connection</h2>
            </div>
            <dl className="kv">
              <dt>Mode</dt>
              <dd>{env.DRY_RUN ? 'Dry run (simulator)' : 'Live'}</dd>
              <dt>Webhook URL</dt>
              <dd className="mono">{env.APP_BASE_URL}/api/webhook</dd>
              <dt>Verify token</dt>
              <dd>{env.WA_VERIFY_TOKEN ? 'configured' : 'not set'}</dd>
              <dt>Language</dt>
              <dd>{settings.defaultLanguage}</dd>
              <dt>HRMS connector</dt>
              <dd>{env.HRMS_CONNECTOR}</dd>
            </dl>
          </section>
        </div>
      </form>
    </>
  );
}
