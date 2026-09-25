/**
 * Signs in through the real login form and photographs the pages.
 * Used to check the workspace renders, not as a substitute for tests.
 *
 *   npx tsx scripts/screenshot.ts [outputDir]
 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.APP_BASE_URL ?? 'http://localhost:3000';
const OUT = process.argv[2] ?? '/tmp/tc-shots';
const PAGES: [string, string][] = [
  ['/', 'dashboard'],
  ['/cases', 'cases'],
  ['/mapping', 'mapping'],
  ['/settings', 'settings'],
  ['/admin', 'admin'],
];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  // Reuse a browser already listening on the debugging port, or start one.
  let chrome: ReturnType<typeof spawn> | null = null;
  const running = await fetch('http://127.0.0.1:9222/json/version').then(
    () => true,
    () => false,
  );
  if (!running) {
    chrome = spawn(CHROME, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--remote-debugging-port=9222',
      `--user-data-dir=/tmp/tc-chrome-${Date.now()}`,
    ]);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: { width: 1440, height: 1000 } });
  const page = await browser.newPage();

  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2' });
  // A reused browser profile may still be signed in, in which case /login
  // redirects away and there is no form to fill.
  // A server redirect can still leave /login in the URL for a moment, so look
  // for the form itself rather than trusting the address.
  const needsLogin = await page.waitForSelector('#email', { timeout: 3000 }).then(() => true, () => false);
  if (needsLogin) {
    await page.type('#email', process.env.DEMO_EMAIL ?? 'admin@talentcarriage.test');
    await page.type('#password', process.env.DEMO_PASSWORD ?? 'attendance123');
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }), page.click('button[type="submit"]')]);
  }

  for (const [path, name] of PAGES) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle2' });
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
    console.log(`${name}: ${page.url()}`);
  }

  // The first case, which is where the conversation and simulator live.
  await page.goto(`${BASE}/cases`, { waitUntil: 'networkidle2' });
  const href = await page.evaluate(() => document.querySelector<HTMLAnchorElement>('a[href^="/cases/"]')?.getAttribute('href'));
  if (href) {
    await page.goto(`${BASE}${href}`, { waitUntil: 'networkidle2' });
    await page.screenshot({ path: `${OUT}/case-detail.png`, fullPage: false });
    console.log(`case detail: ${page.url()}`);
  }

  await browser.disconnect();
  chrome?.kill();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
