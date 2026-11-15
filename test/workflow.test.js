'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { buildWorkflow, serialize, OUT, NODE_NAMES } = require('../scripts/build-workflow');
const { findDuplicates } = require('../src/matcher');
const { buildSlackPayload, buildNotionPages, createRunMeta } = require('../src/formatters');
const { resolveConfig } = require('../src/safety');
const fixtures = require('./fixtures/companies.json').results;

const workflow = JSON.parse(fs.readFileSync(OUT, 'utf8'));
const byName = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]));
const FAKE_TOKEN = 'mock-hubspot-credential-string';
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/** Execute an n8n Code node's jsCode with stubbed n8n globals. */
function runCodeNode(name, ctx) {
  const fn = new AsyncFunction('$env', '$input', '$', '$prevNode', byName[name].parameters.jsCode);
  return fn(ctx.env || {}, ctx.input || { all: () => [], first: () => ({ json: {} }) }, ctx.$ || (() => ({ first: () => ({ json: {} }) })), ctx.prevNode || { name: 'Test Node' });
}

test('committed workflow JSON is in sync with src/ (run npm run build:workflow)', () => {
  assert.equal(fs.readFileSync(OUT, 'utf8'), serialize(buildWorkflow()));
});

test('workflow structure: unique names, valid connections, required nodes', () => {
  const names = workflow.nodes.map((n) => n.name);
  assert.equal(new Set(names).size, names.length);
  for (const [from, conn] of Object.entries(workflow.connections)) {
    assert.ok(byName[from], 'unknown source ' + from);
    for (const output of conn.main) for (const c of output) assert.ok(byName[c.node], from + ' -> unknown ' + c.node);
  }
  const types = workflow.nodes.map((n) => n.type);
  for (const t of ['n8n-nodes-base.scheduleTrigger', 'n8n-nodes-base.manualTrigger', 'n8n-nodes-base.switch', 'n8n-nodes-base.httpRequest', 'n8n-nodes-base.code', 'n8n-nodes-base.stopAndError']) {
    assert.ok(types.includes(t), 'missing ' + t);
  }
  assert.equal(workflow.active, false);
  assert.equal(byName['HubSpot: Fetch Companies'].parameters.options.pagination.pagination.paginationCompleteWhen, 'other');
});

test('workflow never hard-codes secrets: all credentials come from $env', () => {
  const text = JSON.stringify(workflow);
  for (const key of ['HUBSPOT_ACCESS_TOKEN', 'SLACK_WEBHOOK_URL', 'NOTION_API_KEY', 'NOTION_DATABASE_ID']) {
    assert.ok(text.includes('$env.' + key), key + ' should be read from $env');
  }
  assert.ok(!/pat-[a-z0-9]{2,4}-[0-9a-f]{8}/i.test(text));
  assert.ok(!/hooks\.slack\.com\/services\/T/i.test(text));
  assert.ok(!/secret_[A-Za-z0-9]{16,}/.test(text));
});

test('every Code node compiles', () => {
  for (const n of workflow.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
    assert.doesNotThrow(() => new AsyncFunction('$env', '$input', '$', '$prevNode', n.parameters.jsCode), n.name);
  }
});

test('n8n gate node mirrors resolveConfig and keeps secrets out of item data', async () => {
  const env = { HUBSPOT_ACCESS_TOKEN: FAKE_TOKEN, SIMILARITY_THRESHOLD: '0.9' };
  const out = await runCodeNode(NODE_NAMES.GATE, { env });
  assert.deepEqual(out[0].json.config, resolveConfig(env).settings);
  assert.ok(!JSON.stringify(out).includes(env.HUBSPOT_ACCESS_TOKEN));
  assert.equal(out[0].json.config.dryRun, true);
  await assert.rejects(runCodeNode(NODE_NAMES.GATE, { env: {} }), /HUBSPOT_ACCESS_TOKEN/);
});

test('n8n sandbox node blocks non-sandbox portals', async () => {
  const config = resolveConfig({ HUBSPOT_ACCESS_TOKEN: FAKE_TOKEN }).settings;
  const $ = () => ({ first: () => ({ json: { config } }) });
  const input = (accountType) => ({ first: () => ({ json: { portalId: 1, accountType } }) });
  await assert.rejects(runCodeNode(NODE_NAMES.SANDBOX, { $, input: input('STANDARD') }), /Sandbox gate blocked/);
  const ok = await runCodeNode(NODE_NAMES.SANDBOX, { $, input: input('SANDBOX') });
  assert.equal(ok[0].json.portal.accountType, 'SANDBOX');
});

test('n8n fuzzy-match node returns exactly the CLI matcher result', async () => {
  const config = resolveConfig({ HUBSPOT_ACCESS_TOKEN: FAKE_TOKEN }).settings;
  const portal = { portalId: '12345678', accountType: 'SANDBOX', uiDomain: 'app.hubspot.com' };
  const pages = [fixtures.slice(0, 10), fixtures.slice(10)].map((results) => ({ json: { results } }));
  const $ = (name) => ({ first: () => ({ json: name === NODE_NAMES.GATE ? { config } : { portal } }) });
  const out = await runCodeNode(NODE_NAMES.MATCH, { $, input: { all: () => pages } });
  const expected = findDuplicates(fixtures, { threshold: config.similarityThreshold, maxBlockSize: config.maxBlockSize, maxCompanies: config.maxCompanies });
  assert.deepEqual(out[0].json.result, expected);
  assert.equal(out[0].json.meta.accountType, 'SANDBOX');
});

test('n8n Slack and Notion builder nodes return exactly the CLI payloads', async () => {
  const result = findDuplicates(fixtures);
  const meta = createRunMeta({ settings: { dryRun: false, sandboxMode: true }, portal: { portalId: '1', accountType: 'SANDBOX' }, runAt: '2026-01-05T07:00:00.000Z' });
  const $ = () => ({ first: () => ({ json: { result, meta } }) });
  const slack = await runCodeNode(NODE_NAMES.SLACK_BUILD, { $ });
  assert.deepEqual(slack[0].json.slackPayload, buildSlackPayload(result, meta));
  const notion = await runCodeNode(NODE_NAMES.NOTION_BUILD, { $ });
  assert.deepEqual(notion.map((i) => i.json), buildNotionPages(result, meta));
});

test('n8n error logger masks secrets from $env', async () => {
  const token = 'mock-hubspot-credential-for-logger';
  const out = await runCodeNode(NODE_NAMES.LOGGER, {
    env: { HUBSPOT_ACCESS_TOKEN: token },
    input: { all: () => [{ json: { error: { message: 'Request failed with token ' + token, httpCode: '401' } } }] },
    prevNode: { name: 'HubSpot: Fetch Companies' },
  });
  assert.equal(out[0].json.node, 'HubSpot: Fetch Companies');
  assert.equal(out[0].json.status, '401');
  assert.ok(!out[0].json.message.includes(token));
});
