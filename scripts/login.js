import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { config } from '../src/config.js';

const LOGIN_TIMEOUT_MS = 300000;

async function runInteractiveLogin() {
  const loginUrl = process.env.KALVIUM_LOGIN_URL || 'https://app.kalvium.community';

  console.log('=== Kalvium Internship Worklog - One-Time Interactive Login ===\n');
  console.log(`Navigating to: ${loginUrl}\n`);

  let browser;
  try {
    browser = await chromium.launch({
      headless: false,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  } catch (err) {
    if (err.message.includes("Executable doesn't exist") || err.message.includes('npx playwright install')) {
      console.error('\n❌ ERROR: Playwright Chromium browser binary is missing on this machine.');
      console.error('Please run the following command to download Chromium:\n');
      console.error('    npx playwright install chromium\n');
      process.exit(1);
    }
    throw err;
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(loginUrl);

  console.log('----------------------------------------------------------------------');
  console.log('ACTION REQUIRED:');
  console.log('1. In the browser window, click "Login with Google" and sign in.');
  console.log('2. This script continues automatically once the dashboard loads.');
  console.log('----------------------------------------------------------------------\n');

  await page.waitForURL(/app\.kalvium\.community\/(dashboard|internships)/, {
    timeout: LOGIN_TIMEOUT_MS,
  });
  console.log('✅ Signed in. Verifying the internship page...');

  await page.goto(config.kalviumUrl);
  const onPage = await page
    .getByRole('heading', { name: /my worklogs/i })
    .waitFor({ timeout: 30000 })
    .then(() => true)
    .catch(() => false);

  if (!onPage) {
    console.warn('⚠️  Could not find the "My Worklogs" section. Saving the session anyway — verify with a dry run.');
  }

  const storagePath = path.resolve(config.storageStatePath || 'storageState.json');
  const storageDir = path.dirname(storagePath);
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }
  await context.storageState({ path: storagePath });

  console.log(`\n✅ Session storage state successfully saved to: ${storagePath}`);

  await browser.close();

  console.log('\n============================== IMPORTANT ==============================');
  console.log('1. DO NOT commit storageState.json to git or source control!');
  console.log('2. DO NOT execute this interactive login script inside CI / GitHub Actions.');
  console.log('3. Encode storageState.json to base64 and store it as a GitHub secret:');
  console.log('   STORAGE_STATE_BASE64');
  console.log('=======================================================================\n');
}

runInteractiveLogin().catch((err) => {
  console.error('\n❌ Login script error:', err.message || err);
  process.exit(1);
});
