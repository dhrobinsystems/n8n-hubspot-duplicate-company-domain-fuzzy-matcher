'use strict';
/**
 * safety.js — configuration resolution, sandbox gate and secret masking.
 *
 * PURE MODULE: no require(), no I/O. scripts/build-workflow.js inlines this
 * file verbatim into the n8n Code nodes ("Config & Safety Gate",
 * "Sandbox Verification", "Masked Error Logger") so the CLI and the workflow
 * enforce exactly the same rules.
 */

const ALLOWED_ACCOUNT_TYPES = ['SANDBOX', 'DEVELOPER_TEST'];
const NOTIFY_TARGET_VALUES = ['slack', 'notion', 'none'];
const SECRET_ENV_KEYS = ['HUBSPOT_ACCESS_TOKEN', 'SLACK_WEBHOOK_URL', 'NOTION_API_KEY', 'NOTION_DATABASE_ID'];
const CONFIG_ENV_KEYS = SECRET_ENV_KEYS.concat([
  'DRY_RUN',
  'SANDBOX_MODE',
  'SIMILARITY_THRESHOLD',
  'NOTIFY_TARGETS',
  'MAX_COMPANIES',
  'MAX_BLOCK_SIZE',
  'HUBSPOT_API_BASE',
]);

/**
 * Parse a boolean-ish env value. Anything that is not a recognised value
 * falls back to the default, so a typo such as DRY_RUN=flase stays SAFE.
 */
function parseBool(value, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  const v = String(value).trim().toLowerCase();
  if (v === '') return defaultValue;
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return defaultValue;
}

function parseNumber(value, defaultValue) {
  if (value === undefined || value === null || String(value).trim() === '') return defaultValue;
  const n = Number(String(value).trim());
  return Number.isFinite(n) ? n : NaN;
}

/** Placeholder values copied from .env.example are treated as "not set". */
function cleanSecret(value) {
  if (value === undefined || value === null) return '';
  const s = String(value).trim();
  if (/^YOUR_[A-Z0-9_]+$/.test(s)) return '';
  return s;
}

/**
 * Resolve the full runtime configuration from an env-like object.
 * Returns { settings, secrets, errors }. `settings` never contains secret
 * values, so it is safe to log or pass between n8n nodes.
 */
function resolveConfig(env, options) {
  const opts = options || {};
  const e = env || {};
  const secrets = {
    hubspotToken: cleanSecret(e.HUBSPOT_ACCESS_TOKEN),
    slackWebhookUrl: cleanSecret(e.SLACK_WEBHOOK_URL),
    notionApiKey: cleanSecret(e.NOTION_API_KEY),
    notionDatabaseId: cleanSecret(e.NOTION_DATABASE_ID),
  };

  const rawTargets = e.NOTIFY_TARGETS === undefined || e.NOTIFY_TARGETS === null || String(e.NOTIFY_TARGETS).trim() === ''
    ? 'slack'
    : String(e.NOTIFY_TARGETS);
  const targets = rawTargets.toLowerCase().split(/[\s,]+/).filter(Boolean);

  const settings = {
    dryRun: parseBool(e.DRY_RUN, true),
    sandboxMode: parseBool(e.SANDBOX_MODE, true),
    similarityThreshold: parseNumber(e.SIMILARITY_THRESHOLD, 0.85),
    notifySlack: targets.includes('slack'),
    notifyNotion: targets.includes('notion'),
    notifyTargets: targets,
    maxCompanies: parseNumber(e.MAX_COMPANIES, 50000),
    maxBlockSize: parseNumber(e.MAX_BLOCK_SIZE, 2000),
    hubspotApiBase: String(e.HUBSPOT_API_BASE || 'https://api.hubapi.com').trim().replace(/\/+$/, ''),
    secretsPresent: {
      hubspotToken: secrets.hubspotToken !== '',
      slackWebhookUrl: secrets.slackWebhookUrl !== '',
      notionApiKey: secrets.notionApiKey !== '',
      notionDatabaseId: secrets.notionDatabaseId !== '',
    },
  };

  if (opts.forceDryRun) settings.dryRun = true;
  if (opts.thresholdOverride !== undefined && opts.thresholdOverride !== null) {
    settings.similarityThreshold = parseNumber(opts.thresholdOverride, NaN);
  }
  if (opts.targetsOverride) {
    const t = String(opts.targetsOverride).toLowerCase().split(/[\s,]+/).filter(Boolean);
    settings.notifyTargets = t;
    settings.notifySlack = t.includes('slack');
    settings.notifyNotion = t.includes('notion');
  }

  const errors = [];
  const t = settings.similarityThreshold;
  if (!(t > 0 && t <= 1)) errors.push('SIMILARITY_THRESHOLD must be a number greater than 0 and at most 1');
  const unknown = settings.notifyTargets.filter((x) => !NOTIFY_TARGET_VALUES.includes(x));
  if (unknown.length) errors.push('NOTIFY_TARGETS contains unknown value(s): ' + unknown.join(', ') + ' (allowed: slack, notion, none)');
  if (!(Number.isInteger(settings.maxCompanies) && settings.maxCompanies > 0)) errors.push('MAX_COMPANIES must be a positive integer');
  if (!(Number.isInteger(settings.maxBlockSize) && settings.maxBlockSize >= 2)) errors.push('MAX_BLOCK_SIZE must be an integer of at least 2');
  if (!/^https:\/\//i.test(settings.hubspotApiBase)) errors.push('HUBSPOT_API_BASE must use https://');

  if (!opts.offline && !secrets.hubspotToken) {
    errors.push('HUBSPOT_ACCESS_TOKEN is not set (placeholder values count as unset)');
  }
  if (!settings.dryRun && settings.notifySlack) {
    if (!secrets.slackWebhookUrl) errors.push('SLACK_WEBHOOK_URL is required when DRY_RUN=false and NOTIFY_TARGETS includes slack');
    else if (!/^https:\/\//i.test(secrets.slackWebhookUrl)) errors.push('SLACK_WEBHOOK_URL must use https://');
  }
  if (!settings.dryRun && settings.notifyNotion) {
    if (!secrets.notionApiKey) errors.push('NOTION_API_KEY is required when DRY_RUN=false and NOTIFY_TARGETS includes notion');
    if (!secrets.notionDatabaseId) errors.push('NOTION_DATABASE_ID is required when DRY_RUN=false and NOTIFY_TARGETS includes notion');
  }

  return { settings, secrets, errors };
}

/**
 * Sandbox gate. When sandboxMode is on, the connected HubSpot portal must
 * report accountType SANDBOX or DEVELOPER_TEST (GET /account-info/v3/details).
 * Throws otherwise, which stops both the CLI and the n8n workflow.
 */
function assertSandbox(accountInfo, sandboxMode) {
  const accountType = String((accountInfo && accountInfo.accountType) || '').toUpperCase();
  if (!sandboxMode) {
    return { ok: true, enforced: false, accountType: accountType || 'UNKNOWN' };
  }
  if (ALLOWED_ACCOUNT_TYPES.includes(accountType)) {
    return { ok: true, enforced: true, accountType };
  }
  throw new Error(
    'Sandbox gate blocked this run: SANDBOX_MODE=true but the connected HubSpot portal reports accountType "' +
      (accountType || 'UNKNOWN') +
      '". Allowed: ' + ALLOWED_ACCOUNT_TYPES.join(', ') +
      '. Point the token at a sandbox or developer test account, or set SANDBOX_MODE=false deliberately.'
  );
}

const SECRET_PATTERNS = [
  [/Bearer\s+[A-Za-z0-9._~+\/=-]+/gi, 'Bearer ***'],
  [/\bpat-[a-z0-9]{2,4}-[A-Za-z0-9-]{8,}/gi, 'pat-***'],
  [/https:\/\/hooks\.slack\.com\/[^\s"'<>]+/gi, 'https://hooks.slack.com/***'],
  [/\b(?:secret|ntn)_[A-Za-z0-9]{16,}/g, '***notion-key***'],
  [/\b[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\b/gi, '***id***'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '***@***'],
];

/** Mask known secret values and secret-shaped strings (tokens, webhooks, emails). */
function maskSecrets(text, secretValues) {
  let s = text === undefined || text === null ? '' : String(text);
  const values = (secretValues || [])
    .filter((v) => typeof v === 'string' && v.length >= 6)
    .sort((a, b) => b.length - a.length);
  for (const v of values) s = s.split(v).join('***');
  for (const [re, replacement] of SECRET_PATTERNS) s = s.replace(re, replacement);
  return s;
}

/** Turn any error-like value into a small, masked, log-safe object. */
function maskError(errLike, secretValues) {
  let message;
  let status = null;
  let name = 'Error';
  if (errLike === undefined || errLike === null) message = 'Unknown error';
  else if (typeof errLike === 'string') message = errLike;
  else {
    name = errLike.name || name;
    status = errLike.httpCode || errLike.status || errLike.statusCode || null;
    message = errLike.message || errLike.description || '';
    if (!message) {
      try { message = JSON.stringify(errLike); } catch (_) { message = String(errLike); }
    }
  }
  const masked = maskSecrets(message, secretValues);
  return {
    name: String(name),
    status: status === null ? null : String(status),
    message: masked.length > 1000 ? masked.slice(0, 999) + '…' : masked,
  };
}

// @n8n-exclude-start
module.exports = {
  ALLOWED_ACCOUNT_TYPES,
  CONFIG_ENV_KEYS,
  SECRET_ENV_KEYS,
  parseBool,
  parseNumber,
  cleanSecret,
  resolveConfig,
  assertSandbox,
  maskSecrets,
  maskError,
};
// @n8n-exclude-end
