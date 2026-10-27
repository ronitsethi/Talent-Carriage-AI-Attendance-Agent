import { Building2, CalendarDays, MessageCircle, Phone, Smartphone } from 'lucide-react';
import { formatTime, initials } from '@/lib/display';

/**
 * Who a query or a case is about, at the top of its box: their face, name and
 * how they were reached; their company and when; their code and department;
 * and their number.
 */

// Brand-safe fills, picked by name so one person keeps one colour everywhere.
const FILLS = ['#1e5aa9', '#185c5c', '#16437e', '#7a4205', '#a01b14', '#10653c', '#3d4c63'];
function fill(name: string) {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return FILLS[hash % FILLS.length]!;
}

export function PersonHead({
  name,
  channel,
  company,
  at,
  code,
  department,
  mobile,
}: {
  name: string;
  channel: 'whatsapp' | 'voice';
  company: string;
  at: Date | string | null;
  code: string;
  department: string | null;
  mobile: string | null;
}) {
  const call = channel === 'voice';
  return (
    <div className="person-head">
      <span className="person-avatar" style={{ background: fill(name) }} aria-hidden>
        {initials(name)}
      </span>
      <div className="person-lines">
        <div className="person-line">
          <h2 className="person-name">{name}</h2>
          <span className={`channel-pill ${call ? 'voice' : 'wa'}`}>
            {call ? <Phone size={14} aria-hidden /> : <MessageCircle size={14} aria-hidden />}
            {call ? 'Call' : 'WhatsApp'}
          </span>
        </div>
        <div className="person-line">
          <span>{company}</span>
          <span className="person-meta">
            <CalendarDays size={14} aria-hidden /> {formatTime(at)}
          </span>
        </div>
        <div className="person-line">
          <span>
            Code <span className="code-chip mono">{code}</span>
          </span>
          <span className="person-meta">
            <Building2 size={14} aria-hidden /> {department ?? 'No department'}
          </span>
        </div>
        <div className="person-line">
          <span className="person-meta">
            <Smartphone size={14} aria-hidden /> {mobile ? `+${mobile}` : 'No number on record'}
          </span>
        </div>
      </div>
    </div>
  );
}
