/**
 * Walks the whole flow through the real UI: an employee answers, accepts the
 * agent's offer, and their manager approves - ending with a leave request in the
 * HRMS. A smoke test for the screens and the wiring between them.
 *
 *   npm run dev              # in one terminal
 *   npx tsx scripts/demo-flow.ts
 */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';

const BASE = process.env.APP_BASE_URL ?? 'http://localhost:3000';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function main() {
  const running = await fetch('http://127.0.0.1:9222/json/version').then(
    () => true,
    () => false,
  );
  const chrome = running
    ? null
    : spawn(CHROME, ['--headless=new', '--disable-gpu', '--remote-debugging-port=9222', `--user-data-dir=/tmp/tc-chrome-${Date.now()}`]);
  if (chrome) await new Promise((resolve) => setTimeout(resolve, 3000));

  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: { width: 1440, height: 1100 } });
  const page = await browser.newPage();

  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2' });
  if (page.url().includes('/login')) {
    await page.type('#email', 'admin@talentcarriage.test');
    await page.type('#password', 'attendance123');
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }), page.click('button[type="submit"]')]);
  }

  const clickByText = async (text: string) => {
    for (const handle of await page.$$('button')) {
      const label = (await handle.evaluate((el) => el.textContent?.trim())) ?? '';
      if (label === text) {
        await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}), handle.click()]);
        await new Promise((resolve) => setTimeout(resolve, 800));
        return true;
      }
    }
    return false;
  };

  await page.goto(`${BASE}/cases?status=open`, { waitUntil: 'networkidle2' });
  const links = await page.$$eval('a[href^="/cases/"]', (as) => as.map((a) => a.getAttribute('href')!));
  if (!links.length) throw new Error('No open cases - run the seed first');

  // The last row is the oldest date, which is the one the chain asks about next.
  await page.goto(`${BASE}${links[links.length - 1]}`, { waitUntil: 'networkidle2' });
  const state = async () => page.$eval('.page-head p', (el) => el.textContent?.trim() ?? '');

  console.log('case:      ', page.url());
  console.log('answered:  ', await clickByText('1 · Yes, I was absent'), '->', await state());
  console.log('offer:     ', await clickByText('Yes, apply it'));
  console.log('approved:  ', await clickByText('Approve'));
  await page.reload({ waitUntil: 'networkidle2' });
  console.log('final:     ', await state());

  await browser.disconnect();
  chrome?.kill();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
