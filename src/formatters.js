'use strict';
/**
 * formatters.js — turns a matcher result into the review-queue outputs:
 * Slack Block Kit payload, Notion page bodies and a CSV breakdown.
 *
 * PURE MODULE: no require(), no I/O, no secrets. Inlined verbatim into the
 * n8n Code nodes "Build Slack Payload", "Build Notion Pages" and
 * "Dry Run Preview" by scripts/build-workflow.js.
 */

const NOTION_STATUS_DEFAULT = 'Needs Review';

function createRunMeta(input) {
  const i = input || {};
  const portal = i.portal || {};
  const settings = i.settings || {};
  return {
    runAt: i.runAt || new Date().toISOString(),
    source: i.source || 'hubspot',
    dryRun: settings.dryRun !== false,
    sandboxMode: settings.sandboxMode !== false,
    accountType: portal.accountType || null,
    portalId: portal.portalId === undefined || portal.portalId === null ? null : String(portal.portalId),
    uiDomain: portal.uiDomain || null,
  };
}

function truncate(s, n) {
  const str = s === undefined || s === null ? '' : String(s);
  return str.length <= n ? str : str.slice(0, Math.max(0, n - 1)) + '…';
}

function escapeMrkdwn(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function hubspotRecordUrl(meta, id) {
  if (!meta || !meta.portalId || !id) return null;
  const host = /^[a-z0-9.-]+$/i.test(meta.uiDomain || '') ? meta.uiDomain : 'app.hubspot.com';
  return 'https://' + host + '/contacts/' + encodeURIComponent(meta.portalId) + '/record/0-2/' + encodeURIComponent(id);
}

/** CSV cell with quoting and spreadsheet formula-injection protection. */
function csvCell(v) {
  let s = v === undefined || v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

const CSV_COLUMNS = [
  'cluster_id', 'cluster_max_score', 'cluster_size', 'record_id', 'name', 'domain', 'website',
  'root_domain', 'suggested_primary', 'num_associated_deals', 'annual_revenue', 'createdate', 'reasons',
];

function toCsv(result) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const c of (result && result.clusters) || []) {
    for (const m of c.members) {
      lines.push([
        c.clusterId, c.maxScore, c.size, m.id, m.name, m.domain, m.website, m.rootDomain,
        m.isSuggestedPrimary ? 'yes' : 'no', m.numAssociatedDeals, m.annualRevenue, m.createdate,
        c.reasons.join('|'),
      ].map(csvCell).join(','));
    }
  }
  return lines.join('\n') + '\n';
}

function clusterTitle(c) {
  const primary = c.members.find((m) => m.isSuggestedPrimary) || c.members[0];
  const label = primary.name || primary.domain || primary.website || ('Company ' + primary.id);
  return label + ' (+' + (c.size - 1) + ' similar)';
}

/**
 * Slack incoming-webhook payload (Block Kit). Stays inside Slack limits:
 * <= 50 blocks, <= 3000 chars per section, header <= 150 chars.
 */
function buildSlackPayload(result, meta, options) {
  const o = options || {};
  const maxClusters = o.maxClusters || 10;
  const maxMembers = o.maxMembersPerCluster || 8;
  const csvLimit = o.csvCharLimit || 2400;
  const s = result.summary;
  const m = meta || {};
  const title = (m.dryRun ? '[DRY RUN] ' : '') + 'HubSpot duplicate company review queue';

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: truncate(title, 150), emoji: true } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: '*Clusters to review:*\n' + s.clusterCount },
        { type: 'mrkdwn', text: '*Records involved:*\n' + s.recordsInClusters },
        { type: 'mrkdwn', text: '*Companies scanned:*\n' + s.totalRecords },
        { type: 'mrkdwn', text: '*Similarity threshold:*\n' + s.threshold },
      ],
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: escapeMrkdwn('Portal type: ' + (m.accountType || 'unknown') + ' · Run: ' + (m.runAt || '') +
          ' · Pairs compared: ' + s.comparedPairs + ' · Flagged pairs: ' + s.flaggedPairs),
      }],
    },
    { type: 'divider' },
  ];

  const shown = result.clusters.slice(0, maxClusters);
  shown.forEach((c, idx) => {
    const lines = ['*' + (idx + 1) + '. ' + escapeMrkdwn(clusterTitle(c)) + '* — max score ' + c.maxScore.toFixed(2) + ' · ' + c.size + ' records'];
    c.members.slice(0, maxMembers).forEach((mem) => {
      const url = hubspotRecordUrl(m, mem.id);
      const idText = url ? '<' + url + '|ID ' + escapeMrkdwn(mem.id) + '>' : 'ID ' + escapeMrkdwn(mem.id);
      const dom = mem.domain || mem.website;
      lines.push('• ' + escapeMrkdwn(mem.name || '(no name)') + (dom ? ' (' + escapeMrkdwn(dom) + ')' : '') +
        ' — ' + idText + ' · deals: ' + (mem.numAssociatedDeals || 0) + (mem.isSuggestedPrimary ? ' · :star: suggested primary' : ''));
    });
    if (c.members.length > maxMembers) lines.push('_…and ' + (c.members.length - maxMembers) + ' more_');
    lines.push('_Reasons:_ ' + escapeMrkdwn(c.reasons.join(', ')) + ' · _Cluster:_ `' + c.clusterId + '`');
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: truncate(lines.join('\n'), 2900) } });
  });

  if (result.clusters.length > shown.length) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '+' + (result.clusters.length - shown.length) + ' more cluster(s) in the full report.' }] });
  }
  if (s.oversizedBlocks && s.oversizedBlocks.length) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: ':warning: ' + s.oversizedBlocks.length + ' candidate block(s) exceeded MAX_BLOCK_SIZE and were skipped.' }] });
  }

  if (result.clusters.length) {
    const csv = toCsv(result);
    let snippet = csv;
    let note = '';
    if (csv.length > csvLimit) {
      snippet = csv.slice(0, csvLimit);
      snippet = snippet.slice(0, snippet.lastIndexOf('\n') + 1);
      note = ' (truncated — run the CLI with --csv for the full file)';
    }
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*CSV breakdown*' + note + '\n```' + escapeMrkdwn(snippet) + '```' } });
  }

  return {
    text: title + ': ' + s.clusterCount + ' cluster(s), ' + s.recordsInClusters + ' record(s) to review.',
    blocks: blocks.slice(0, 50),
  };
}

function richText(content, url) {
  const text = { content: truncate(content, 2000) };
  if (url) text.link = { url };
  return [{ type: 'text', text }];
}

/**
 * Notion pages for the review-queue database. The database parent is
 * deliberately NOT included: the sender adds it from NOTION_DATABASE_ID at
 * send time, so the ID never appears in workflow item data or reports.
 */
function buildNotionPages(result, meta) {
  const m = meta || {};
  return result.clusters.map((c) => {
    const primary = c.members.find((x) => x.isSuggestedPrimary) || c.members[0];
    const domains = [];
    for (const mem of c.members) {
      const d = mem.rootDomain || mem.domain;
      if (d && domains.indexOf(d) === -1) domains.push(d);
    }
    const children = [
      { object: 'block', type: 'heading_3', heading_3: { rich_text: richText('Records') } },
    ];
    for (const mem of c.members.slice(0, 40)) {
      const label = (mem.name || '(no name)') + ' — ID ' + mem.id +
        (mem.domain || mem.website ? ' — ' + (mem.domain || mem.website) : '') +
        ' — deals: ' + (mem.numAssociatedDeals || 0) + (mem.isSuggestedPrimary ? ' — suggested primary' : '');
      children.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: richText(label, hubspotRecordUrl(m, mem.id)) } });
    }
    children.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: richText('Matched pairs') } });
    for (const p of c.pairs.slice(0, 50)) {
      const detail = p.a + ' ↔ ' + p.b + ': score ' + p.score +
        (p.nameScore !== null ? ' · name JW ' + p.nameJaroWinkler + ' / Lev ' + p.nameLevenshtein : '') +
        (p.domainScore !== null ? ' · domain ' + p.domainScore : '') +
        ' · ' + p.reasons.join(', ');
      children.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: richText(detail) } });
    }
    children.push({
      object: 'block', type: 'paragraph',
      paragraph: { rich_text: richText('Generated by n8n-hubspot-duplicate-company-domain-fuzzy-matcher. Review before merging in HubSpot; merges cannot be undone.') },
    });

    return {
      clusterId: c.clusterId,
      query: { filter: { property: 'Cluster ID', rich_text: { equals: c.clusterId } }, page_size: 1 },
      page: {
        properties: {
          Name: { title: richText(clusterTitle(c)) },
          'Cluster ID': { rich_text: richText(c.clusterId) },
          Status: { select: { name: NOTION_STATUS_DEFAULT } },
          'Max Score': { number: c.maxScore },
          'Record Count': { number: c.size },
          'Suggested Primary': { rich_text: richText((primary.name || '(no name)') + ' (ID ' + primary.id + ')', hubspotRecordUrl(m, primary.id)) },
          'HubSpot IDs': { rich_text: richText(c.members.map((x) => x.id).join(', ')) },
          Domains: { rich_text: richText(domains.join(', ')) },
          Reasons: { multi_select: c.reasons.map((r) => ({ name: r })) },
          'Detected At': { date: { start: m.runAt || new Date().toISOString() } },
        },
        children,
      },
    };
  });
}

/** Everything a dry run would have sent, without sending anything. */
function buildDryRunPreview(result, meta) {
  return {
    dryRun: true,
    note: 'DRY_RUN is on: nothing was sent to Slack or Notion. Set DRY_RUN=false to deliver.',
    meta,
    summary: result.summary,
    slackPayload: buildSlackPayload(result, meta),
    notionPages: buildNotionPages(result, meta),
    csv: toCsv(result),
  };
}

// @n8n-exclude-start
module.exports = {
  NOTION_STATUS_DEFAULT,
  CSV_COLUMNS,
  createRunMeta,
  csvCell,
  toCsv,
  escapeMrkdwn,
  hubspotRecordUrl,
  buildSlackPayload,
  buildNotionPages,
  buildDryRunPreview,
};
// @n8n-exclude-end
