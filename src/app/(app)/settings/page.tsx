import { redirect } from 'next/navigation';
import { getActiveTenantId, getSession, canManageSettings } from '@/lib/auth';
import { tenantSummary } from '@/lib/queries';
import { updateSettings } from '@/app/actions';
import { LevelContacts } from '@/components/follow-up-contacts';
import { AGENT_VOICES, agentVoice } from '@/lib/voice/voices';
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
  { value: 'manual', title: 'Manual', copy: 'HR contacts people from the dashboard' },
  { value: 'automatic', title: 'Automatic', copy: 'Each upload offers to send what is due' },
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
  // Only what the per-level rows need, plain enough to hand to the browser.
  const levelSettings = {
    reminderContacts: settings.reminderContacts,
    followUpContacts: settings.followUpContacts,
    remindersBeforeEscalation: settings.remindersBeforeEscalation,
    maxFollowUps: settings.maxFollowUps,
    reminderCallsAllowed: settings.reminderCallsAllowed,
    followUpCallsAllowed: settings.followUpCallsAllowed,
    reminderCallMode: settings.reminderCallMode,
    followUpCallMode: settings.followUpCallMode,
  };

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
                <p id="sendingEnabled-help">The master switch: off, nothing is sent or rung for {tenant?.name}, whatever anyone presses.</p>
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
              <h2>Sending</h2>
              {/* Still the operatingMode radio, drawn as two cards. */}
              <fieldset>
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
              <Help>Manual: HR sends from the dashboard. Automatic: each upload offers to send what is due; employees set to Manual are left out.</Help>
              <div className="settings-grid" style={{ marginTop: 14 }}>
                <Box id="sendDelayMinutes" label="Start sending after (minutes)" help="How long after you choose Send following an upload the messages and calls start.">
                  <input className="input" type="number" min={0} max={1440} id="sendDelayMinutes" name="sendDelayMinutes" defaultValue={settings.sendDelayMinutes} />
                </Box>
              </div>
              <Check name="saturdayWorking" checked={settings.saturdayWorking} label="Saturday is a working day" help="Counts Saturday as a working day; otherwise Monday to Friday. Nothing is sent, and no step counted, on other days." />
            </div>

            <div className="form-section">
              <h2>First question</h2>
              <div className="settings-grid">
                <Box id="defaultChannel" label="Contact by" help="How the first question goes for employees with no setting of their own.">
                  <select className="input" id="defaultChannel" name="defaultChannel" defaultValue={settings.defaultChannel}>
                    <option value="whatsapp">WhatsApp</option>
                    <option value="voice">Call</option>
                  </select>
                </Box>
                <Box id="callMode" label="Call style" help="Keypad or talking, for a first-question call.">
                  <StyleSelect id="callMode" value={settings.callMode} />
                </Box>
              </div>
            </div>

            <div className="form-section">
              <h2>Reminders</h2>
              <LevelContacts kind="reminder" settings={levelSettings}>
                <Box id="reminderIntervalDays" label="Remind after (working days)" help="The least gap between a date's reminders. They go only with an upload send, so a day with no upload sends none; 0 switches reminders off.">
                  <input className="input" type="number" min={0} max={30} id="reminderIntervalDays" name="reminderIntervalDays" defaultValue={settings.reminderIntervalDays} />
                </Box>
              </LevelContacts>
            </div>

            <div className="form-section">
              <h2>Follow-ups</h2>
              <LevelContacts kind="follow_up" settings={levelSettings} />
              <Check name="sendBacklogSummary" checked={settings.sendBacklogSummary} label='Send the "N days still pending" summary after each answer' help="After one date is answered, tells them how many are left and asks about the next." />
            </div>

            <div className="form-section">
              <h2>Call rule</h2>
              <div className="settings-grid">
                <Box id="ignoredBeforeCall" label="Ignored contacts before a call" help="Messages or calls they must ignore in a row before they are called; any reply resets it.">
                  <input className="input" type="number" min={0} max={10} id="ignoredBeforeCall" name="ignoredBeforeCall" defaultValue={settings.ignoredBeforeCall} />
                </Box>
                <Box id="callGapDays" label="Working days between calls" help="After a call, nobody is called again for this many working days.">
                  <input className="input" type="number" min={0} max={10} id="callGapDays" name="callGapDays" defaultValue={settings.callGapDays} />
                </Box>
              </div>
              <Help>A reminder or follow-up is a call only when its row says Call and both of these allow it; otherwise WhatsApp. A WhatsApp row is never a call. One call covers all of a person&apos;s due dates. A missed call sends the WhatsApps at once.</Help>
            </div>

            <div className="form-section">
              <h2>Escalation</h2>
              <div className="settings-grid">
                <Box id="escalationRoute" label="After the employee's last step, send to" help="Who gets dates the employee did not settle: the manager then HR, HR directly, or the manager only.">
                  <select className="input" id="escalationRoute" name="escalationRoute" defaultValue={settings.escalationRoute}>
                    <option value="manager_then_hr">Manager, then HR</option>
                    <option value="hr">HR directly</option>
                    <option value="manager">Manager only</option>
                  </select>
                </Box>
                <Box id="managerRespondDays" label="Manager has to respond within (working days)" help="Ignored this long on WhatsApp brings a call; ignored as long again sends it to HR.">
                  <input className="input" type="number" min={1} max={3} id="managerRespondDays" name="managerRespondDays" defaultValue={settings.managerRespondDays} />
                </Box>
                <Box id="speakGraceDays" label={'"I\'ll speak to them" gives the employee (working days)'} help="The time the employee has to sort it out before HR, when the manager will speak to them.">
                  <input className="input" type="number" min={0} max={3} id="speakGraceDays" name="speakGraceDays" defaultValue={settings.speakGraceDays} />
                </Box>
                <Box id="payrollCutoffDay" label="Payroll cut-off day of the month" help="Dates with HR are marked urgent from 2 working days before it; leave empty for off.">
                  <input className="input" type="number" min={1} max={31} id="payrollCutoffDay" name="payrollCutoffDay" placeholder="Off" defaultValue={settings.payrollCutoffDay ?? ''} />
                </Box>
              </div>
              <h3 className="label" style={{ marginTop: 18 }}>HR contact</h3>
              <div className="settings-grid">
                <Box id="hrName" label="Name" help="Who at the customer takes dates the manager does not decide.">
                  <input className="input" id="hrName" name="hrName" defaultValue={settings.hrName ?? ''} />
                </Box>
                <Box id="hrMobile" label="WhatsApp number" help="Where HR is told; without it, dates only show on the Needs HR tab.">
                  <input className="input" id="hrMobile" name="hrMobile" placeholder="98765 43210" defaultValue={settings.hrMobileE164 ? `+${settings.hrMobileE164}` : ''} />
                </Box>
                <Box id="hrEmail" label="Email (not used yet)" help="Kept for when email is added; nothing is emailed yet.">
                  <input className="input" type="email" id="hrEmail" name="hrEmail" defaultValue={settings.hrEmail ?? ''} />
                </Box>
              </div>
              <Check name="hrTellWhatsapp" checked={settings.hrTellWhatsapp} label="Tell HR on WhatsApp as dates reach them" help="A WhatsApp to HR each time dates move to Needs HR." />
              <Check name="hrDailySummary" checked={settings.hrDailySummary} label="Send HR a daily summary of what is waiting" help="One WhatsApp each working morning with how many dates wait on HR." />
            </div>

            <div className="form-section">
              <div className="section-head">
                <h2>The talking call</h2>
                <span className={`flag ${caps.voiceAgent ? 'ok' : ''}`} style={{ fontSize: 'var(--fs-meta)', color: 'var(--ink-600)' }}>
                  {caps.voiceAgent ? 'LiveKit connected' : 'Not configured — calls use the keypad'}
                </span>
              </div>
              <div className="settings-grid">
                <Box id="agentVoice" label="Voice" help="The voice of talking calls; run npm run voices to hear each one.">
                  <select className="input" id="agentVoice" name="agentVoice" defaultValue={agentVoice(settings.agentVoice)}>
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
                </Box>
                <Box id="agentVoicePace" label="Speed" help="How fast it speaks; slightly under 1.0 is easier on a poor line.">
                  <input className="input" type="number" id="agentVoicePace" name="agentVoicePace" step="0.05" min="0.7" max="1.3" defaultValue={Number(settings.agentVoicePace)} />
                </Box>
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
              <Help>Either way the manager is asked to approve it: on the file&apos;s manager mobile, or the manager code&apos;s own.</Help>
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

/** One line under a box, saying what it does. */
function Help({ children }: { children: React.ReactNode }) {
  return (
    <p className="field-help" style={{ maxWidth: '70ch', marginTop: 4 }}>
      {children}
    </p>
  );
}

/** A box: its label, the input, and one line on what it does. */
function Box({ id, label, help, children }: { id: string; label: string; help: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      <p className="field-help" id={`${id}-help`}>
        {help}
      </p>
    </div>
  );
}

/** A tick box with its one line. */
function Check({ name, checked, label, help }: { name: string; checked: boolean; label: string; help: string }) {
  return (
    <div className="checks" style={{ marginTop: 12 }}>
      <label className="check">
        <input type="checkbox" name={name} defaultChecked={checked} />
        {label}
      </label>
      <Help>{help}</Help>
    </div>
  );
}

/** Keypad or talking. */
function StyleSelect({ id, value }: { id: string; value: string }) {
  return (
    <select className="input" id={id} name={id} defaultValue={value === 'agent' ? 'agent' : 'keypad'}>
      <option value="keypad">Keypad</option>
      <option value="agent">Talk</option>
    </select>
  );
}
