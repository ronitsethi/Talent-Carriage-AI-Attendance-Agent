import Image from 'next/image';

/**
 * The Talent Carriage wordmark.
 *
 * One definition for both places it appears, because a logo that is typed out
 * twice is a logo that will eventually disagree with itself. The artwork is the
 * same file the client hub ships, so the two products look like one company.
 *
 * It sits on white rather than on the navy behind it: the mark is drawn in the
 * brand's own teal and blue, and those disappear against a dark background. The
 * white card is what makes it legible, not decoration.
 */

/** The artwork's own proportions, 1098 x 501. */
const RATIO = 501 / 1098;

/** Asked for at twice the size it is drawn, so it stays sharp on a retina screen. */
const NATURAL = 440;

export function Wordmark({ width }: { width?: number }) {
  return (
    // Without a width it fills whatever it is given - which is what the sidebar
    // wants. With one, the card is that wide and the artwork follows, rather
    // than the artwork stretching to a card sized by something else.
    <div className="logo-card" style={width ? { width, boxSizing: 'border-box' } : undefined}>
      <Image
        src="/brand/logo-tagline.png"
        alt="Talent Carriage — Imagine Innovate Transform"
        width={NATURAL}
        height={Math.round(NATURAL * RATIO)}
        priority
        style={{ display: 'block', width: '100%', height: 'auto' }}
      />
    </div>
  );
}
