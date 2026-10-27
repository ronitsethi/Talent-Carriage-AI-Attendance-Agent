import { ChevronDown, IndianRupee } from 'lucide-react';
import { clockTime } from '@/lib/display';
import type { CostBox as Box } from '@/lib/costs/summary';
import { COSTS_RECORDED_FROM, COSTS_RECORDED_FROM_LABEL, PRICES_CHECKED } from '@/lib/costs/prices';

/**
 * What a call or chat cost, under its transcript: the total on the bar, and
 * opened, one group per call or message with what went into it.
 */

export function rupees(inr: number | null): string {
  if (inr === null) return 'no price';
  if (inr === 0) return '₹0';
  if (inr < 0.01) return `₹${inr.toFixed(4)}`;
  if (inr < 1) return `₹${inr.toFixed(3)}`;
  return `₹${inr.toFixed(2)}`;
}

export function CostBox({ box, title = 'Cost', at, open = false }: { box: Box; title?: string; at?: Date | null; open?: boolean }) {
  const rows = box.groups.reduce((n, g) => n + g.rows.length, 0);
  // Model, speech and minutes were only written down from this date; anything
  // older shows what can be worked out afterwards - WhatsApp's fees - and no more.
  const older = Boolean(at && at < COSTS_RECORDED_FROM);
  return (
    <details className="cost-box" open={open}>
      <summary className="cost-head">
        <IndianRupee size={14} aria-hidden />
        <span className="cost-title">{title}</span>
        <span className="cost-total mono">
          {rows ? rupees(box.inr) : '—'}
          {box.estimated ? <span className="cost-est">est.</span> : null}
        </span>
        <ChevronDown size={16} className="cost-chevron" aria-hidden />
      </summary>
      <div className="cost-body">
        {rows ? (
          <table className="cost-table">
            <tbody>
              {box.groups.map((g) => (
                <GroupRows key={g.key} group={g} showHead />
              ))}
            </tbody>
          </table>
        ) : (
          <p className="hint">
            {older ? `Costs are recorded from ${COSTS_RECORDED_FROM_LABEL}; this was before then.` : 'Nothing has been spent on this yet.'}
          </p>
        )}
        {rows && older ? (
          <p className="cost-foot hint">
            This began before {COSTS_RECORDED_FROM_LABEL}, when costs started being recorded: only WhatsApp&apos;s fees are shown for
            what happened before then, not the AI, speech or phone line.
          </p>
        ) : null}
        <p className="cost-foot hint">
          List prices checked {PRICES_CHECKED}, before GST and free allowances. Dollar prices at ₹{box.rate}/$.
          {box.estimated ? ' “est.” means it is worked out from usage at list price; a line marked “from Plivo” is Plivo’s own charge.' : ''}
          {box.unpriced ? ' A row with no price uses something not on the price list.' : ''}
        </p>
      </div>
    </details>
  );
}

function GroupRows({ group, showHead }: { group: Box['groups'][number]; showHead: boolean }) {
  return (
    <>
      {showHead ? (
        <tr className="cost-group">
          <th scope="rowgroup" colSpan={2}>
                {group.title}
          </th>
          <td className="mono num">{rupees(group.inr)}</td>
        </tr>
      ) : null}
      {group.rows.map((row, index) => (
        <tr key={index} className="cost-row">
          <td>
            {row.item}
            {/* On a phone the quantity column folds into this one. */}
            <span className="cost-note cost-narrow">{row.quantity}</span>
            {row.note ? <span className="cost-note">{row.note}</span> : null}
          </td>
          <td className="mono cost-qty">{row.quantity}</td>
          <td className="mono num">
            {rupees(row.inr)}
            {row.original ? <span className="cost-note">{row.original}</span> : null}
            {!row.estimated && row.inr ? <span className="cost-note">from Plivo</span> : null}
          </td>
        </tr>
      ))}
    </>
  );
}
