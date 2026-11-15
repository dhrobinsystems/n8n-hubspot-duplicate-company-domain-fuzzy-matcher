'use strict';
/**
 * config.js — loads .env (zero dependencies) and resolves runtime settings
 * through the same resolveConfig() that the n8n "Config & Safety Gate" uses.
 */

const fs = require('node:fs');
const path = require('node:path');
const { resolveConfig, CONFIG_ENV_KEYS } = require('./safety');

/** Minimal .env parser: KEY=value, optional quotes, # comments, `export` prefix. */
function parseDotEnv(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
      value = value.slice(1, value.lastIndexOf(quote));
      if (quote === '"') value = value.replace(/\\n/g, '\n');
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out[m[1]] = value;
  }
  return out;
}

/**
 * Merge a .env file into an env object. Real environment variables win, so
 * CI secrets are never overridden by a stray local file.
 */
function loadDotEnv(filePath, env) {
  const target = env || process.env;
  const file = filePath || path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(file)) return { loaded: false, file };
  const parsed = parseDotEnv(fs.readFileSync(file, 'utf8'));
  for (const [k, v] of Object.entries(parsed)) {
    if (target[k] === undefined) target[k] = v;
  }
  return { loaded: true, file };
}

/**
 * Build the CLI configuration.
 * @param {object} env      process.env-like object
 * @param {object} cliOpts  { dryRun, threshold, targets, inputFile }
 */
function loadConfig(env, cliOpts) {
  const e = env || process.env;
  const o = cliOpts || {};
  const picked = {};
  for (const k of CONFIG_ENV_KEYS) if (e[k] !== undefined) picked[k] = e[k];
  const offline = Boolean(o.inputFile);
  const resolved = resolveConfig(picked, {
    offline,
    forceDryRun: Boolean(o.dryRun) || offline,
    thresholdOverride: o.threshold,
    targetsOverride: o.targets,
  });
  return Object.assign({}, resolved.settings, {
    inputFile: o.inputFile || null,
    secrets: resolved.secrets,
    errors: resolved.errors,
  });
}

/** Secret values for log masking. */
function secretValues(config) {
  return Object.values((config && config.secrets) || {}).filter(Boolean);
}

module.exports = { parseDotEnv, loadDotEnv, loadConfig, secretValues };
