import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { generateCommitSummary } from './summarizer.js';

const PAGE_LOAD_TIMEOUT_MS = 45000;
const ELEMENT_TIMEOUT_MS = 15000;

/**
 * Checks if today is Sunday in the target timezone.
 */
export function isSunday(timezone = 'Asia/Kolkata', referenceDate = new Date()) {
  const refDate = referenceDate instanceof Date && !isNaN(referenceDate.getTime()) ? referenceDate : new Date();
  let tz = timezone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    tz = 'Asia/Kolkata';
  }

  const dayStr = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
  }).format(refDate);
  return dayStr === 'Sun';
}

/**
 * Formats today as the Kalvium attendance table does, e.g. "27 Nov 2026" / "01 Sept 2026".
 */
export function formatTodayLabel(timezone = 'Asia/Kolkata', referenceDate = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(referenceDate);
}

/**
 * Builds the plain-text body for the worklog rich-text editor.
 */
export function buildWorklogText({ tasks, challenges, blockers }) {
  return [
    '📋 Tasks completed today',
    `• ${tasks}`,
    '',
    '⚡ Challenges encountered and how you overcame them',
    `• ${challenges}`,
    '',
    "🚧 Blockers faced (challenges that you couldn't overcome)",
    `• ${blockers}`,
  ].join('\n');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function runScheduledSubmission() {
  console.log('=== Automated Kalvium Internship Worklog Submission ===\n');

  if (config.dryRun) {
    console.log('⚠️  [DRY RUN MODE ENABLED] Worklog submit is disabled (DRY_RUN / DISABLE_SUBMIT).\n');
  }

  if (isSunday(config.timezone)) {
    console.log(`[SKIP] Today is Sunday in ${config.timezone}. Skipping worklog submission as scheduled.`);
    process.exit(0);
  }

  const storagePath = path.resolve(config.storageStatePath);
  if (!fs.existsSync(storagePath)) {
    console.error(`❌ ERROR: Storage state file not found at '${storagePath}'.`);
    console.error('Please run "npm run login" locally to generate the session file.');
    process.exit(1);
  }

  const todayLabel = formatTodayLabel(config.timezone);

  console.log('Fetching commit summary for today...');
  const tasks = await generateCommitSummary({
    owner: config.githubOwner,
    repo: config.githubRepo,
    username: config.githubUsername,
    token: config.commitReadToken,
    timezone: config.timezone,
  });

  const worklogText = buildWorklogText({
    tasks,
    challenges: config.worklogChallenges,
    blockers: config.worklogBlockers,
  });

  console.log('\n--- Worklog content ---');
  console.log(worklogText);
  console.log('-----------------------\n');

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  } catch (err) {
    if (err.message.includes("Executable doesn't exist") || err.message.includes('npx playwright install')) {
      console.error('\n❌ ERROR: Playwright Chromium browser binary is missing.');
      console.error('Please run "npx playwright install chromium" to install browser binaries.\n');
      process.exit(1);
    }
    throw err;
  }

  try {
    const context = await browser.newContext({ storageState: storagePath });
    const page = await context.newPage();

    const screenshotsDir = path.resolve('screenshots');
    if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
    let screenshotIndex = 0;

    async function takeScreenshot(label) {
      screenshotIndex++;
      const filename = path.join(
        screenshotsDir,
        `page-${String(screenshotIndex).padStart(2, '0')}-${label}.png`
      );
      await page.screenshot({ path: filename, fullPage: true }).catch(() => {});
      console.log(`  📸 Screenshot: ${filename}`);
    }

    console.log(`Navigating to ${config.kalviumUrl} ...`);
    await page.goto(config.kalviumUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT_MS });

    await page
      .getByRole('heading', { name: /my worklogs/i })
      .waitFor({ timeout: PAGE_LOAD_TIMEOUT_MS })
      .catch(() => {
        throw new Error(
          `Not signed in or the internship page did not load (url: ${page.url()}). ` +
            'The saved session is probably expired — run "npm run login" and refresh the storage state secret.'
        );
      });

    // Give the worklog rows a moment to render after the page shell.
    await page.waitForTimeout(2500);

    const completeButtons = page.getByRole('button', { name: /^complete$/i });
    const pendingBefore = await completeButtons.count();

    if (pendingBefore === 0) {
      console.log(`No pending worklog found for ${todayLabel}. Nothing to do (already submitted?).`);
      await takeScreenshot('no-pending-worklog');
      await browser.close();
      process.exit(0);
    }

    // ponytail: assumes the first pending row is today. The date guard below fails loudly on a backlog.
    await completeButtons.first().click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ timeout: ELEMENT_TIMEOUT_MS });

    const dialogText = await dialog.innerText();
    if (!dialogText.includes(todayLabel)) {
      throw new Error(
        `Opened a worklog that is not for today (${todayLabel}). ` +
          `First pending entry looks like: "${dialogText.split('\n').slice(0, 3).join(' ')}". ` +
          'Clear older pending worklogs manually, then re-run.'
      );
    }

    await takeScreenshot('worklog-dialog');

    // 1. Work status (Radix select)
    await dialog.getByRole('combobox').click();
    const statusOption = page.getByRole('option', {
      name: new RegExp(escapeRegExp(config.workStatus), 'i'),
    });
    await statusOption.click();
    console.log(`  ✓ Selected work status: ${config.workStatus}`);

    // 2. Worklog rich-text editor (TipTap/ProseMirror contenteditable)
    const editor = dialog.locator('[contenteditable="true"]').first();
    await editor.waitFor({ timeout: ELEMENT_TIMEOUT_MS });
    await editor.click();
    try {
      await editor.fill(worklogText);
    } catch {
      // Fallback for editors that reject direct fill.
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.insertText(worklogText);
    }

    const filled = (await editor.innerText()).trim();
    if (!filled) {
      throw new Error('Worklog editor is still empty after filling.');
    }

    await takeScreenshot('worklog-filled');

    if (config.dryRun) {
      console.log('\n🔒 [DRY RUN] Dialog filled and validated. Submit skipped.');
      await browser.close();
      process.exit(0);
    }

    // 3. Submit
    await dialog.getByRole('button', { name: /^submit$/i }).click();
    await dialog.waitFor({ state: 'detached', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await takeScreenshot('after-submit');

    // 4. Verify: the pending worklog count must drop.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT_MS });
    await page.getByRole('heading', { name: /my worklogs/i }).waitFor({ timeout: PAGE_LOAD_TIMEOUT_MS });
    await page.waitForTimeout(2000);

    const pendingAfter = await page.getByRole('button', { name: /^complete$/i }).count();
    if (pendingAfter >= pendingBefore) {
      throw new Error(
        `Worklog still pending after submit (${pendingBefore} -> ${pendingAfter}). ` +
          'Check screenshots/after-submit.png and the browser log for a validation error.'
      );
    }

    console.log(`\n🎉 SUCCESS: worklog for ${todayLabel} submitted (pending ${pendingBefore} -> ${pendingAfter}).`);
    await browser.close();
    process.exit(0);
  } catch (error) {
    console.error('\n❌ SUBMISSION FAILED:', error.message);
    if (browser) {
      try {
        const pages = browser.contexts()?.[0]?.pages();
        if (pages && pages.length > 0) {
          const screenshotsDir = path.resolve('screenshots');
          if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
          await pages[0].screenshot({ path: path.join(screenshotsDir, 'error-state.png'), fullPage: true });
          console.error('  📸 Error screenshot saved: screenshots/error-state.png');
        }
      } catch {}
      await browser.close();
    }
    process.exit(1);
  }
}

if (process.argv[1] && (process.argv[1].endsWith('submit.js') || process.argv[1].includes('submit'))) {
  runScheduledSubmission();
}
