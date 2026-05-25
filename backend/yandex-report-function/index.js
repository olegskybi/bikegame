"use strict";

const crypto = require("node:crypto");
const zlib = require("node:zlib");

const DEFAULT_REGION = "ru-central1";
const STORAGE_HOST = "storage.yandexcloud.net";
const DATE_LOAD_CONCURRENCY = 2;
const OBJECT_LOAD_CONCURRENCY = 8;
const STORAGE_REQUEST_TIMEOUT_MS = 20000;
const EVENT_HEADERS = [
  "Дата события",
  "Время события",
  "ID игрока",
  "Событие",
  "Run ID",
  "Товары",
  "Монеты",
  "Жизни",
  "Причина",
  "Приз",
  "Стоимость",
  "Длительность, сек",
  "Cooldown, мс",
  "URL"
];
const STATE_HEADERS = [
  "ID игрока",
  "Монеты",
  "Открытые призы",
  "Стрик входа",
  "Последний вход",
  "Последняя награда",
  "Дата последней игры",
  "Время последней игры",
  "Последний runId",
  "Обновлено"
];

exports.handler = async function handler(event) {
  const method = event?.httpMethod || event?.requestContext?.http?.method || "GET";
  const origin = getHeader(event, "origin");
  const corsHeaders = getCorsHeaders(origin);

  if (method === "OPTIONS") return response(204, "", corsHeaders);
  if (!isOriginAllowed(origin)) return jsonResponse(403, { ok: false, error: "origin_forbidden" }, corsHeaders);
  if (method !== "POST") return jsonResponse(405, { ok: false, error: "method_not_allowed" }, corsHeaders);

  const params = getRequestParams(event);
  const auth = checkAuth(params);
  if (!auth.ok) return jsonResponse(401, { ok: false, error: "unauthorized" }, corsHeaders);

  const range = parseDateRange(params.from, params.to);
  if (!range.ok) return jsonResponse(400, { ok: false, error: range.error }, corsHeaders);

  try {
    const [events, states] = await Promise.all([
      loadEvents(range.dates),
      loadPlayerStates()
    ]);

    const filteredEvents = filterEvents(events, range.from, range.to);
    const eventRows = filteredEvents.map(toEventRow);
    const stateRows = states.map(toStateRow);
    const summary = buildSummary(filteredEvents, stateRows);
    const format = cleanString(params.format, 12).toLowerCase();

    if (format === "json") {
      return response(200, JSON.stringify({
        ok: true,
        range,
        summary,
        events: eventRows,
        states: stateRows
      }, null, 2), {
        ...corsHeaders,
        "Content-Type": "application/json; charset=utf-8",
      });
    }

    if (format === "csv") {
      const csv = buildCsv(EVENT_HEADERS, eventRows);
      return response(200, csv, {
        ...corsHeaders,
        "Content-Disposition": `attachment; filename="${reportFileName(range, "csv")}"`,
        "Content-Type": "text/csv; charset=utf-8",
      });
    }

    const zip = createZip([
      { name: "bikegame-events.csv", data: Buffer.from(buildCsv(EVENT_HEADERS, eventRows), "utf8") },
      { name: "bikegame-player-states.csv", data: Buffer.from(buildCsv(STATE_HEADERS, stateRows), "utf8") },
      { name: "bikegame-summary.json", data: Buffer.from(JSON.stringify(summary, null, 2), "utf8") }
    ]);

    return response(200, zip.toString("base64"), {
      ...corsHeaders,
      "Content-Disposition": `attachment; filename="${reportFileName(range, "zip")}"`,
      "Content-Type": "application/zip",
    }, true);
  } catch (error) {
    console.error("bikegame_report_error", error);
    return jsonResponse(503, { ok: false, error: "report_unavailable" }, corsHeaders);
  }
};

function getRequestParams(event) {
  try {
    const rawBody = event?.body || "{}";
    const body = event?.isBase64Encoded ? Buffer.from(rawBody, "base64").toString("utf8") : rawBody;
    return JSON.parse(body || "{}");
  } catch {
    return {};
  }
}

function checkAuth(query) {
  const expectedPassword = process.env.REPORT_PASSWORD;
  if (!expectedPassword) return { ok: false };
  return { ok: cleanString(query.password, 200) === expectedPassword };
}

function parseDateRange(fromInput, toInput) {
  const from = normalizeDate(fromInput);
  const to = normalizeDate(toInput);
  if (!from || !to) return { ok: false, error: "invalid_date_range" };
  if (from > to) return { ok: false, error: "invalid_date_order" };

  const dates = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);

  while (cursor <= end) {
    if (dates.length > 370) return { ok: false, error: "date_range_too_large" };
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return { ok: true, from, to, dates };
}

function normalizeDate(value) {
  const raw = cleanString(value, 20);
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const ru = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (ru) return `${ru[3]}-${ru[2]}-${ru[1]}`;
  return "";
}

async function loadEvents(dates) {
  const bucket = requiredEnv("YC_EVENTS_BUCKET");
  const groups = await mapWithConcurrency(dates, DATE_LOAD_CONCURRENCY, async (date) => {
    const keys = await listStorageKeys(bucket, `${getEventsPrefix()}/${date}/`);
    const events = await mapWithConcurrency(keys, OBJECT_LOAD_CONCURRENCY, async (key) => {
      try {
        return JSON.parse(await signedStorageRequest({ bucket, key, method: "GET" }));
      } catch (error) {
        console.error("bikegame_event_read_error", { key, message: error.message });
        return null;
      }
    });
    return events.filter(Boolean);
  });
  return groups.flat();
}

async function loadPlayerStates() {
  const bucket = process.env.YC_PLAYER_STATE_BUCKET;
  if (!bucket) return [];
  const keys = await listStorageKeys(bucket, `${getStatePrefix()}/`);
  const rows = await mapWithConcurrency(keys, OBJECT_LOAD_CONCURRENCY, async (key) => {
    try {
      return JSON.parse(await signedStorageRequest({ bucket, key, method: "GET" }));
    } catch (error) {
      console.error("bikegame_state_read_error", { key, message: error.message });
      return null;
    }
  });
  return rows.filter(Boolean);
}

function filterEvents(events, from, to) {
  return events
    .filter((event) => {
      const eventDate = normalizeDateFromIso(event?.receivedAt || "");
      return eventDate && eventDate >= from && eventDate <= to;
    })
    .sort((a, b) => cleanString(a?.receivedAt, 80).localeCompare(cleanString(b?.receivedAt, 80)));
}

function toEventRow(event) {
  return {
    "Дата события": normalizeDateFromIso(event.receivedAt),
    "Время события": cleanString(event.receivedAt, 80),
    "ID игрока": cleanString(event.playerId, 160),
    "Событие": cleanString(event.event, 120),
    "Run ID": cleanString(event.runId, 160),
    "Товары": String(toFiniteNumber(event.products)),
    "Монеты": String(toFiniteNumber(event.coins)),
    "Жизни": String(toFiniteNumber(event.lives)),
    "Причина": cleanString(event.reason, 80),
    "Приз": cleanString(event.prizeId, 160),
    "Стоимость": String(toFiniteNumber(event.cost)),
    "Длительность, сек": String(toFiniteNumber(event.durationSec)),
    "Cooldown, мс": String(toFiniteNumber(event.cooldownMs || event.msUntilNextRun)),
    "URL": cleanString(event.pageUrl, 600),
  };
}

function toStateRow(item) {
  const state = item?.state || {};
  const daily = state.dailyLoginState || {};
  const playLimit = state.playLimitState || {};
  return {
    "ID игрока": cleanString(item.playerId, 160),
    "Монеты": String(toFiniteNumber(state.coins)),
    "Открытые призы": String(Object.keys(state.openedPrizes || {}).length),
    "Стрик входа": String(toFiniteNumber(daily.streak)),
    "Последний вход": cleanString(daily.lastDate, 20),
    "Последняя награда": cleanString(daily.lastRewardDate, 20),
    "Дата последней игры": cleanString(playLimit.lastPlayedDate, 20),
    "Время последней игры": cleanString(playLimit.lastPlayedAt, 80),
    "Последний runId": cleanString(playLimit.lastRunId, 160),
    "Обновлено": cleanString(item.updatedAt, 80),
  };
}

function buildSummary(events, stateRows) {
  const byEvent = {};
  const uniquePlayers = new Set();
  let totalCoins = 0;
  let totalProducts = 0;

  events.forEach((event) => {
    const name = cleanString(event.event, 120) || "unknown";
    byEvent[name] = (byEvent[name] || 0) + 1;
    if (event.playerId) uniquePlayers.add(event.playerId);
    totalCoins += toFiniteNumber(event.coins);
    totalProducts += toFiniteNumber(event.products);
  });

  return {
    totalEvents: events.length,
    uniquePlayers: uniquePlayers.size,
    storedProfiles: stateRows.length,
    totalCoinsObserved: totalCoins,
    totalProductsObserved: totalProducts,
    eventsByName: byEvent
  };
}

function normalizeDateFromIso(value) {
  const raw = cleanString(value, 80);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
}

async function listStorageKeys(bucket, prefix) {
  const keys = [];
  let continuationToken = "";

  do {
    const query = new URLSearchParams({ "list-type": "2", prefix });
    if (continuationToken) query.set("continuation-token", continuationToken);
    const xml = await signedStorageRequest({ bucket, key: "", method: "GET", query: query.toString() });
    keys.push(...extractXmlTags(xml, "Key").map(decodeXml));
    continuationToken = decodeXml(extractXmlTags(xml, "NextContinuationToken")[0] || "");
  } while (continuationToken);

  return keys;
}

async function signedStorageRequest({ bucket, body = "", contentType = "", key, method, query = "" }) {
  const accessKeyId = requiredEnv("YC_ACCESS_KEY_ID");
  const secretAccessKey = requiredEnv("YC_SECRET_ACCESS_KEY");
  const region = process.env.YC_REGION || DEFAULT_REGION;
  const endpoint = new URL(`https://${STORAGE_HOST}/${bucket}/${key}${query ? `?${query}` : ""}`);
  const headers = {
    host: endpoint.host,
    "x-amz-content-sha256": sha256Hex(body),
  };
  if (contentType) headers["content-type"] = contentType;

  const signedHeaders = signAwsRequest({
    accessKeyId,
    body,
    headers,
    method,
    path: endpoint.pathname,
    query: endpoint.search.slice(1),
    region,
    secretAccessKey,
    service: "s3",
  });

  const storageResponse = await fetch(endpoint, {
    body: method === "GET" ? undefined : body,
    headers: signedHeaders,
    method,
    signal: AbortSignal.timeout(STORAGE_REQUEST_TIMEOUT_MS),
  });
  const text = await storageResponse.text();

  if (!storageResponse.ok) {
    throw new Error(`Object Storage returned ${storageResponse.status}: ${text}`);
  }

  return text;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runNext() {
    const index = cursor;
    cursor += 1;
    if (index >= items.length) return;
    results[index] = await worker(items[index], index);
    await runNext();
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runNext));
  return results;
}

function buildCsv(headers, rows) {
  const lines = [headers.map(escapeCsv).join(";")];
  rows.forEach((row) => {
    lines.push(headers.map((header) => escapeCsv(row?.[header] || "")).join(";"));
  });
  return `\ufeff${lines.join("\r\n")}\r\n`;
}

function escapeCsv(value) {
  return `"${cleanString(value, 4000).replace(/"/g, '""')}"`;
}

function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  files.forEach((file) => {
    const name = Buffer.from(file.name, "utf8");
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);

    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  });

  const centralSize = centralParts.reduce((sum, item) => sum + item.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function crc32(buffer) {
  return zlib.crc32 ? zlib.crc32(buffer) : crc32Fallback(buffer);
}

function crc32Fallback(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ -1) >>> 0;
}

function extractXmlTags(xml, tagName) {
  return [...xml.matchAll(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "g"))].map((match) => match[1]);
}

function decodeXml(value) {
  return cleanString(value, 4000)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function signAwsRequest({ accessKeyId, body, headers, method, path, query, region, secretAccessKey, service }) {
  const now = new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const signedHeaders = Object.keys(headers).map((key) => key.toLowerCase()).sort();
  const normalizedHeaders = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value).trim()]));
  normalizedHeaders["x-amz-date"] = amzDate;
  signedHeaders.push("x-amz-date");
  signedHeaders.sort();

  const canonicalHeaders = signedHeaders.map((key) => `${key}:${normalizedHeaders[key]}\n`).join("");
  const canonicalRequest = [method, path || "/", query || "", canonicalHeaders, signedHeaders.join(";"), sha256Hex(body)].join("\n");
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = getSignatureKey(secretAccessKey, dateStamp, region, service);
  const signature = hmacHex(signingKey, stringToSign);

  return {
    ...normalizedHeaders,
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders.join(";")}, Signature=${signature}`,
  };
}

function toAmzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key, value) {
  return crypto.createHmac("sha256", key).update(value, "utf8").digest();
}

function hmacHex(key, value) {
  return crypto.createHmac("sha256", key).update(value, "utf8").digest("hex");
}

function getSignatureKey(secretAccessKey, dateStamp, region, service) {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const dateRegionKey = hmac(dateKey, region);
  const dateRegionServiceKey = hmac(dateRegionKey, service);
  return hmac(dateRegionServiceKey, "aws4_request");
}

function getEventsPrefix() {
  return cleanString(process.env.YC_EVENTS_PREFIX || "events", 120).replace(/^\/+|\/+$/g, "") || "events";
}

function getStatePrefix() {
  return cleanString(process.env.YC_PLAYER_STATE_PREFIX || "player-state", 120).replace(/^\/+|\/+$/g, "") || "player-state";
}

function getCorsHeaders(origin) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
  const allowedOrigins = getAllowedOrigins();
  const corsOrigin = allowedOrigin === "*" || !origin ? allowedOrigin : allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  return {
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Origin": corsOrigin,
    "Access-Control-Max-Age": "86400",
  };
}

function isOriginAllowed(origin) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
  return allowedOrigin === "*" || Boolean(origin && getAllowedOrigins().includes(origin));
}

function getAllowedOrigins() {
  return (process.env.ALLOWED_ORIGIN || "*").split(",").map((item) => item.trim()).filter(Boolean);
}

function reportFileName(range, extension) {
  return `bikegame-analytics-${range.from}-${range.to}.${extension}`;
}

function cleanString(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function getHeader(event, name) {
  const headers = event?.headers || {};
  const target = name.toLowerCase();
  const key = Object.keys(headers).find((item) => item.toLowerCase() === target);
  return key ? headers[key] : "";
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

function response(statusCode, body, headers = {}, isBase64Encoded = false) {
  return { statusCode, headers, body, isBase64Encoded };
}

function jsonResponse(statusCode, body, headers = {}) {
  return response(statusCode, JSON.stringify(body), { "Content-Type": "application/json; charset=utf-8", ...headers });
}
