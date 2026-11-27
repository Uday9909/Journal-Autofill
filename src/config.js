import dotenv from 'dotenv';
dotenv.config();

export const DEFAULT_KALVIUM_URL = 'https://kalvium.community/internships';
export const DEFAULT_WORK_STATUS = 'Working Remotely (Not in the Kalvium environment)';

export const DEFAULT_WORKLOG = {
  challenges:
    'Encountered minor technical issues during implementation/testing, which were resolved by debugging the code, referring to documentation, and trying alternate approaches.',
  blockers: 'No blockers faced today; all planned tasks proceeded as expected.',
};

const repoParts = process.env.GITHUB_REPOSITORY ? process.env.GITHUB_REPOSITORY.split('/') : [];

export const config = {
  githubOwner: process.env.GH_OWNER || process.env.GITHUB_OWNER || repoParts[0] || '',
  githubRepo: process.env.GH_REPO || process.env.GITHUB_REPO || repoParts[1] || '',
  githubUsername: process.env.GH_USERNAME || process.env.GITHUB_USERNAME || '',
  commitReadToken: process.env.COMMIT_READ_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '',

  kalviumUrl: (process.env.KALVIUM_URL || DEFAULT_KALVIUM_URL).trim(),
  workStatus: (process.env.WORK_STATUS || DEFAULT_WORK_STATUS).trim(),
  worklogChallenges: (process.env.WORKLOG_CHALLENGES || DEFAULT_WORKLOG.challenges).trim(),
  worklogBlockers: (process.env.WORKLOG_BLOCKERS || DEFAULT_WORKLOG.blockers).trim(),

  storageStatePath: process.env.STORAGE_STATE_PATH || 'storageState.json',
  timezone: process.env.TIMEZONE || 'Asia/Kolkata',

  dryRun:
    ['true', '1', 'yes'].includes(String(process.env.DRY_RUN || '').toLowerCase()) ||
    ['true', '1', 'yes'].includes(String(process.env.DISABLE_SUBMIT || '').toLowerCase()) ||
    process.argv.includes('--dry-run') ||
    process.argv.includes('--disable-submit'),
};
