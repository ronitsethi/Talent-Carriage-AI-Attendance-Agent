// Message texts and options from Workflow.svg (first stage only).

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDate(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return `${String(d).padStart(2, '0')}-${MONTHS[m - 1]}-${y}`;
}

// "18-Aug-2026", "18-Aug-2026 (second half)" for P|A, "(first half)" for A|P.
export function absentDateLabel(isoDate, code) {
  const base = formatDate(isoDate);
  if (code === 'P|A') return `${base} (second half)`;
  if (code === 'A|P') return `${base} (first half)`;
  return base;
}

export function firstName(fullName) {
  return String(fullName).trim().split(/\s+/)[0];
}

export const OPTIONS = {
  1: { label: 'Yes, I was absent', button: 'Yes, I was absent', action: 'Apply leave / unpaid leave' },
  2: { label: 'No, I was working', button: 'No, I was working', action: 'Apply regularization' },
  3: { label: 'I have already applied leave', button: 'Already applied leave', action: 'Manager to approve leave' },
  4: { label: 'I have already sent regularization request', button: 'Sent regularization', action: 'Manager to approve regularization' },
};

// Mirrors the approved template (attendance_absent_check). Used for the log + preview.
export function firstMessage(name, dateLabel) {
  return `Hi ${name}, our attendance record shows you are marked absent on ${dateLabel}. Please confirm the reason by choosing one option below.

1. ${OPTIONS[1].label}
2. ${OPTIONS[2].label}
3. ${OPTIONS[3].label}
4. ${OPTIONS[4].label}`;
}

export function systemReply(option, dateLabel) {
  switch (Number(option)) {
    case 1:
      return 'Please apply leave if leave balance is available. If leave balance is not available, please follow the HR process for unpaid leave/regularization and get it approved by your manager.';
    case 2:
      return `Please apply attendance regularization for ${dateLabel} and get it approved by your manager.`;
    case 3:
      return `Please ask your manager to approve your leave for ${dateLabel}.`;
    case 4:
      return `Please ask your manager to approve your regularization request for ${dateLabel}.`;
    default:
      throw new Error(`Unknown option ${option}`);
  }
}

export function clarifyMessage(dateLabel) {
  return `Sorry, we couldn't understand your reply about ${dateLabel}. Please reply with 1, 2, 3 or 4:

1. ${OPTIONS[1].label}
2. ${OPTIONS[2].label}
3. ${OPTIONS[3].label}
4. ${OPTIONS[4].label}`;
}
