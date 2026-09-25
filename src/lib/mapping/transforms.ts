/**
 * Value clean-ups applied while reading a customer's file, so the mapping screen
 * can fix everyday messiness ("  9686770749 ", "+91 96867-70749", "p|p") without
 * anyone writing code.
 */
export type TransformName =
  | 'trim'
  | 'upper'
  | 'lower'
  | 'title_case'
  | 'digits_only'
  | 'strip_leading_zero'
  | 'phone_india'
  | 'phone_e164'
  | 'collapse_spaces'
  | 'empty_to_null';

export const TRANSFORM_LABELS: Record<TransformName, string> = {
  trim: 'Trim spaces',
  upper: 'UPPERCASE',
  lower: 'lowercase',
  title_case: 'Title Case',
  digits_only: 'Keep digits only',
  strip_leading_zero: 'Remove leading zero',
  phone_india: 'Indian mobile → 91XXXXXXXXXX',
  phone_e164: 'Phone → digits with country code',
  collapse_spaces: 'Collapse repeated spaces',
  empty_to_null: 'Treat blank as empty',
};

function titleCase(value: string): string {
  return value.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

/**
 * Indian mobile numbers arrive as 10 digits, with a leading 0, with +91, or with
 * spaces and dashes. WhatsApp wants digits with the country code and no plus.
 */
export function normaliseIndianMobile(value: string): string | null {
  const digits = value.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  if (digits.length === 13 && digits.startsWith('091')) return digits.slice(1);
  // Anything else is returned as-is; validation flags it rather than guessing.
  return digits;
}

export function applyTransform(value: string, name: TransformName): string {
  switch (name) {
    case 'trim':
      return value.trim();
    case 'upper':
      return value.toUpperCase();
    case 'lower':
      return value.toLowerCase();
    case 'title_case':
      return titleCase(value.trim());
    case 'digits_only':
      return value.replace(/\D/g, '');
    case 'strip_leading_zero':
      return value.replace(/^0+/, '');
    case 'phone_india':
      return normaliseIndianMobile(value) ?? '';
    case 'phone_e164':
      return value.replace(/\D/g, '');
    case 'collapse_spaces':
      return value.replace(/\s+/g, ' ').trim();
    case 'empty_to_null':
      return value.trim();
    default:
      return value;
  }
}

export function applyTransforms(value: string, names: TransformName[] | string[] | undefined): string {
  if (!names?.length) return value;
  return (names as TransformName[]).reduce((acc, name) => applyTransform(acc, name), value);
}

/** True when a mobile number is usable for WhatsApp: country code plus a plausible length. */
export function isPlausibleMobile(e164: string | null | undefined): boolean {
  if (!e164) return false;
  return /^\d{11,15}$/.test(e164);
}
