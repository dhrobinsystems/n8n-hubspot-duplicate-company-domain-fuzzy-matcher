#!/usr/bin/env node
'use strict';
/**
 * index.js — CLI mirror of the n8n workflow.
 *
 *   node src/index.js                       # uses .env (DRY_RUN / SANDBOX_MODE default to true)
 *   node src/index.js --dry-run             # force dry run regardless of env
 *   node src/index.js --input companies.json --output report.json --csv report.csv
 *
 * Exit codes: 0 ok · 1 runtime error · 2 config or safety-gate error · 3 duplicates found (--fail-on-duplicates)
 */

const fs = require('node:fs');
const path = require('node:path');
const { loadDotEnv, loadConfig, secretValues } = require('./config');
const { assertSandbox, maskError, maskSecrets } = require('./safety');
const { getAccountInfo, fetchAllCompanies } = require('./hubspot');
const { findDuplicates } = require('./matcher');
const { createRunMeta, buildSlackPayload, buildNotionPages, buildDryRunPreview, toCsv } = require('./formatters');
const { postSlack, upsertNotionPages } = require('./notifiers');

class SafetyError extends Error {
  constructor(message) { super(message); this.name = 'SafetyError'; }
}

const HELP = `n8n-hubspot-duplicate-company-domain-fuzzy-matcher (CLI mirror)

Usage: node src/index.js [options]

Options:
  --dry-run              Force DRY_RUN=true (never sends to Slack or Notion)
  --input <file>         Offline mode: read companies from a JSON file instead of HubSpot
                         (array of CRM v3 company objects, or { "results": [...] }). Always a dry run.
  --output <file>        Write the full JSON report (summary, clusters, payloads) to a file
  --csv <file>           Write the CSV review queue to a file
  --threshold <0-1>      Override SIMILARITY_THRESHOLD for this run
  --targets <list>       Override NOTIFY_TARGETS (slack,notion | slack | notion | none)
  --env-file <file>      Load variables from this file instead of ./.env
  --fail-on-duplicates   Exit with code 3 when any cluster is found (useful in CI)
  --quiet                Only print errors
  -h, --help             Show this help

Safety: DRY_RUN and SANDBOX_MODE default to true. They can only be turned off
through environment variables, never through a CLI flag.`;

function parseArgs(argv) {
  const out = { dryRun: false, quiet: false, failOnDuplicates: false, help: false };
  const needsValue = { '--input': 'inputFile', '--output': 'output', '--csv': 'csv', '--threshold': 'threshold', '--targets': 'targets', '--env-file': 'envFile' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--fail-on-duplicates') out.failOnDuplicates = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (needsValue[a]) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new SafetyError('Option ' + a + ' needs a value');
      out[needsValue[a]] = v;
    } else throw new SafetyError('Unknown option: ' + a + ' (see --help)');
  }
  return out;
}

function createLogger(config, quiet) {
  const secrets = secretValues(config);
  const write = (level, msg) => {
    if (quiet && level !== 'error') return;
    process.stderr.write('[' + new Date().toISOString() + '] ' + level.toUpperCase() + ' ' + maskSecrets(msg, secrets) + '\n');
  };
  return { info: (m) => write('info', m), warn: (m) => write('warn', m), error: (m) => write('error', m) };
}

function readCompaniesFile(file) {
  const data = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.results)) return data.results;
  throw new SafetyError('Input file must be a JSON array of companies or an object with a "results" array');
}

/**
 * Execute one audit run. Dependencies are injectable for tests.
 * @returns {Promise<{meta, result, slackPayload, notionPages, delivery}>}
 */
async function run(config, deps) {
  const d = deps || {};
  const fetchImpl = d.fetch || globalThis.fetch;
  const log = d.log || { info() {}, warn() {}, error() {} };
  const now = d.now || (() => new Date());
  const wait = d.wait;

  if (config.errors && config.errors.length) {
    throw new SafetyError('Configuration invalid: ' + config.errors.join('; '));
  }

  let raw;
  let portal = {};
  let source = 'hubspot';
  if (config.inputFile) {
    source = 'file';
    portal = { accountType: 'OFFLINE' };
    raw = readCompaniesFile(config.inputFile);
    log.info('Offline mode: loaded ' + raw.length + ' companies from file (dry run enforced).');
  } else {
    if (typeof fetchImpl !== 'function') throw new Error('No fetch implementation available (Node >= 18 required)');
    const ctx = { token: config.secrets.hubspotToken, apiBase: config.hubspotApiBase, fetchImpl, wait };
    const info = await getAccountInfo(ctx);
    portal = { portalId: info.portalId, accountType: info.accountType, uiDomain: info.uiDomain };
    try {
      const gate = assertSandbox(info, config.sandboxMode);
      log.info('Sandbox gate: ' + (gate.enforced ? 'passed (' + gate.accountType + ')' : 'not enforced (SANDBOX_MODE=false)'));
    } catch (err) {
      throw new SafetyError(err.message);
    }
    raw = await fetchAllCompanies(ctx, {
      maxCompanies: config.maxCompanies,
      requestIntervalMs: d.requestIntervalMs === undefined ? 120 : d.requestIntervalMs,
      onPage: ({ pages, fetched }) => { if (pages % 10 === 0) log.info('Fetched ' + fetched + ' companies (' + pages + ' pages)…'); },
    });
    log.info('Fetched ' + raw.length + ' companies from HubSpot.');
  }

  const result = findDuplicates(raw, {
    threshold: config.similarityThreshold,
    maxBlockSize: config.maxBlockSize,
    maxCompanies: config.maxCompanies,
  });
  const meta = createRunMeta({ settings: config, portal, source, runAt: now().toISOString() });
  log.info('Compared ' + result.summary.comparedPairs + ' candidate pairs; ' + result.summary.clusterCount + ' cluster(s) for review.');
  if (result.summary.oversizedBlocks.length) {
    log.warn(result.summary.oversizedBlocks.length + ' candidate block(s) exceeded MAX_BLOCK_SIZE and were skipped.');
  }

  const slackPayload = buildSlackPayload(result, meta);
  const notionPages = buildNotionPages(result, meta);
  const delivery = { slack: 'skipped', notion: 'skipped' };

  if (config.dryRun || config.inputFile) {
    log.info('DRY RUN: nothing sent to Slack or Notion.');
    delivery.slack = config.notifySlack ? 'dry-run' : 'disabled';
    delivery.notion = config.notifyNotion ? 'dry-run' : 'disabled';
  } else if (!result.clusters.length) {
    log.info('No duplicate clusters found; no notifications sent.');
    delivery.slack = delivery.notion = 'nothing-to-send';
  } else {
    if (config.notifySlack) {
      await postSlack(config.secrets.slackWebhookUrl, slackPayload, { fetchImpl });
      delivery.slack = 'sent';
      log.info('Slack summary posted.');
    } else delivery.slack = 'disabled';
    if (config.notifyNotion) {
      const r = await upsertNotionPages(notionPages, {
        fetchImpl, apiKey: config.secrets.notionApiKey, databaseId: config.secrets.notionDatabaseId, wait,
      });
      delivery.notion = r;
      log.info('Notion: ' + r.created + ' created, ' + r.skippedExisting + ' already queued, ' + r.failed + ' failed.');
      if (r.failed) throw new Error(r.failed + ' Notion page(s) failed: ' + r.errors.map((e) => e.message).join(' | '));
    } else delivery.notion = 'disabled';
  }

  return { meta, result, slackPayload, notionPages, delivery };
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(err.message + '\n');
    return 2;
  }
  if (args.help) { process.stdout.write(HELP + '\n'); return 0; }

  loadDotEnv(args.envFile ? path.resolve(args.envFile) : undefined);
  const config = loadConfig(process.env, args);
  const log = createLogger(config, args.quiet);

  try {
    log.info('Starting audit · DRY_RUN=' + config.dryRun + ' · SANDBOX_MODE=' + config.sandboxMode +
      ' · threshold=' + config.similarityThreshold + ' · targets=' + config.notifyTargets.join(','));
    const out = await run(config, { log });
    const report = config.dryRun || config.inputFile ? buildDryRunPreview(out.result, out.meta) : null;
    if (args.output) {
      fs.writeFileSync(path.resolve(args.output), JSON.stringify(Object.assign({}, report || {}, {
        meta: out.meta, summary: out.result.summary, clusters: out.result.clusters, delivery: out.delivery,
        slackPayload: out.slackPayload, notionPages: out.notionPages,
      }), null, 2));
      log.info('JSON report written to ' + args.output);
    }
    if (args.csv) {
      fs.writeFileSync(path.resolve(args.csv), toCsv(out.result));
      log.info('CSV written to ' + args.csv);
    }
    if (!args.quiet) {
      const s = out.result.summary;
      process.stdout.write(JSON.stringify({ summary: s, delivery: out.delivery, topClusters: out.result.clusters.slice(0, 5).map((c) => ({
        clusterId: c.clusterId, maxScore: c.maxScore, size: c.size, reasons: c.reasons,
        members: c.members.map((m) => m.id + ' · ' + m.name + (m.domain ? ' · ' + m.domain : '')),
      })) }, null, 2) + '\n');
    }
    if (args.failOnDuplicates && out.result.clusters.length) return 3;
    return 0;
  } catch (err) {
    const masked = maskError(err, secretValues(config));
    log.error(masked.name + ': ' + masked.message);
    return err instanceof SafetyError ? 2 : 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { run, main, parseArgs, SafetyError };
