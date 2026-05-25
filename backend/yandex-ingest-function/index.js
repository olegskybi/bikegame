"use strict";

const crypto = require("node:crypto");

const DEFAULT_REGION = "ru-central1";
const STORAGE_HOST = "storage.yandexcloud.net";
const STORAGE_REQUEST_TIMEOUT_MS = 20000;
const EVENT_NAME_LIMIT = 120;

exports.handler = async function handler(event) {
  const method = event?.httpMethod || event?.requestContext?.http?.method || "POST";
  const origin = getHeader(event, "origin");
  const corsHeaders = getCorsHeaders(origin);

  if (method === "OPTIONS") {
    return response(204, "", corsHeaders);
  }

  if (!isOriginAllowed(origin)) {
    return jsonResponse(403, { ok: false, error: "origin_forbidden" }, corsHeaders);
  }

  if (method !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" }, corsHeaders);
  }

  let payload;
  try {
    payload = parseBody(event);
  } catch {
    return jsonResponse(400, { ok: false, error: "invalid_json" }, corsHeaders);
  }

  const normalized = normalizeEvent(payload);
  if (!normalized.event) {
    return jsonResponse(400, { ok: false, error: "missing_event_name" }, corsHeaders);
  }

  try {
    await saveEvent(normalized);
    return jsonResponse(200, { ok: true, saved: true, eventId: normalized.eventId }, corsHeaders);
  } catch (error) {
    console.error("bikegame_event_save_error", error);
    return jsonResponse(503, { ok: false, error: "event_save_failed" }, corsHeaders);
  }
};

function parseBody(event) {
  const rawBody = event?.body || "{}";
  const body = event?.isBase64Encoded ? Buffer.from(rawBody, "base64").toString("utf8") : rawBody;
  return JSON.parse(body || "{}");
}

function normalizeEvent(payload) {
  const now = new Date();
  const receivedAt = now.toISOString();
  const eventDate = getMoscowDateStamp(now);
  const playerId = cleanString(payload.playerId, 160);
  const runId = cleanString(payload.runId, 160);
  const prizeId = cleanString(payload.prizeId, 160);
  const eventName = cleanString(payload.event || payload.name, EVENT_NAME_LIMIT);

  return {
    eventId: crypto.randomUUID(),
    receivedAt,
    eventDate,
    event: eventName,
    game: cleanString(payload.game || "bikegame", 80),
    pageUrl: cleanString(payload.pageUrl, 600),
    playerId,
    playerLabel: cleanString(payload.playerLabel || payload.profileLabel, 200),
    runId,
    prizeId,
    products: toFiniteNumber(payload.products),
    coins: toFiniteNumber(payload.coins),
    lives: toFiniteNumber(payload.lives),
    durationSec: toFiniteNumber(payload.durationSec),
    cooldownMs: toFiniteNumber(payload.cooldownMs),
    msUntilNextRun: toFiniteNumber(payload.msUntilNextRun),
    cost: toFiniteNumber(payload.cost),
    reason: cleanString(payload.reason, 80),
    remoteProfile: Boolean(payload.remoteProfile || payload.isAuthorized),
    sourcePayload: sanitizePayload(payload)
  };
}

function sanitizePayload(payload) {
  if (!payload || typeof payload !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "string") out[key] = cleanString(value, 600);
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
  }
  return out;
}

async function saveEvent(eventPayload) {
  const bucket = requiredEnv("YC_EVENTS_BUCKET");
  const key = `${getEventsPrefix()}/${eventPayload.eventDate}/${eventPayload.receivedAt.replace(/[:.]/g, "-")}-${eventPayload.eventId}.json`;
  await putStorageObject(bucket, key, JSON.stringify(eventPayload), "application/json; charset=utf-8");
}

function getEventsPrefix() {
  return cleanString(process.env.YC_EVENTS_PREFIX || "events", 120).replace(/^\/+|\/+$/g, "") || "events";
}

async function putStorageObject(bucket, key, body, contentType) {
  await signedStorageRequest({ bucket, key, method: "PUT", body, contentType });
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

  if (!storageResponse.ok) {
    throw new Error(`Object Storage returned ${storageResponse.status}`);
  }

  return storageResponse.text();
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

function getMoscowDateStamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
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
