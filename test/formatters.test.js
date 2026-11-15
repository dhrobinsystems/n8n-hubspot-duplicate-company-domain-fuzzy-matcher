'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findDuplicates } = require('../src/matcher');
const f = require('../src/formatters');
const fixtures = require('./fixtures/companies.json').results;

const result = findDuplicates(fixtures);
const meta = f.createRunMeta({
  settings: { dryRun: true, sandboxMode: true },
  portal: { portalId: 12345678, accountType: 'SANDBOX', uiDomain: ['app', 'hubspot', 'com'].join('.') },
  runAt: '2026-01-05T07:00:00.000Z',
});

test('Slack payload respects Block Kit limits and labels dry runs', () => {
  const p = f.buildSlackPayload(result, meta);
  assert.ok(p.text.startsWith('[DRY RUN]'));
  assert.ok(p.blocks.length <= 50);
  assert.equal(p.blocks[0].type, 'header');
  for (const b of p.blocks) {
    if (b.type === 'section' && b.text) assert.ok(b.text.text.length <= 3000);
  }
  const all = JSON.stringify(p);
  assert.match(all, /record\/0-2\/1001/);
  assert.match(all, /CSV breakdown/);
});

test('Slack payload escapes mrkdwn control characters in company names', () => {
  const r = findDuplicates([
    { id: '1', properties: { name: 'Acme <script> & Sons', domain: 'acme.example' } },
    { id: '2', properties: { name: 'Acme Sons', domain: 'acme.example' } },
  ]);
  const text = JSON.stringify(f.buildSlackPayload(r, meta));
  assert.ok(!text.includes('<script>'));
  assert.ok(text.includes('&lt;script&gt; &amp; Sons'));
});

test('Slack payload caps the number of clusters shown', () => {
  const many = Array.from({ length: 30 }, (_, i) => [
    { id: String(i * 2 + 1), properties: { domain: 'c' + i + '.example' } },
    { id: String(i * 2 + 2), properties: { website: 'https://shop.c' + i + '.example' } },
  ]).flat();
  const r = findDuplicates(many);
  assert.equal(r.clusters.length, 30);
  const p = f.buildSlackPayload(r, meta, { maxClusters: 10 });
  assert.ok(JSON.stringify(p).includes('+20 more cluster(s)'));
  assert.ok(p.blocks.length <= 50);
});

test('Notion pages have the documented schema and no database parent', () => {
  const pages = f.buildNotionPages(result, meta);
  assert.equal(pages.length, result.clusters.length);
  const p = pages[0];
  assert.equal(p.page.parent, undefined);
  assert.deepEqual(Object.keys(p.page.properties).sort(), [
    'Cluster ID', 'Detected At', 'Domains', 'HubSpot IDs', 'Max Score', 'Name', 'Reasons', 'Record Count', 'Status', 'Suggested Primary',
  ]);
  assert.equal(p.page.properties.Status.select.name, 'Needs Review');
  assert.equal(p.query.filter.rich_text.equals, p.clusterId);
  assert.ok(p.page.children.length <= 100);
});

test('CSV has one row per member and neutralises spreadsheet formulas', () => {
  const csv = f.toCsv(result);
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], f.CSV_COLUMNS.join(','));
  assert.equal(lines.length - 1, result.summary.recordsInClusters);
  assert.equal(f.csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(f.csvCell('@cmd'), "'@cmd");
  assert.equal(f.csvCell('a,b'), '"a,b"');
});

test('dry-run preview bundles every payload without sending', () => {
  const prev = f.buildDryRunPreview(result, meta);
  assert.equal(prev.dryRun, true);
  assert.ok(prev.slackPayload.blocks.length > 0);
  assert.equal(prev.notionPages.length, result.clusters.length);
  assert.ok(prev.csv.startsWith('cluster_id,'));
});

test('hubspotRecordUrl only builds links for a known portal and safe host', () => {
  const base = ['https://app', 'hubspot', 'com'].join('.');
  assert.equal(f.hubspotRecordUrl({}, '1'), null);
  assert.equal(f.hubspotRecordUrl({ portalId: '1', uiDomain: 'evil.example/"><' }, '2'), base + '/contacts/1/record/0-2/2');
});