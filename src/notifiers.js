'use strict';
/**
 * notifiers.js — delivers the review queue to Slack (incoming webhook) and
 * Notion (one page per cluster, skipping clusters already in the database).
 * Only called when DRY_RUN=false; the payloads come from formatters.js.
 */

const NOTION_VERSION = '2022-06-28';
const NOTION_API = 'https://api.notion.com/v1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postSlack(webhookUrl, payload, deps) {
  const { fetchImpl } = deps;
  const res = await fetchImpl(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch (_) { /* ignore */ }
    const err = new Error('Slack webhook returned ' + res.status + (body ? ': ' + body.slice(0, 200) : ''));
    err.status = res.status;
    throw err;
  }
  return { ok: true };
}

async function notionRequest(method, pathName, body, deps) {
  const { fetchImpl, apiKey, wait = sleep, retries = 3 } = deps;
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(NOTION_API + pathName, {
      method,
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const retryAfter = Number(res.headers && res.headers.get ? res.headers.get('retry-after') : NaN);
      await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
      continue;
    }
    let text = '';
    try { text = await res.text(); } catch (_) { /* ignore */ }
    const err = new Error('Notion API ' + res.status + ' on ' + method + ' ' + pathName.replace(/[0-9a-f-]{32,36}/gi, '***') + (text ? ': ' + text.slice(0, 200) : ''));
    err.status = res.status;
    throw err;
  }
}

/**
 * Create one Notion page per cluster unless a page with the same Cluster ID
 * already exists, so weekly runs never duplicate the review queue itself.
 */
async function upsertNotionPages(pages, deps) {
  const { databaseId, wait = sleep, intervalMs = 350 } = deps;
  const out = { created: 0, skippedExisting: 0, failed: 0, errors: [] };
  for (const p of pages) {
    try {
      const existing = await notionRequest('POST', '/databases/' + databaseId + '/query', p.query, deps);
      await wait(intervalMs);
      if (existing.results && existing.results.length) {
        out.skippedExisting++;
        continue;
      }
      await notionRequest('POST', '/pages', Object.assign({ parent: { database_id: databaseId } }, p.page), deps);
      out.created++;
      await wait(intervalMs);
    } catch (err) {
      out.failed++;
      out.errors.push({ clusterId: p.clusterId, message: err.message, status: err.status || null });
    }
  }
  return out;
}

module.exports = { NOTION_VERSION, postSlack, notionRequest, upsertNotionPages };
