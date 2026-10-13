import Image from 'next/image';

/**
 * The Talent Carriage logo.
 *
 * One definition for both places it appears, because a logo that is typed out
 * twice is a logo that will eventually disagree with itself. The artwork is the
 * brand's own, used as supplied: never redrawn, recoloured or stretched.
 *
 * The sidebar is white, so it carries the colour logo with nothing behind it.
 * The sign-in panel is navy, so it carries the white logo with the tagline.
 */

/** The artwork's own proportions. */
const COLOUR = { width: 1069, height: 404 };
const WHITE_TAGLINE = { width: 1098, height: 501 };

/** 40px high in the sidebar; 200px wide on the sign-in panel. */
const SIDEBAR_HEIGHT = 40;
const LOGIN_WIDTH = 200;

export function Wordmark({ variant }: { variant: 'sidebar' | 'login' }) {
  if (variant === 'login') {
    return (
      <Image
        src="/brand/tc-logo-white-tagline.png"
        alt="Talent Carriage — Imagine Innovate Transform"
        width={LOGIN_WIDTH}
        height={Math.round((LOGIN_WIDTH * WHITE_TAGLINE.height) / WHITE_TAGLINE.width)}
        priority
        style={{ display: 'block', width: LOGIN_WIDTH, height: 'auto' }}
      />
    );
  }

  return (
    <Image
      src="/brand/tc-logo.png"
      alt="Talent Carriage"
      width={Math.round((SIDEBAR_HEIGHT * COLOUR.width) / COLOUR.height)}
      height={SIDEBAR_HEIGHT}
      priority
      style={{ display: 'block', width: 'auto', height: SIDEBAR_HEIGHT }}
    />
  );
}
