import assert from 'node:assert';
import test from 'node:test';
import { getMidnightISO, getFormattedToday, generateCommitSummary } from '../src/summarizer.js';
import { isSunday, formatTodayLabel, buildWorklogText } from '../src/submit.js';
import { config, DEFAULT_WORK_STATUS } from '../src/config.js';

test('isSunday correctly detects Sunday vs non-Sunday', () => {
  const sundayDate = new Date('2026-08-09T12:00:00Z');
  const mondayDate = new Date('2026-08-10T12:00:00Z');

  assert.strictEqual(isSunday('UTC', sundayDate), true);
  assert.strictEqual(isSunday('UTC', mondayDate), false);
});

test('isSunday handles invalid date objects gracefully', () => {
  assert.strictEqual(typeof isSunday('UTC', new Date('invalid')), 'boolean');
});

test('formatTodayLabel matches the Kalvium attendance date format', () => {
  assert.strictEqual(formatTodayLabel('Asia/Kolkata', new Date('2026-11-27T10:00:00Z')), '27 Nov 2026');
  assert.strictEqual(formatTodayLabel('Asia/Kolkata', new Date('2026-09-01T10:00:00Z')), '01 Sept 2026');
});

test('buildWorklogText includes tasks, challenges, and blockers', () => {
  const text = buildWorklogText({
    tasks: 'Built the daily worklog automation.',
    challenges: 'None major.',
    blockers: 'Waiting on review.',
  });

  assert.ok(text.includes('📋 Tasks completed today'));
  assert.ok(text.includes('• Built the daily worklog automation.'));
  assert.ok(text.includes('⚡ Challenges encountered and how you overcame them'));
  assert.ok(text.includes('• None major.'));
  assert.ok(text.includes("🚧 Blockers faced (challenges that you couldn't overcome)"));
  assert.ok(text.includes('• Waiting on review.'));
});

test('getFormattedToday formats YYYY-MM-DD correctly', () => {
  const date = new Date('2026-08-10T10:00:00Z');
  const formatted = getFormattedToday('UTC', date);
  assert.strictEqual(formatted, '2026-08-10');
});

test('getMidnightISO returns correct UTC ISO for target timezone midnight', () => {
  const refDate = new Date('2026-08-10T10:00:00Z');
  const iso = getMidnightISO('Asia/Kolkata', refDate);
  assert.strictEqual(iso, '2026-08-09T18:30:00.000Z');
});

test('getMidnightISO and getFormattedToday handle invalid dates and fallback timezones gracefully', () => {
  const iso = getMidnightISO('Invalid/Timezone', new Date('invalid'));
  assert.ok(typeof iso === 'string' && iso.endsWith('Z'));

  const formatted = getFormattedToday('Invalid/Timezone', new Date('invalid'));
  assert.match(formatted, /^\d{4}-\d{2}-\d{2}$/);
});

test('generateCommitSummary returns default summary text gracefully when offline or unconfigured', async () => {
  const summary = await generateCommitSummary({});
  assert.ok(typeof summary === 'string');
  assert.ok(summary.length > 10);
});

test('config exposes Kalvium target settings and a boolean dryRun', () => {
  assert.strictEqual(typeof config.dryRun, 'boolean');
  assert.ok(config.kalviumUrl.startsWith('https://'));
  assert.strictEqual(config.workStatus, DEFAULT_WORK_STATUS);
  assert.ok(config.worklogChallenges.length > 0);
  assert.ok(config.worklogBlockers.length > 0);
});
