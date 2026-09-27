/**
 * Drives the Demo Industries call flow through the portal: run the check for a
 * week of absences, then answer the call as the employee would.
 *
 *   npm run dev            # in one terminal
 *   npx tsx scripts/demo-calls.ts
 */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const BASE = 'http://localhost:3000';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function main() {
  const running = await fetch('http://127.0.0.1:9222/json/version').then(() => true, () => false);
  const chrome = running
    ? null
    : spawn(CHROME, ['--headless=new', '--disable-gpu', '--remote-debugging-port=9222', `--user-data-dir=/tmp/tc-chrome-${Date.now()}`]);
  if (chrome) await new Promise((r) => setTimeout(r, 3000));

  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: { width: 1440, height: 1100 } });
  const page = await browser.newPage();

  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2' });
  if (await page.waitForSelector('#email', { timeout: 3000 }).then(() => true, () => false)) {
    await page.type('#email', 'admin@talentcarriage.test');
    await page.type('#password', 'attendance123');
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }), page.click('button[type="submit"]')]);
  }

  const clickByText = async (text: string) => {
    for (const handle of await page.$$('button')) {
      const label = (await handle.evaluate((el) => el.textContent?.trim())) ?? '';
      if (label.startsWith(text)) {
        await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}), handle.click()]);
        await new Promise((r) => setTimeout(r, 900));
        return label;
      }
    }
    return null;
  };

  // Switch to Demo Industries.
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
  await page.select('#tenantId', await page.evaluate(() => {
    const options = Array.from(document.querySelectorAll<HTMLOptionElement>('#tenantId option'));
    return options.find((o) => o.textContent?.includes('Demo Industries'))!.value;
  }));
  await clickByText('Switch');

  // Run the check for the week of absences.
  await page.goto(`${BASE}/?from=2026-09-21&to=2026-09-25`, { waitUntil: 'networkidle2' });
  console.log('run check:', await clickByText('Run check & send'));

  await page.goto(`${BASE}/cases?from=2026-09-21&to=2026-09-25&status=all`, { waitUntil: 'networkidle2' });
  const rows = await page.$$eval('table.data tbody tr', (trs) =>
    trs.map((tr) => Array.from(tr.querySelectorAll('td')).slice(0, 3).map((td) => td.textContent?.trim()).join(' | ')),
  );
  console.log('cases:\n ', rows.join('\n  '));
  await page.screenshot({ path: '/private/tmp/claude-502/shots/demo-cases.png' });

  // Answer the call placed for the newest date, the way the employee would.
  const links = await page.$$eval('a[href^="/cases/"]', (as) => as.map((a) => a.getAttribute('href')!));
  await page.goto(`${BASE}${links[0]}`, { waitUntil: 'networkidle2' });
  console.log('opened:', await page.$eval('.page-head p', (el) => el.textContent?.trim()));
  console.log('answered:', await clickByText('Press 1'));
  await page.screenshot({ path: '/private/tmp/claude-502/shots/demo-call.png' });
  console.log('after:', await page.$eval('.page-head p', (el) => el.textContent?.trim()));

  await browser.disconnect();
  chrome?.kill();
}

main().catch((e) => { console.error(e); process.exit(1); });
