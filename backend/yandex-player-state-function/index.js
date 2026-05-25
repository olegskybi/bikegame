"use strict";

const crypto = require("node:crypto");

const DEFAULT_REGION = "ru-central1";
const STORAGE_HOST = "storage.yandexcloud.net";
const STORAGE_REQUEST_TIMEOUT_MS = 20000;
const DEFAULT_STATE = {
  coins: 0,
  openedPrizes: {},
  dailyLoginState: { streak: 0, lastDate: "", lastRewardDate: "" },
  playLimitState: { lastPlayedDate: "", lastPlayedAt: "", lastRunId: "" }
};

exports.handler = async function handler(event) {
  const method = event?.httpMethod || event?.requestContext?.http?.method || "GET";
  const origin = getHeader(event, "origin");
  const corsHeaders = getCorsHeaders(origin);

  if (method === "OPTIONS") return response(204, "", corsHeaders);
  if (!isOriginAllowed(origin)) return jsonResponse(403, { ok: false, error: "origin_forbidden" }, corsHeaders);

  const params = getRequestParams(event, method);
  const playerId = getPlayerId(event, params);
  if (!playerId) return jsonResponse(400, { ok: false, error: "missing_player_id" }, corsHeaders);

  try {
    if (method === "GET") {
      const state = await loadPlayerState(playerId);
      return jsonResponse(200, { ok: true, playerId, state }, corsHeaders);
    }

    if (method === "POST") {
      const existing = await loadPlayerState(playerId);
      const incoming = extractState(params);
      const merged = mergePlayerStates(existing, incoming);
      await savePlayerState(playerId, merged);
      return jsonResponse(200, { ok: true, playerId, state: merged }, corsHeaders);
    }

    return jsonResponse(405, { ok: false, error: "method_not_allowed" }, corsHeaders);
  } catch (error) {
    console.error("bikegame_player_state_error", error);
    return jsonResponse(503, { ok: false, error: "state_unavailable" }, corsHeaders);
  }
};

function getRequestParams(event, method) {
  const query = event?.queryStringParameters || {};
  if (method === "GET") return query;
  try {
    const rawBody = event?.body || "{}";
    const body = event?.isBase64Encoded ? Buffer.from(rawBody, "base64").toString("utf8") : rawBody;
    return { ...query, ...JSON.parse(body || "{}") };
  } catch {
    return query;
  }
}

function getPlayerId(event, params) {
  return cleanString(
    params.playerId ||
      params.player_id ||
      getHeader(event, "x-player-id"),
    160
  );
}

async function loadPlayerState(playerId) {
  const bucket = requiredEnv("YC_PLAYER_STATE_BUCKET");
  const key = getStateKey(playerId);
  try {
    const json = await signedStorageRequest({ bucket, key, method: "GET" });
    return mergePlayerStates(DEFAULT_STATE, JSON.parse(json || "{}"));
  } catch (error) {
    if (String(error.message).includes("404")) return structuredClone(DEFAULT_STATE);
    throw error;
  }
}

async function savePlayerState(playerId, state) {
  const bucket = requiredEnv("YC_PLAYER_STATE_BUCKET");
  const key = getStateKey(playerId);
  const body = JSON.stringify({
    playerId,
    updatedAt: new Date().toISOString(),
    state
  });
  await signedStorageRequest({
    bucket,
    key,
    method: "PUT",
    body,
    contentType: "application/json; charset=utf-8"
  });
}

function getStateKey(playerId) {
  const safeId = cleanString(playerId, 160).replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${getStatePrefix()}/${safeId}.json`;
}

function getStatePrefix() {
  return cleanString(process.env.YC_PLAYER_STATE_PREFIX || "player-state", 120).replace(/^\/+|\/+$/g, "") || "player-state";
}

function extractState(payload) {
  return {
    coins: toNonNegativeInt(payload.coins),
    openedPrizes: isObject(payload.openedPrizes) ? payload.openedPrizes : {},
    dailyLoginState: normalizeDailyLoginState(payload.dailyLoginState),
    playLimitState: normalizePlayLimitState(payload.playLimitState)
  };
}

function mergePlayerStates(existing, incoming) {
  const base = {
    coins: Math.max(toNonNegativeInt(existing?.coins), toNonNegativeInt(incoming?.coins)),
    openedPrizes: mergeOpenedPrizes(existing?.openedPrizes, incoming?.openedPrizes),
    dailyLoginState: pickLatestDailyState(existing?.dailyLoginState, incoming?.dailyLoginState),
    playLimitState: pickLatestPlayLimit(existing?.playLimitState, incoming?.playLimitState)
  };
  return base;
}

function mergeOpenedPrizes(a, b) {
  const left = isObject(a) ? a : {};
  const right = isObject(b) ? b : {};
  const merged = { ...left };
  Object.keys(right).forEach((key) => {
    merged[key] = Math.max(Number(merged[key] || 0), Number(right[key] || 0));
  });
  return merged;
}

function normalizeDailyLoginState(raw) {
  const state = isObject(raw) ? raw : {};
  return {
    streak: toNonNegativeInt(state.streak),
    lastDate: cleanString(state.lastDate, 20),
    lastRewardDate: cleanString(state.lastRewardDate, 20)
  };
}

function normalizePlayLimitState(raw) {
  const state = isObject(raw) ? raw : {};
  return {
    lastPlayedDate: cleanString(state.lastPlayedDate, 20),
    lastPlayedAt: cleanString(state.lastPlayedAt, 80),
    lastRunId: cleanString(state.lastRunId, 160)
  };
}

function pickLatestDailyState(a, b) {
  const left = normalizeDailyLoginState(a);
  const right = normalizeDailyLoginState(b);
  const leftKey = `${left.lastDate}|${left.lastRewardDate}`;
  const rightKey = `${right.lastDate}|${right.lastRewardDate}`;
  return rightKey > leftKey ? right : left;
}

function pickLatestPlayLimit(a, b) {
  const left = normalizePlayLimitState(a);
  const right = normalizePlayLimitState(b);
  return String(right.lastPlayedAt || "") >= String(left.lastPlayedAt || "") ? right : left;
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
  if (!storageResponse.ok) throw new Error(`Object Storage returned ${storageResponse.status}: ${text}`);
  return text;
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

function getCorsHeaders(origin) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
  const allowedOrigins = getAllowedOrigins();
  const corsOrigin = allowedOrigin === "*" || !origin ? allowedOrigin : allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  return {
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Player-Id",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

function toNonNegativeInt(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0;
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
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
