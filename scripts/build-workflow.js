#!/usr/bin/env node
'use strict';
/**
 * Generates workflows/n8n-hubspot-duplicate-company-domain-fuzzy-matcher.json.
 *
 * The n8n Code nodes are built by inlining the pure modules in src/
 * (safety.js, matcher.js, formatters.js) so the workflow and the CLI run the
 * exact same logic. Edit src/, then run `npm run build:workflow`.
 * `npm run check:workflow` (and the test suite) fail if the JSON is stale.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'workflows', 'n8n-hubspot-duplicate-company-domain-fuzzy-matcher.json');
const WORKFLOW_NAME = 'HubSpot Duplicate Company Fuzzy Matcher (weekly audit)';

function pureSource(file) {
  const src = fs.readFileSync(path.join(ROOT, 'src', file), 'utf8');
  const stripped = src.replace(/\/\/ @n8n-exclude-start[\s\S]*?\/\/ @n8n-exclude-end\n?/g, '');
  if (/\brequire\s*\(\s*['"`]/.test(stripped)) throw new Error(file + ' must stay pure (no require) to be inlined into n8n');
  return '// ===== inlined from src/' + file + ' (generated — edit the source file, not this node) =====\n' +
    stripped.replace(/^'use strict';\n/, '').trim() + '\n';
}

function code(files, glue) {
  return files.map(pureSource).join('\n') + '\n// ===== n8n glue =====\n' + glue.trim() + '\n';
}

function uuidFor(name) {
  // Deterministic UUID-shaped node IDs so rebuilding produces identical JSON.
  const hex = [0x811c9dc5, 0x01000193, 0x2f2f2f2f, 0x5bd1e995].map((seed) => {
    let h = seed >>> 0;
    for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }).join('');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-4' + hex.slice(13, 16) + '-a' + hex.slice(17, 20) + '-' + hex.slice(20, 32);
}

const GATE = 'Config & Safety Gate';
const VERIFY = 'HubSpot: Verify Portal';
const SANDBOX = 'Sandbox Verification';
const FETCH = 'HubSpot: Fetch Companies';
const MATCH = 'Normalize & Fuzzy Match';
const ANY = 'Any Clusters?';
const NONE = 'No Duplicates Found';
const DRY = 'Dry Run?';
const PREVIEW = 'Dry Run Preview';
const ROUTE = 'Route Notifications';
const SLACK_BUILD = 'Build Slack Payload';
const SLACK_POST = 'Slack: Post Review Queue';
const NOTION_BUILD = 'Build Notion Pages';
const NOTION_FIND = 'Notion: Find Existing Entry';
const NEW_CLUSTER = 'New Cluster?';
const NOTION_CREATE = 'Notion: Create Review Entry';
const QUEUED = 'Already Queued';
const LOGGER = 'Masked Error Logger';
const STOP = 'Stop: Audit Failed';

const GLUE = {
  gate: `
const env = {};
for (const key of CONFIG_ENV_KEYS) {
  let value;
  try {
    value = $env[key];
  } catch (e) {
    throw new Error('This workflow reads its configuration from environment variables. Set N8N_BLOCK_ENV_ACCESS_IN_NODE=false on the n8n instance (see README).');
  }
  if (value !== undefined && value !== null) env[key] = String(value);
}
const { settings, errors } = resolveConfig(env);
if (errors.length) throw new Error('Configuration invalid: ' + errors.join('; '));
// Secrets are never placed in item data: HTTP nodes read them from $env directly.
return [{ json: { config: settings, startedAt: new Date().toISOString() } }];`,

  sandbox: `
const config = $('${GATE}').first().json.config;
const info = $input.first().json || {};
const gate = assertSandbox(info, config.sandboxMode);
return [{
  json: {
    config,
    portal: {
      portalId: info.portalId === undefined || info.portalId === null ? null : String(info.portalId),
      accountType: info.accountType || null,
      uiDomain: info.uiDomain || null,
    },
    sandboxGate: gate,
  },
}];`,

  match: `
const config = $('${GATE}').first().json.config;
const portal = $('${SANDBOX}').first().json.portal;
const companies = [];
for (const item of $input.all()) {
  const body = item.json || {};
  if (Array.isArray(body.results)) companies.push(...body.results);
  else if (body.id) companies.push(body);
}
const result = findDuplicates(companies, {
  threshold: config.similarityThreshold,
  maxBlockSize: config.maxBlockSize,
  maxCompanies: config.maxCompanies,
});
const meta = createRunMeta({ settings: config, portal, source: 'hubspot', runAt: new Date().toISOString() });
return [{ json: { config, meta, result } }];`,

  preview: `
const { result, meta } = $('${MATCH}').first().json;
return [{ json: buildDryRunPreview(result, meta) }];`,

  slack: `
const { result, meta } = $('${MATCH}').first().json;
return [{ json: { slackPayload: buildSlackPayload(result, meta) } }];`,

  notion: `
const { result, meta } = $('${MATCH}').first().json;
return buildNotionPages(result, meta).map((page) => ({ json: page }));`,

  logger: `
const secretValues = [];
for (const key of SECRET_ENV_KEYS) {
  try { const v = $env[key]; if (v) secretValues.push(String(v)); } catch (e) { /* env access blocked */ }
}
let source = 'unknown node';
try { source = $prevNode.name; } catch (e) { /* not available */ }
return $input.all().map((item) => {
  const j = item.json || {};
  const masked = maskError(j.error !== undefined ? j.error : j, secretValues);
  return { json: Object.assign({ level: 'error', node: source, at: new Date().toISOString() }, masked) };
});`,
};

function codeNode(name, position, files, glue, extra) {
  return Object.assign({
    parameters: { jsCode: code(files, glue) },
    id: uuidFor(name),
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position,
  }, extra || {});
}

function ifNode(name, position, leftValue, operator, rightValue) {
  const condition = { id: uuidFor(name + ':cond'), leftValue, operator };
  if (rightValue !== undefined) condition.rightValue = rightValue;
  return {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [condition],
        combinator: 'and',
      },
      options: {},
    },
    id: uuidFor(name),
    name,
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position,
  };
}

function header(name, value) {
  return { name, value };
}

const HUBSPOT_AUTH = [header('Authorization', '=Bearer {{ $env.HUBSPOT_ACCESS_TOKEN }}'), header('Accept', 'application/json')];
const NOTION_HEADERS = [header('Authorization', '=Bearer {{ $env.NOTION_API_KEY }}'), header('Notion-Version', '2022-06-28')];
const ERR = { onError: 'continueErrorOutput' };
const RETRY = { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 };

function buildWorkflow() {
  const nodes = [
    {
      parameters: {
        content: '## HubSpot duplicate company fuzzy matcher\n' +
          'Read-only weekly audit. Finds likely duplicate companies (legal suffixes, sub-domains, typos) and sends one consolidated review queue to Slack and/or Notion.\n\n' +
          '**Safe by default:** `DRY_RUN` and `SANDBOX_MODE` are true unless the env var is exactly `false`.\n\n' +
          '**Env vars:** HUBSPOT_ACCESS_TOKEN, SLACK_WEBHOOK_URL, NOTION_API_KEY, NOTION_DATABASE_ID, DRY_RUN, SANDBOX_MODE, SIMILARITY_THRESHOLD, NOTIFY_TARGETS, MAX_COMPANIES, MAX_BLOCK_SIZE.\n\n' +
          'Requires `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`. Code nodes are generated from `src/` — edit there and rebuild.',
        height: 300,
        width: 520,
      },
      id: uuidFor('Sticky: Overview'),
      name: 'Sticky: Overview',
      type: 'n8n-nodes-base.stickyNote',
      typeVersion: 1,
      position: [-40, -260],
    },
    {
      parameters: { rule: { interval: [{ field: 'weeks', weeksInterval: 1, triggerAtDay: [1], triggerAtHour: 7 }] } },
      id: uuidFor('Weekly Schedule'),
      name: 'Weekly Schedule',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [0, 200],
    },
    {
      parameters: {},
      id: uuidFor('Manual Trigger'),
      name: 'Manual Trigger',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [0, 400],
    },
    codeNode(GATE, [240, 300], ['safety.js'], GLUE.gate, ERR),
    Object.assign({
      parameters: {
        url: '={{ $json.config.hubspotApiBase }}/account-info/v3/details',
        sendHeaders: true,
        headerParameters: { parameters: HUBSPOT_AUTH },
        options: { timeout: 30000 },
      },
      id: uuidFor(VERIFY),
      name: VERIFY,
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [480, 300],
    }, ERR, RETRY),
    codeNode(SANDBOX, [720, 300], ['safety.js'], GLUE.sandbox, ERR),
    Object.assign({
      parameters: {
        url: '={{ $json.config.hubspotApiBase }}/crm/v3/objects/companies',
        sendQuery: true,
        queryParameters: {
          parameters: [
            header('limit', '100'),
            header('archived', 'false'),
            header('properties', 'name,domain,website,hs_object_id,createdate,num_associated_deals,annualrevenue'),
          ],
        },
        sendHeaders: true,
        headerParameters: { parameters: HUBSPOT_AUTH },
        options: {
          pagination: {
            pagination: {
              paginationMode: 'updateAParameterInEachRequest',
              parameters: { parameters: [{ type: 'qs', name: 'after', value: '={{ $response.body.paging?.next?.after }}' }] },
              paginationCompleteWhen: 'other',
              completeExpression: '={{ !$response.body.paging?.next?.after }}',
              limitPagesFetched: true,
              maxRequests: 500,
              requestInterval: 120,
            },
          },
          timeout: 30000,
        },
      },
      id: uuidFor(FETCH),
      name: FETCH,
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [960, 300],
    }, ERR, RETRY),
    codeNode(MATCH, [1200, 300], ['matcher.js', 'formatters.js'], GLUE.match, ERR),
    ifNode(ANY, [1440, 300], '={{ $json.result.clusters.length }}', { type: 'number', operation: 'gt' }, 0),
    { parameters: {}, id: uuidFor(NONE), name: NONE, type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [1680, 480] },
    ifNode(DRY, [1680, 200], '={{ $json.config.dryRun }}', { type: 'boolean', operation: 'true', singleValue: true }),
    codeNode(PREVIEW, [1920, 40], ['formatters.js'], GLUE.preview),
    {
      parameters: {
        rules: {
          values: [
            {
              conditions: {
                options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
                conditions: [{ id: uuidFor(ROUTE + ':slack'), leftValue: '={{ $json.config.notifySlack }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
                combinator: 'and',
              },
              renameOutput: true,
              outputKey: 'Slack',
            },
            {
              conditions: {
                options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
                conditions: [{ id: uuidFor(ROUTE + ':notion'), leftValue: '={{ $json.config.notifyNotion }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
                combinator: 'and',
              },
              renameOutput: true,
              outputKey: 'Notion',
            },
          ],
        },
        options: { allMatchingOutputs: true },
      },
      id: uuidFor(ROUTE),
      name: ROUTE,
      type: 'n8n-nodes-base.switch',
      typeVersion: 3.2,
      position: [1920, 280],
    },
    codeNode(SLACK_BUILD, [2160, 160], ['formatters.js'], GLUE.slack, ERR),
    Object.assign({
      parameters: {
        method: 'POST',
        url: '={{ $env.SLACK_WEBHOOK_URL }}',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.slackPayload) }}',
        options: { timeout: 30000 },
      },
      id: uuidFor(SLACK_POST),
      name: SLACK_POST,
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [2400, 160],
    }, ERR, RETRY),
    codeNode(NOTION_BUILD, [2160, 400], ['formatters.js'], GLUE.notion, ERR),
    Object.assign({
      parameters: {
        method: 'POST',
        url: '=https://api.notion.com/v1/databases/{{ $env.NOTION_DATABASE_ID }}/query',
        sendHeaders: true,
        headerParameters: { parameters: NOTION_HEADERS },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.query) }}',
        options: { batching: { batch: { batchSize: 1, batchInterval: 400 } }, timeout: 30000 },
      },
      id: uuidFor(NOTION_FIND),
      name: NOTION_FIND,
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [2400, 400],
    }, ERR, RETRY),
    ifNode(NEW_CLUSTER, [2640, 400], '={{ ($json.results || []).length }}', { type: 'number', operation: 'equals' }, 0),
    Object.assign({
      parameters: {
        method: 'POST',
        url: 'https://api.notion.com/v1/pages',
        sendHeaders: true,
        headerParameters: { parameters: NOTION_HEADERS },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: "={{ JSON.stringify(Object.assign({ parent: { database_id: $env.NOTION_DATABASE_ID } }, $('" + NOTION_BUILD + "').item.json.page)) }}",
        options: { batching: { batch: { batchSize: 1, batchInterval: 400 } }, timeout: 30000 },
      },
      id: uuidFor(NOTION_CREATE),
      name: NOTION_CREATE,
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [2880, 320],
    }, ERR, RETRY),
    { parameters: {}, id: uuidFor(QUEUED), name: QUEUED, type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [2880, 500] },
    codeNode(LOGGER, [1440, 720], ['safety.js'], GLUE.logger),
    {
      parameters: { errorMessage: "={{ 'Duplicate audit failed at ' + $json.node + ': ' + $json.message }}" },
      id: uuidFor(STOP),
      name: STOP,
      type: 'n8n-nodes-base.stopAndError',
      typeVersion: 1,
      position: [1680, 720],
    },
  ];

  const to = (node, index) => ({ node, type: 'main', index: index || 0 });
  const okAndError = (next) => ({ main: [[to(next)], [to(LOGGER)]] });

  const connections = {
    'Weekly Schedule': { main: [[to(GATE)]] },
    'Manual Trigger': { main: [[to(GATE)]] },
    [GATE]: okAndError(VERIFY),
    [VERIFY]: okAndError(SANDBOX),
    [SANDBOX]: okAndError(FETCH),
    [FETCH]: okAndError(MATCH),
    [MATCH]: okAndError(ANY),
    [ANY]: { main: [[to(DRY)], [to(NONE)]] },
    [DRY]: { main: [[to(PREVIEW)], [to(ROUTE)]] },
    [ROUTE]: { main: [[to(SLACK_BUILD)], [to(NOTION_BUILD)]] },
    [SLACK_BUILD]: okAndError(SLACK_POST),
    [SLACK_POST]: { main: [[], [to(LOGGER)]] },
    [NOTION_BUILD]: okAndError(NOTION_FIND),
    [NOTION_FIND]: okAndError(NEW_CLUSTER),
    [NEW_CLUSTER]: { main: [[to(NOTION_CREATE)], [to(QUEUED)]] },
    [NOTION_CREATE]: { main: [[], [to(LOGGER)]] },
    [LOGGER]: { main: [[to(STOP)]] },
  };

  return {
    name: WORKFLOW_NAME,
    nodes,
    connections,
    pinData: {},
    active: false,
    settings: { executionOrder: 'v1', saveManualExecutions: true, callerPolicy: 'workflowsFromSameOwner' },
    tags: [],
  };
}

function serialize(wf) {
  return JSON.stringify(wf, null, 2) + '\n';
}

if (require.main === module) {
  const json = serialize(buildWorkflow());
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (current !== json) {
      process.stderr.write('Workflow JSON is out of date. Run: npm run build:workflow\n');
      process.exit(1);
    }
    process.stdout.write('Workflow JSON is up to date.\n');
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, json);
    process.stdout.write('Wrote ' + path.relative(ROOT, OUT) + '\n');
  }
}

module.exports = { buildWorkflow, serialize, OUT, NODE_NAMES: { GATE, VERIFY, SANDBOX, FETCH, MATCH, PREVIEW, SLACK_BUILD, NOTION_BUILD, LOGGER } };
