'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { run, parseArgs, SafetyError } = require('../src/index');
const { loadConfig } = require('../src/config');
const fixtures = require('./fixtures/companies.json').results;

const FAKE_TOKEN = 'mock-hubspot-credential-string';
const FAKE_SLACK = 'https://hooks.slack.com/services/TFAKE/BFAKE/0000000000';
const FAKE_NOTION_KEY = 'mock-notion-credential-string';
const FAKE_DB = '00000000000000000000000000000000';

function json(status, body) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
}

/** Fake HubSpot + Slack + Notion. Records every call for assertions. */
function fakeFetch(opts) {
  const o = Object.assign({ accountType: 'SANDBOX', existingClusterIds: [] }, opts || {});
  const calls = [];
  const pageSize = 7;
  const fn = async (url, init) => {
    const u = new URL(url);
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ host: u.host, path: u.pathname, method: (init && init.method) || 'GET', headers: (init && init.headers) || {}, body });
    if (u.pathname === '/account-info/v3/details') {
      return json(200, { portalId: 12345678, accountType: o.accountType, uiDomain: 'app.hubspot.com' });
    }
    if (u.pathname === '/crm/v3/objects/companies') {
      const start = Number(u.searchParams.get('after') || 0);
      const results = fixtures.slice(start, start + pageSize);
      const next = start + pageSize < fixtures.length ? { next: { after: String(start + pageSize) } } : undefined;
      return json(200, next ? { results, paging: next } : { results });
    }
    if (u.host === 'hooks.slack.com') return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}), text: async () => 'ok' };
    if (u.pathname.endsWith('/query')) {
      const id = body.filter.rich_text.equals;
      return json(200, { results: o.existingClusterIds.includes(id) ? [{ id: 'page' }] : [] });
    }
    if (u.pathname === '/v1/pages') return json(200, { id: 'new-page' });
    return json(404, { message: 'not mocked' });
  };
  fn.calls = calls;
  return fn;
}

const noWait = async () => {};
const deps = (fetch) => ({ fetch, wait: noWait, requestIntervalMs: 0, now: () => new Date('2026-01-05T07:00:00.000Z') });

test('dry run (default) reads HubSpot but sends nothing to Slack or Notion', async () => {
  const fetch = fakeFetch();
  const config = loadConfig({ HUBSPOT_ACCESS_TOKEN: FAKE_TOKEN, NOTIFY_TARGETS: 'slack,notion' });
  assert.equal(config.dryRun, true);
  const out = await run(config, deps(fetch));
  assert.equal(out.result.summary.clusterCount, 6);
  assert.deepEqual(out.delivery, { slack: 'dry-run', notion: 'dry-run' });
  assert.ok(fetch.calls.every((c) => c.host === 'api.hubapi.com'), 'only HubSpot reads expected');
  assert.ok(fetch.calls.every((c) => c.method === 'GET'), 'HubSpot is never written to');
  assert.equal(fetch.calls.filter((c) => c.path === '/crm/v3/objects/companies').length, 3); // paginated
});

test('sandbox gate stops the run before any company data is read', async () => {
  const fetch = fakeFetch({ accountType: 'STANDARD' });
  const config = loadConfig({ HUBSPOT_ACCESS_TOKEN: FAKE_TOKEN });
  await assert.rejects(run(config, deps(fetch)), (err) => err instanceof SafetyError && /Sandbox gate blocked/.test(err.message));
  assert.deepEqual(fetch.calls.map((c) => c.path), ['/account-info/v3/details']);
});

test('SANDBOX_MODE=false explicitly allows a standard portal', async () => {
  const fetch = fakeFetch({ accountType: 'STANDARD' });
  const out = await run(loadConfig({ HUBSPOT_ACCESS_TOKEN: FAKE_TOKEN, SANDBOX_MODE: 'false' }), deps(fetch));
  assert.equal(out.meta.accountType, 'STANDARD');
  assert.equal(out.meta.sandboxMode, false);
});

test('invalid configuration is rejected before any network call', async () => {
  const fetch = fakeFetch();
  await assert.rejects(run(loadConfig({}), deps(fetch)), /HUBSPOT_ACCESS_TOKEN/);
  assert.equal(fetch.calls.length, 0);
});

test('live mode posts one Slack message and creates only new Notion entries', async () => {
  const fetch = fakeFetch({ existingClusterIds: [] });
  const env = {
    HUBSPOT_ACCESS_TOKEN: FAKE_TOKEN, DRY_RUN: 'false', NOTIFY_TARGETS: 'slack,notion',
    SLACK_WEBHOOK_URL: FAKE_SLACK, NOTION_API_KEY: FAKE_NOTION_KEY, NOTION_DATABASE_ID: FAKE_DB,
  };
  const first = await run(loadConfig(env), deps(fetch));
  assert.equal(first.delivery.slack, 'sent');
  assert.equal(first.delivery.notion.created, 6);
  const slackCalls = fetch.calls.filter((c) => c.host === 'hooks.slack.com');
  assert.equal(slackCalls.length, 1);
  assert.ok(Array.isArray(slackCalls[0].body.blocks));
  const created = fetch.calls.filter((c) => c.path === '/v1/pages');
  assert.equal(created[0].body.parent.database_id, FAKE_DB);
  assert.equal(created[0].headers['Notion-Version'], '2022-06-28');

  const ids = first.result.clusters.map((c) => c.clusterId);
  const fetch2 = fakeFetch({ existingClusterIds: ids.slice(0, 4) });
  const second = await run(loadConfig(env), deps(fetch2));
  assert.equal(second.delivery.notion.created, 2);
  assert.equal(second.delivery.notion.skippedExisting, 4);
});

test('offline --input mode never touches the network', async () => {
  const fetch = fakeFetch();
  const config = loadConfig({ DRY_RUN: 'false' }, { inputFile: path.join(__dirname, 'fixtures', 'companies.json') });
  const out = await run(config, deps(fetch));
  assert.equal(fetch.calls.length, 0);
  assert.equal(out.meta.source, 'file');
  assert.equal(out.result.summary.clusterCount, 6);
});

test('HubSpot errors surface without leaking the token', async () => {
  const fetch = async () => ({ ok: false, status: 401, headers: { get: () => null }, text: async () => 'bad token ' + FAKE_TOKEN, json: async () => ({}) });
  const config = loadConfig({ HUBSPOT_ACCESS_TOKEN: FAKE_TOKEN });
  await assert.rejects(run(config, deps(fetch)), (err) => /401/.test(err.message) && !err.message.includes(FAKE_TOKEN));
});

test('parseArgs accepts known flags and rejects unknown ones', () => {
  assert.deepEqual(parseArgs(['--dry-run', '--threshold', '0.9', '--csv', 'x.csv']), {
    dryRun: true, quiet: false, failOnDuplicates: false, help: false, threshold: '0.9', csv: 'x.csv',
  });
  assert.throws(() => parseArgs(['--live']), /Unknown option/);
  assert.throws(() => parseArgs(['--input']), /needs a value/);
});