import type { Metadata } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans, Sansation } from 'next/font/google';
import './globals.css';

// The brand's three faces: Plex Sans for everything, Plex Mono for codes and
// figures, Sansation for page titles and the sign-in headline only.
const plexSans = IBM_Plex_Sans({ weight: ['400', '500', '600', '700'], subsets: ['latin'], variable: '--font-sans' });
const plexMono = IBM_Plex_Mono({ weight: ['500', '600'], subsets: ['latin'], variable: '--font-mono' });
const sansation = Sansation({ weight: ['400', '700'], subsets: ['latin'], variable: '--font-display' });

export const metadata: Metadata = {
  title: 'Attendance Agent · Talent Carriage',
  description: 'AI attendance follow-up across every customer, in one place.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable} ${sansation.variable}`}>
      <body>{children}</body>
    </html>
  );
}
