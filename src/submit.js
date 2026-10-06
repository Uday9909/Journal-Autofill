import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { config, DEFAULT_ANSWERS } from './config.js';
import { generateCommitSummary } from './summarizer.js';
import { buildPrefilledUrl } from './urlBuilder.js';

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

async function runScheduledSubmission() {
  console.log('=== Automated Coursework Journal Submission ===\n');

  if (config.dryRun) {
    console.log('⚠️  [DRY RUN MODE ENABLED] Form submission is disabled via configuration (DRY_RUN / DISABLE_SUBMIT).\n');
  }

  // 1. Skip on Sundays
  if (isSunday(config.timezone)) {
    console.log(`[SKIP] Today is Sunday in ${config.timezone}. Skipping journal submission as scheduled.`);
    process.exit(0);
  }

  // 2. Validate session file existence
  const storagePath = path.resolve(config.storageStatePath);
  if (!fs.existsSync(storagePath)) {
    console.error(`❌ ERROR: Storage state file not found at '${storagePath}'.`);
    console.error('Please run "npm run login" locally to generate the session file.');
    process.exit(1);
  }

  // 3. Validate configuration
  if (!config.formId) {
    console.error('❌ ERROR: FORM_ID environment variable is missing.');
    process.exit(1);
  }

  // 4. Fetch Commit Activity & Generate Summary
  let journalSummaryText = '';
  if (config.githubOwner && config.githubRepo) {
    console.log(`Fetching commit summary for ${config.githubOwner}/${config.githubRepo}...`);
    journalSummaryText = await generateCommitSummary({
      owner: config.githubOwner,
      repo: config.githubRepo,
      username: config.githubUsername,
      token: config.commitReadToken,
      timezone: config.timezone,
    });
  } else {
    journalSummaryText = await generateCommitSummary({ timezone: config.timezone });
  }

  console.log('\n--- Generated Journal Entry ---');
  console.log(journalSummaryText);
  console.log('-------------------------------\n');

  // 5. Construct Pre-filled Form URL
  const prefilledUrl = buildPrefilledUrl({
    formId: config.formId,
    entryMap: config.entryMap,
    journalSummaryText,
  });

  console.log(`Navigating to pre-filled Google Form URL...`);

  // 6. Launch Headless Browser with Restored Session
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  } catch (err) {
    if (err.message.includes('Executable doesn\'t exist') || err.message.includes('npx playwright install')) {
      console.error('\n❌ ERROR: Playwright Chromium browser binary is missing.');
      console.error('Please run "npx playwright install chromium" to install browser binaries.\n');
      process.exit(1);
    }
    throw err;
  }

  try {
    const context = await browser.newContext({
      storageState: storagePath,
    });

    const page = await context.newPage();
    const response = await page.goto(prefilledUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    if (!response || response.status() >= 400) {
      throw new Error(`Failed to load Google Form. HTTP Status: ${response ? response.status() : 'Unknown'}`);
    }

    const currentUrl = page.url();

    // Check if redirected to Google Authentication page
    if (currentUrl.includes('accounts.google.com') || currentUrl.includes('ServiceLogin')) {
      throw new Error(
        'Authentication failed! redirected to Google sign-in page. Saved session in storageState.json is expired or invalid. Please run "npm run login" again to refresh session.'
      );
    }

    console.log('Page loaded. Processing form sections...');

    // Ensure screenshots directory exists
    const screenshotsDir = path.resolve('screenshots');
    if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
    let screenshotIndex = 0;

    async function takeScreenshot(label) {
      screenshotIndex++;
      const filename = path.join(screenshotsDir, `page-${String(screenshotIndex).padStart(2, '0')}-${label}.png`);
      await page.screenshot({ path: filename, fullPage: true }).catch(() => {});
      console.log(`  📸 Screenshot: ${filename}`);
    }

    // Helper: fill all required fields on the current page section
    async function fillCurrentPage(currentPageNum = pageCount) {
      // 0. Handle "Continue current draft?" dialog modal if present.
      // Google Forms renders this as role="alertdialog" with a "Use previous draft" button,
      // not role="dialog"/"Continue" — so match both roles and all known button labels.
      const draftDialog = page.locator('div[role="dialog"], div[role="alertdialog"]').first();
      if (await draftDialog.isVisible({ timeout: 1500 }).catch(() => false)) {
        console.log('  Dismissing "Continue current draft?" popup modal...');
        const resumeBtn = draftDialog
          .locator('div[role="button"], button')
          .filter({ hasText: /continue|restore|use previous draft|resume/i })
          .first();
        if (await resumeBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
          await resumeBtn.click({ force: true }).catch(() => {});
        } else {
          await draftDialog.locator('div[role="button"], button').first().click({ force: true }).catch(() => {});
        }
        await page.waitForTimeout(800);
      }

      // 1. Email consent checkbox
      const emailCheckboxes = page.locator('div[role="checkbox"], input[type="checkbox"]');
      const cbCount = await emailCheckboxes.count().catch(() => 0);
      for (let i = 0; i < cbCount; i++) {
        const cb = emailCheckboxes.nth(i);
        const ariaChecked = await cb.getAttribute('aria-checked').catch(() => 'false');
        const isChecked = ariaChecked === 'true' || (await cb.isChecked().catch(() => false));
        if (!isChecked) {
          const containerText = await cb
            .evaluate((el) => {
              const container = el.closest('[role="listitem"], .Qr7Oae, .M7eMe, label, form') || el.parentElement;
              return container ? (container.innerText || container.textContent || '').toLowerCase() : (el.innerText || el.textContent || '').toLowerCase();
            })
            .catch(() => '');

          if (containerText.includes('email') || containerText.includes('record')) {
            console.log('  Checking email consent checkbox...');
            await cb.click({ force: true }).catch(() => {});
            await page.waitForTimeout(300);
          }
        }
      }

      // 2. Working day radio option
      const workingDayRadio = page
        .locator('[role="radio"][aria-label*="present" i], [role="radio"][aria-label*="working" i], [role="radio"][data-value*="present" i], [role="radio"][data-value*="working" i]')
        .first();
      if (await workingDayRadio.isVisible({ timeout: 2000 }).catch(() => false)) {
        const selected = await workingDayRadio.getAttribute('aria-checked').catch(() => 'false');
        if (selected !== 'true') {
          console.log('  ✓ Selecting working day radio');
          await workingDayRadio.click({ force: true });
          await page.waitForTimeout(500);
        }
      }

      // 3. Fill empty text inputs / textareas with exact mapped entry response
      const textFields = page.locator(
        'textarea, input[type="text"]:not([readonly]), input[type="email"]:not([readonly]), input[type="url"]:not([readonly]), input:not([type]):not([readonly])'
      );
      const fieldCount = await textFields.count().catch(() => 0);

      for (let i = 0; i < fieldCount; i++) {
        const field = textFields.nth(i);
        if (await field.isVisible().catch(() => false)) {
          const currentVal = await field.inputValue().catch(() => '');
          if (!currentVal || currentVal.trim() === '') {
            // Inspect field attributes & parent question container text
            const fieldDetails = await field
              .evaluate((el) => {
                const box = el.closest('[role="listitem"], .Qr7Oae, .M7eMe, form') || el.parentElement;
                const name = el.getAttribute('name') || box?.getAttribute('data-params') || '';
                const heading = (
                  box?.querySelector('[role="heading"], .M7eMe, .hoL3id, label, legend, span')?.innerText ||
                  box?.innerText ||
                  ''
                ).toLowerCase();
                return { name, heading };
              })
              .catch(() => ({ name: '', heading: '' }));

            let targetEntryKey = '';
            const fieldName = fieldDetails.name;
            const heading = fieldDetails.heading;

            // Direct entry name / attribute parameter matching
            if (fieldName.includes('1874357572')) targetEntryKey = 'entry.1874357572';
            else if (fieldName.includes('199221807')) targetEntryKey = 'entry.199221807';
            else if (fieldName.includes('1546753981')) targetEntryKey = 'entry.1546753981';
            else if (fieldName.includes('32162408')) targetEntryKey = 'entry.32162408';

            // Heading title pattern matching if name attribute is non-specific
            if (!targetEntryKey && heading) {
              if ((heading.includes('challenge') || heading.includes('problem')) && (heading.includes('not') || heading.includes('carrying') || heading.includes('unable'))) {
                targetEntryKey = 'entry.199221807';
              } else if ((heading.includes('challenge') || heading.includes('problem')) && (heading.includes('solve') || heading.includes('did'))) {
                targetEntryKey = 'entry.1874357572';
              } else if (heading.includes('plan') || heading.includes('next day') || heading.includes('upcoming')) {
                targetEntryKey = 'entry.1546753981';
              } else if (heading.includes('task') || heading.includes('key') || heading.includes('work')) {
                targetEntryKey = 'entry.32162408';
              }
            }

            // Fallback matching by page number / field position
            if (!targetEntryKey) {
              if (currentPageNum === 2 || i === 0) targetEntryKey = 'entry.32162408';
              else if (currentPageNum === 3 && i === 0) targetEntryKey = 'entry.1874357572';
              else if (currentPageNum === 3 && i === 1) targetEntryKey = 'entry.199221807';
              else if (currentPageNum === 4) targetEntryKey = 'entry.1546753981';
              else targetEntryKey = 'entry.32162408';
            }

            // Resolve response string for targetEntryKey
            let answerToUse = '';
            if (typeof config.entryMap === 'object' && config.entryMap !== null && config.entryMap[targetEntryKey]) {
              answerToUse = config.entryMap[targetEntryKey];
            } else if (DEFAULT_ANSWERS[targetEntryKey]) {
              answerToUse = DEFAULT_ANSWERS[targetEntryKey];
            }

            // For Key Tasks (entry.32162408), append commit log / journal summary if available
            if (targetEntryKey === 'entry.32162408' && journalSummaryText && !answerToUse.includes('GitHub Commit Log')) {
              answerToUse = journalSummaryText;
            }

            if (!answerToUse) {
              answerToUse = journalSummaryText || 'Worked on assigned tasks as per daily plan.';
            }

            console.log(`  ✓ Filled [${targetEntryKey}] (Page ${currentPageNum}): "${answerToUse.substring(0, 45)}..."`);
            await field.fill(answerToUse).catch(() => {});
          }
        }
      }
    }

    // Fill page 1 fields on initial load
    let pageCount = 1;
    await fillCurrentPage(pageCount);
    await takeScreenshot('initial');

    // Loop through form pages (handles Multi-Page Forms with Next buttons)
    let maxPages = 15;
    
    while (maxPages > 0) {
      maxPages--;

      // Check if Submit button is visible
      const submitButton = page
        .getByRole('button', { name: /^submit$|^submit response$|^send$|^bhejein$/i })
        .or(page.locator('div[role="button"]:has-text("Submit")'))
        .or(page.locator('div[role="button"]:has-text("submit")'))
        .first();

      if (await submitButton.isVisible({ timeout: 2000 }).catch(() => false)) {
        await takeScreenshot(`p${pageCount}-submit-page`);
        
        if (config.dryRun) {
          console.log('\n🔒 [DRY RUN / FORM FILL DISABLED] Submit button located. Form was filled & validated successfully!');
          console.log('Skipping actual form submission as DRY_RUN / DISABLE_SUBMIT is enabled.\n');
          await browser.close();
          process.exit(0);
        }

        console.log('Submit button found. Submitting form response...');
        await submitButton.click();
        await page.waitForTimeout(3000);
        await takeScreenshot('after-submit');
        break;
      }

      // Check if Next button is visible
      const nextButton = page
        .getByRole('button', { name: /^next$/i })
        .or(page.locator('div[role="button"]:has-text("Next")'))
        .first();

      if (await nextButton.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log(`  → Clicking Next button (page ${pageCount})...`);
        
        // Take screenshot BEFORE clicking Next
        await takeScreenshot(`p${pageCount}-before-next`);

        // Wait for any overlay/tooltip to disappear
        await page.waitForTimeout(500);
        
        // Click Next with force to bypass pointer-events blockers
        await nextButton.click({ force: true });
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForTimeout(1000);

        pageCount++;
        
        // Fill any required fields on the new page
        await fillCurrentPage(pageCount);
      } else {
        break;
      }
    }

    if (config.dryRun) {
      await takeScreenshot('dryrun-final');
      console.log('\n🔒 [DRY RUN / FORM FILL DISABLED] Form process completed in Dry Run mode.');
      await browser.close();
      process.exit(0);
    }

    // 7. Verify Success Confirmation
    console.log('Waiting for confirmation text...');
    await page.waitForTimeout(2000);

    const confirmationTextLocator = page
      .getByText(/recorded|submitted|response has been recorded|thank you|your response/i)
      .or(page.locator('.freebirdFormviewerFunctioningresponseConfirmationText'))
      .first();

    const confirmed = await confirmationTextLocator.isVisible({ timeout: 15000 }).catch(() => false);

    if (confirmed) {
      await takeScreenshot('confirmation');
      console.log('\n🎉 SUCCESS: Journal entry successfully submitted to Google Form with verified email session!');
    } else {
      const finalUrl = page.url();
      if (finalUrl.includes('accounts.google.com')) {
        throw new Error('Session expired during submission. Please run "npm run login" again.');
      }
      await page.screenshot({ path: 'submit-result.png', fullPage: true });
      console.log('\n✅ Form submitted. Could not detect confirmation text — check submit-result.png to verify.');
    }
    await browser.close();
    process.exit(0);
  } catch (error) {
    console.error('\n❌ SUBMISSION FAILED:', error.message);
    if (browser) {
      // Try to grab a failure screenshot if page is still open
      try {
        const pages = browser.contexts()?.[0]?.pages();
        if (pages && pages.length > 0) {
          const screenshotsDir = path.resolve('screenshots');
          if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir);
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
