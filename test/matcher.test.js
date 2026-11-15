'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../src/matcher');
const fixtures = require('./fixtures/companies.json').results;

const company = (id, name, domain, website, extra) => ({
  id: String(id),
  properties: Object.assign({ hs_object_id: String(id), name, domain: domain || '', website: website || '' }, extra || {}),
});

test('normalizeDomain strips protocol, www, port, path, query and credentials', () => {
  const cases = [
    ['https://www.Acme.example/about?x=1#top', 'acme.example', 'acme.example'],
    ['http://acme.example:8080/contact', 'acme.example', 'acme.example'],
    ['www2.acme.example', 'acme.example', 'acme.example'],
    ['//acme.example', 'acme.example', 'acme.example'],
    ['sales@acme.example', 'acme.example', 'acme.example'],
    ['ACME.EXAMPLE.', 'acme.example', 'acme.example'],
  ];
  for (const [input, host, root] of cases) {
    const d = m.normalizeDomain(input);
    assert.equal(d.host, host, input);
    assert.equal(d.root, root, input);
  }
});

test('normalizeDomain extracts the registrable root from sub-domains and multi-part TLDs', () => {
  assert.deepEqual(m.normalizeDomain('eu.shop.acme.example'), { host: 'eu.shop.acme.example', root: 'acme.example', label: 'acme', shared: false });
  assert.equal(m.normalizeDomain('www.globex.co.uk').root, 'globex.co.uk');
  assert.equal(m.normalizeDomain('globex.co.uk').label, 'globex');
  assert.equal(m.normalizeDomain('blog.initech.com.au').root, 'initech.com.au');
});

test('normalizeDomain flags shared mailbox and hosting domains and rejects junk', () => {
  assert.equal(m.normalizeDomain('gmail.com').shared, true);
  assert.equal(m.normalizeDomain('acme.example', ['acme.example']).shared, true);
  const platform = m.normalizeDomain('acme-fixture-0000.github.io');
  assert.equal(platform.root, 'acme-fixture-0000.github.io');
  assert.equal(platform.shared, false);
  for (const junk of [null, undefined, '', '   ', 'localhost', 'not a domain', 'http://', 'acme']) {
    assert.equal(m.normalizeDomain(junk), null, String(junk));
  }
});

test('normalizeName strips legal suffixes, punctuation, diacritics and leading "the"', () => {
  const cases = [
    ['Acme Corp', 'acme'],
    ['Acme Corporation', 'acme'],
    ['ACME, Inc.', 'acme'],
    ['The Acme Company, LLC', 'acme'],
    ['Globex Industries Ltd.', 'globex industries'],
    ['Globex GmbH', 'globex'],
    ['Initech Pty Ltd', 'initech'],
    ['Café Lumière S.A.R.L.', 'cafe lumiere'],
    ['Halverson & Co.', 'halverson'],
    ['Halverson and Company', 'halverson'],
    ["O'Malley Brothers Limited", 'omalley brothers'],
    ['Nordvik S.p.A.', 'nordvik'],
  ];
  for (const [input, expected] of cases) assert.equal(m.normalizeName(input), expected, input);
});

test('normalizeName never strips a name down to nothing', () => {
  assert.equal(m.normalizeName('The Company'), 'company');
  assert.equal(m.normalizeName('Inc'), 'inc');
  assert.equal(m.normalizeName(''), '');
  assert.equal(m.normalizeName(null), '');
});

test('jaroWinkler matches published reference values', () => {
  const close = (a, b) => assert.ok(Math.abs(a - b) < 0.001, a + ' vs ' + b);
  close(m.jaroWinkler('martha', 'marhta'), 0.9611);
  close(m.jaroWinkler('dwayne', 'duane'), 0.84);
  close(m.jaroWinkler('dixon', 'dicksonx'), 0.8133);
  assert.equal(m.jaroWinkler('acme', 'acme'), 1);
  assert.equal(m.jaroWinkler('', 'acme'), 0);
  assert.equal(m.jaroWinkler('abc', 'xyz'), 0);
});

test('levenshtein distance and ratio', () => {
  assert.equal(m.levenshtein('kitten', 'sitting'), 3);
  assert.equal(m.levenshtein('flaw', 'lawn'), 2);
  assert.equal(m.levenshtein('', 'abc'), 3);
  assert.equal(m.levenshteinRatio('globex', 'globex'), 1);
  assert.ok(Math.abs(m.levenshteinRatio('globex industries', 'globex industires') - (1 - 2 / 17)) < 1e-9);
  assert.equal(m.levenshteinRatio('', ''), 1);
});

test('compareRecords: same root domain via sub-domain is flagged', () => {
  const a = m.toRecord(company(1, 'Acme Corp', 'acme.example'));
  const b = m.toRecord(company(2, 'ACME, Inc.', 'eu.acme.example'));
  const r = m.compareRecords(a, b);
  assert.ok(r.score >= 0.95);
  assert.ok(r.reasons.includes('same-root-domain'));
  assert.ok(r.reasons.includes('subdomain-variant'));
});

test('compareRecords: typos in names are caught above the default threshold', () => {
  const a = m.toRecord(company(1, 'Globex Industries', 'globex.example'));
  const b = m.toRecord(company(2, 'Globex Industires Ltd', 'globex-industries.example'));
  const r = m.compareRecords(a, b);
  assert.ok(r.score >= 0.85, 'score ' + r.score);
  assert.ok(r.reasons.includes('name-similarity'));
  assert.ok(r.reasons.includes('domain-prefix'));
});

test('compareRecords: distinct companies sharing a word stay below the threshold', () => {
  const pairs = [
    [company(1, 'Brightwater Analytics', 'brightwater-analytics.example'), company(2, 'Brightwater Logistics', 'brightwater-logistics.example')],
    [company(3, 'Umbrella Holdings', 'umbrella.example'), company(4, 'Umbrella Health', 'umbrella-health.example')],
  ];
  for (const [x, y] of pairs) {
    const r = m.compareRecords(m.toRecord(x), m.toRecord(y));
    assert.ok(r.score < 0.85, x.properties.name + ' vs ' + y.properties.name + ' scored ' + r.score);
  }
});

test('compareRecords: shared mailbox domains are not treated as evidence', () => {
  const a = m.toRecord(company(1, 'Pixel Bakery', 'gmail.com'));
  const b = m.toRecord(company(2, 'Quill Studio', 'gmail.com'));
  const r = m.compareRecords(a, b);
  assert.equal(r.domainScore, null);
  assert.ok(r.score < 0.5);
});

test('compareRecords: very short names must match exactly', () => {
  const a = m.toRecord(company(1, 'ABC Ltd'));
  const b = m.toRecord(company(2, 'ABD Ltd'));
  assert.equal(m.compareRecords(a, b).score, 0);
});

test('findDuplicates on fixtures produces the expected consolidated review queue', () => {
  const { summary, clusters } = m.findDuplicates(fixtures, { threshold: 0.85 });
  assert.equal(summary.totalRecords, 20);
  assert.equal(summary.clusterCount, 6);
  const groups = clusters.map((c) => c.members.map((x) => x.id).sort().join(',')).sort();
  assert.deepEqual(groups, [
    '1001,1002,1003,1004',
    '2001,2002',
    '3001,3002',
    '5001,5002',
    '6001,6002',
    '8001,8002',
  ]);
  const flagged = new Set(clusters.flatMap((c) => c.members.map((x) => x.id)));
  for (const id of ['4001', '4002', '7001', '7002', '9001', '9002']) assert.ok(!flagged.has(id), id + ' should not be flagged');
});

test('findDuplicates picks a sensible suggested primary and stable cluster IDs', () => {
  const run1 = m.findDuplicates(fixtures);
  const run2 = m.findDuplicates(fixtures.slice().reverse());
  const acme = run1.clusters.find((c) => c.members.some((x) => x.id === '1001'));
  assert.equal(acme.suggestedPrimaryId, '1001'); // most deals
  assert.equal(acme.members[0].isSuggestedPrimary, true);
  const initech = run1.clusters.find((c) => c.members.some((x) => x.id === '3001'));
  assert.equal(initech.suggestedPrimaryId, '3002'); // tie on deals, higher revenue
  assert.deepEqual(run1.clusters.map((c) => c.clusterId), run2.clusters.map((c) => c.clusterId));
  assert.match(acme.clusterId, /^dup-[0-9a-f]{16}$/);
});

test('findDuplicates respects threshold, maxCompanies, duplicates IDs and oversized blocks', () => {
  assert.equal(m.findDuplicates(fixtures, { threshold: 0.999 }).summary.clusterCount, 4);
  const limited = m.findDuplicates(fixtures, { maxCompanies: 4 });
  assert.equal(limited.summary.totalRecords, 4);
  assert.equal(limited.summary.truncatedAtMaxCompanies, true);

  const dupIds = m.findDuplicates([company(1, 'Acme Corp', 'acme.example'), company(1, 'Acme Corp', 'acme.example')]);
  assert.equal(dupIds.summary.totalRecords, 1);
  assert.equal(dupIds.summary.skippedRecords, 1);

  const many = Array.from({ length: 6 }, (_, i) => company(100 + i, 'Acme Corp ' + i, 'acme.example'));
  const capped = m.findDuplicates(many, { maxBlockSize: 3 });
  assert.ok(capped.summary.oversizedBlocks.length >= 1);
  assert.equal(capped.summary.oversizedBlocks[0].keyType.length, 1); // no customer data in warnings
});

test('findDuplicates tolerates empty and malformed input', () => {
  assert.equal(m.findDuplicates([]).summary.clusterCount, 0);
  assert.equal(m.findDuplicates(null).summary.totalInput, 0);
  const r = m.findDuplicates([{}, { id: '5' }, { id: '6', properties: { name: '' } }]);
  assert.equal(r.summary.totalRecords, 0);
  assert.equal(r.summary.skippedRecords, 3);
});
