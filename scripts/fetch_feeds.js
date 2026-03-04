#!/usr/bin/env node
/*
 * Fetch curated external sources (fund profiles, market context, etc.)
 * and store the latest snapshot in knowledge/entries.json
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');

const OUTPUT_PATH = path.resolve(__dirname, '..', 'knowledge', 'entries.json');

const SOURCES = [
  {
    id: 'kgi-ACCP138-TFO3',
    url: 'https://kgilife.moneydj.com/w/wr/wr01.djhtm?a=ACCP138-TFO3',
    encoding: 'big5',
    tags: ['fund', 'multi-asset', 'kgi'],
    parser: parseKgiFund
  },
  {
    id: 'kgi-ALBT8-TFU6',
    url: 'https://kgilife.moneydj.com/w/wb/wb01.djhtm?a=ALBT8-TFU6',
    encoding: 'big5',
    tags: ['fund', 'equity', 'kgi'],
    parser: parseKgiFund
  },
  {
    id: 'kgi-JFZN3-TFU5',
    url: 'https://kgilife.moneydj.com/w/wb/wb01.djhtm?a=JFZN3-TFU5',
    encoding: 'big5',
    tags: ['fund', 'equity', 'kgi'],
    parser: parseKgiFund
  },
  {
    id: 'kgi-ACTI71-TFS6',
    url: 'https://kgilife.moneydj.com/w/wr/wr02.djhtm?a=ACTI71-TFS6',
    encoding: 'big5',
    tags: ['fund', 'fixed-income', 'kgi'],
    parser: parseKgiFund
  }
];

async function main() {
  const generatedAt = new Date().toISOString();
  const entries = [];

  for (const source of SOURCES) {
    try {
      const html = await fetchWithEncoding(source.url, source.encoding || 'utf-8');
      const parsed = await source.parser(html, source);
      if (!parsed || !parsed.title) {
        console.warn(`[warn] parser returned empty data for ${source.id}`);
        continue;
      }
      entries.push({
        id: source.id,
        sourceId: source.id,
        title: parsed.title,
        summary: parsed.summary,
        url: source.url,
        tags: source.tags,
        fetchedAt: generatedAt,
        data: parsed.data || {}
      });
    } catch (error) {
      console.error(`[error] failed to collect ${source.id}:`, error.message);
    }
  }

  const payload = { generatedAt, entries };
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2), 'utf-8');
  console.log(`Saved ${entries.length} entries to ${OUTPUT_PATH}`);
}

async function fetchWithEncoding(url, encoding) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  return iconv.decode(buffer, encoding);
}

async function parseKgiFund(html, source) {
  const $ = cheerio.load(html);
  const table = $('table.table-bordered').first();
  if (!table.length) {
    return null;
  }

  const getCell = (label) => table.find(`th:contains(${label})`).first().next('td').text().trim();

  const title = $('table.table-bordered th:contains(基金名稱)').next('td').text().trim() || $('h4').first().text().trim();
  const company = getCell('基金公司');
  const manager = getCell('基金經理人');
  const size = getCell('基金規模');
  const type = getCell('基金類型');
  const risk = getCell('風險報酬等級');
  const currency = getCell('計價幣別');
  const fee = getCell('最高管理年費');
  const region = getCell('主要投資區域');

  const summaryPieces = [
    company && `投信：${company}`,
    type && `類型：${type}`,
    region && `區域：${region}`,
    size && `規模：${size}`,
    manager && `經理人：${manager}`,
    risk && `RR：${risk}`,
    currency && `計價：${currency}`,
    fee && `管理費：${fee}%`
  ].filter(Boolean);

  return {
    title: title || source.id,
    summary: summaryPieces.join('｜') || '暫無摘要',
    data: {
      company,
      manager,
      size,
      type,
      risk,
      currency,
      region,
      fee
    }
  };
}

main().catch((error) => {
  console.error('[fatal] fetch job failed', error);
  process.exitCode = 1;
});
