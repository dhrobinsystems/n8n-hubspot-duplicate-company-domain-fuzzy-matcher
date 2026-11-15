'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../src/safety');
const { parseDotEnv, loadConfig } = require('../src/config');

const FAKE_TOKEN = 'mock-hubspot-credential-string';
// Built at runtime so no HubSpot-token-shaped string appears in source; used only to test pattern masking.
const TOKEN_SHAPED = ['pat', 'na1', 'mock0000-0000-0000-0000-000000000000'].join('-');

test('DRY_RUN and SANDBOX_MODE default to true and only an explicit false disables them', () => {
  const d = s.resolveConfig({}, { offline: true }).settings;
  assert.equal(d.dryRun, true);
  assert.equal(d.sandboxMode, true);
  for (const typo of ['flase', 'nope', 'FALSE ', '']) {
    const v = typo.trim().toLowerCase() === 'false' ? false : true;
    assert.equal(s.resolveConfig({ DRY_RUN: typo }, { offline: true }).settings.dryRun, v, JSON.stringify(typo));
  }
  const off = s.resolveConfig({ DRY_RUN: 'false', SANDBOX_MODE: 'false', HUBSPOT_ACCESS_TOKEN: FAKE_TOKEN, NOTIFY_TARGETS: 'none' }).settings;
  assert.equal(off.dryRun, false);
  assert.equal(off.sandboxMode, false);
});

test('resolveConfig never exposes secrets in settings', () => {
  const { settings, secrets } = s.resolveConfig({ HUBSPOT_ACCESS_TOKEN: FAKE_TOKEN });
  assert.equal(secrets.hubspotToken, FAKE_TOKEN);
  assert.ok(!JSON.stringify(settings).includes(FAKE_TOKEN));
  assert.equal(settings.secretsPresent.hubspotToken, true);
});

test('placeholder values from .env.example count as unset', () => {
  const { errors, settings } = s.resolveConfig({ HUBSPOT_ACCESS_TOKEN: 'YOUR_HUBSPOT_PRIVATE_APP_TOKEN' });
  assert.equal(settings.secretsPresent.hubspotToken, false);
  assert.ok(errors.some((e) => e.includes('HUBSPOT_ACCESS_TOKEN')));
});

test('live delivery requires the matching secrets; dry run does not', () => {
  const base = { HUBSPOT_ACCESS_TOKEN: FAKE_TOKEN, NOTIFY_TARGETS: 'slack,notion' };
  assert.deepEqual(s.resolveConfig(base).errors, []);
  const live = s.resolveConfig(Object.assign({ DRY_RUN: 'false' }, base)).errors.join(' ');
  assert.match(live, /SLACK_WEBHOOK_URL/);
  assert.match(live, /NOTION_API_KEY/);
  assert.match(live, /NOTION_DATABASE_ID/);
});

test('invalid threshold, targets and API base are rejected', () => {
  const errs = s.resolveConfig({
    HUBSPOT_ACCESS_TOKEN: FAKE_TOKEN, SIMILARITY_THRESHOLD: '1.5', NOTIFY_TARGETS: 'slack,email', HUBSPOT_API_BASE: 'http://insecure.example',
  }).errors.join(' ');
  assert.match(errs, /SIMILARITY_THRESHOLD/);
  assert.match(errs, /email/);
  assert.match(errs, /https/);
  assert.match(s.resolveConfig({ HUBSPOT_ACCESS_TOKEN: FAKE_TOKEN, SIMILARITY_THRESHOLD: 'abc' }).errors.join(' '), /SIMILARITY_THRESHOLD/);
});

test('sandbox gate allows SANDBOX and DEVELOPER_TEST and blocks everything else', () => {
  assert.equal(s.assertSandbox({ accountType: 'SANDBOX' }, true).ok, true);
  assert.equal(s.assertSandbox({ accountType: 'developer_test' }, true).ok, true);
  assert.throws(() => s.assertSandbox({ accountType: 'STANDARD' }, true), /Sandbox gate blocked/);
  assert.throws(() => s.assertSandbox({}, true), /UNKNOWN/);
  assert.throws(() => s.assertSandbox(null, true), /Sandbox gate blocked/);
  assert.deepEqual(s.assertSandbox({ accountType: 'STANDARD' }, false), { ok: true, enforced: false, accountType: 'STANDARD' });
});

test('maskSecrets removes known values and secret-shaped strings', () => {
  const text = 'token ' + FAKE_TOKEN + ' shaped ' + TOKEN_SHAPED + ' auth Bearer abc.def-123 hook https://hooks.slack.com/services/T000/B000/XXXX ' +
    'notion secret_0000000000000000000000000000 db 00000000000000000000000000000000 mail ops@acme.example custom-value-123';
  const out = s.maskSecrets(text, [FAKE_TOKEN, 'custom-value-123']);
  for (const leaked of [FAKE_TOKEN, TOKEN_SHAPED, 'abc.def-123', 'T000/B000', 'secret_0000', '0000000000000000', 'ops@acme.example', 'custom-value-123']) {
    assert.ok(!out.includes(leaked), 'leaked ' + leaked + ' in ' + out);
  }
});

test('maskError produces a small log-safe object from any error shape', () => {
  const e = new Error('401 for Bearer ' + FAKE_TOKEN);
  e.status = 401;
  const masked = s.maskError(e, [FAKE_TOKEN]);
  assert.equal(masked.status, '401');
  assert.ok(!masked.message.includes(FAKE_TOKEN));
  assert.equal(s.maskError('plain').message, 'plain');
  assert.equal(s.maskError(null).message, 'Unknown error');
  assert.ok(s.maskError({ message: 'x'.repeat(5000) }).message.length <= 1000);
});

test('parseDotEnv handles comments, quotes and export prefixes', () => {
  const parsed = parseDotEnv('# c\nexport DRY_RUN=false\nA="quoted # not comment"\nB=plain # trailing\nC=\'single\'\nbad line\n');
  assert.deepEqual(parsed, { DRY_RUN: 'false', A: 'quoted # not comment', B: 'plain', C: 'single' });
});

test('loadConfig: --dry-run and offline input always force a dry run', () => {
  const env = { DRY_RUN: 'false', HUBSPOT_ACCESS_TOKEN: FAKE_TOKEN, NOTIFY_TARGETS: 'none' };
  assert.equal(loadConfig(env, {}).dryRun, false);
  assert.equal(loadConfig(env, { dryRun: true }).dryRun, true);
  const offline = loadConfig({ DRY_RUN: 'false' }, { inputFile: 'x.json' });
  assert.equal(offline.dryRun, true);
  assert.deepEqual(offline.errors, []);
});
