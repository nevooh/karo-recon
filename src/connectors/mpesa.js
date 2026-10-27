const axios = require('axios');
const crypto = require('crypto');

const BASE_URL = process.env.MPESA_ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

// Simple in-memory token cache, keyed by consumer key, since different
// schools now have different credentials and therefore different tokens.
const tokenCache = new Map();

/**
 * Daraja OAuth token for ONE school's credentials. Every function below now
 * takes credentials as arguments instead of reading process.env directly -
 * this is what makes it possible for each school to have its own keys.
 */
async function getAccessToken(consumerKey, consumerSecret) {
  const cached = tokenCache.get(consumerKey);
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
  const { data } = await axios.get(
    `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } }
  );

  const token = data.access_token;
  const expiresAt = Date.now() + (Number(data.expires_in) - 120) * 1000;
  tokenCache.set(consumerKey, { token, expiresAt });
  return token;
}

/**
 * Checks that a school's Consumer Key + Secret are really accepted by Safaricom.
 * Always makes a FRESH call (never uses the token cache), so a wrong secret cannot
 * hide behind an old cached token. Registers nothing and changes nothing.
 */
async function verifyCredentials(consumerKey, consumerSecret) {
  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
  const { data } = await axios.get(
    `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` }, timeout: 15000 }
  );
  return Boolean(data && data.access_token);
}

// Safaricom silently blocks callback URLs that contain these words.
const BLOCKED_URL_WORDS = ['mpesa', 'm-pesa', 'safaricom'];
// It also dislikes these; we warn rather than block, since a normal domain can contain "exe" by accident.
const WARN_URL_WORDS = ['exe', 'exec', 'cmd', 'sql', 'query'];

/** Throws a plain-English error if Safaricom would refuse this callback URL. */
function assertCallbackUrlAllowed(url) {
  const lower = String(url || '').toLowerCase();
  if (!/^https:\/\//.test(lower)) throw new Error(`Callback URL must start with https:// - got "${url}"`);
  if (/localhost|127\.0\.0\.1/.test(lower)) throw new Error('Safaricom cannot reach localhost - use a public https address (a server, or a tunnel while testing)');
  const bad = BLOCKED_URL_WORDS.find((w) => lower.includes(w));
  if (bad) throw new Error(`Callback URL must not contain "${bad}" - Safaricom blocks it. Use a neutral path such as /webhooks/c2b/...`);
  const warn = WARN_URL_WORDS.find((w) => lower.includes(w));
  if (warn) console.warn(`Warning: callback URL contains "${warn}", which Safaricom has been known to reject: ${url}`);
}

/**
 * Safaricom does not sign its callbacks, so the URLs we register carry a long
 * secret token (an HMAC of the shortcode with a server secret). Only Safaricom,
 * which we gave the URL to, and we know it. It is hex, so it can never contain
 * a blocked word.
 */
function c2bUrlToken(shortcode) {
  const secret = process.env.C2B_URL_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    const err = new Error('Set C2B_URL_SECRET (or JWT_SECRET) in .env first');
    err.status = 500;
    throw err;
  }
  return crypto.createHmac('sha256', secret).update('c2b-callback:' + String(shortcode)).digest('hex').slice(0, 40);
}

function buildCallbackUrls(baseUrl, shortcode) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const token = c2bUrlToken(shortcode);
  return {
    confirmationUrl: `${base}/webhooks/c2b/${token}/confirmation`,
    validationUrl: `${base}/webhooks/c2b/${token}/validation`,
  };
}

// The two addresses for a given secret code (the code is made and stored per school,
// see services/mpesaUrlToken.js). The code is the same in both addresses.
function buildUrlsFromToken(baseUrl, token) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return {
    confirmationUrl: `${base}/webhooks/c2b/${token}/confirmation`,
    validationUrl: `${base}/webhooks/c2b/${token}/validation`,
  };
}

/**
 * One-time setup call for a specific school: tells Safaricom where to send
 * C2B validation/confirmation webhooks for that school's paybill.
 * Uses the v2 endpoint (the v1 one is reported to fail for production
 * registration); set MPESA_C2B_VERSION=v1 only if Safaricom tells you otherwise.
 */
async function registerC2BUrls({ consumerKey, consumerSecret, shortcode, confirmationUrl, validationUrl }) {
  assertCallbackUrlAllowed(confirmationUrl);
  assertCallbackUrlAllowed(validationUrl);
  const version = process.env.MPESA_C2B_VERSION || 'v2';
  const token = await getAccessToken(consumerKey, consumerSecret);
  const { data } = await axios.post(
    `${BASE_URL}/mpesa/c2b/${version}/registerurl`,
    {
      ShortCode: shortcode,
      ResponseType: 'Completed',
      ConfirmationURL: confirmationUrl,
      ValidationURL: validationUrl,
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return data;
}

/**
 * Sandbox-only: triggers a fake C2B payment for a specific school's test
 * paybill, so you can generate test transactions without a real statement.
 */
async function simulateC2BPayment({ consumerKey, consumerSecret, shortcode, amount, phone, billRefNumber }) {
  const token = await getAccessToken(consumerKey, consumerSecret);
  const { data } = await axios.post(
    `${BASE_URL}/mpesa/c2b/v1/simulate`,
    {
      ShortCode: shortcode,
      CommandID: 'CustomerPayBillOnline',
      Amount: amount,
      Msisdn: phone,
      BillRefNumber: billRefNumber,
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return data;
}

/**
 * Normalizes a raw Daraja C2B confirmation payload into the shape
 * ingestPayment() expects. No credentials needed here - this just reads
 * the incoming webhook body.
 * Newer Daraja versions send the phone number hashed or masked; a value that
 * isn't a real phone number is dropped (the raw message still keeps it).
 */
function normalizeC2BPayload(body) {
  const phone = String(body.MSISDN == null ? '' : body.MSISDN).trim();
  return {
    source: 'mpesa',
    external_ref: String(body.TransID == null ? '' : body.TransID).trim(),
    amount: Number(String(body.TransAmount == null ? '' : body.TransAmount).replace(/,/g, '')),
    payer_phone: /^\+?\d{9,15}$/.test(phone) ? phone : null,
    payer_name: [body.FirstName, body.MiddleName, body.LastName].filter(Boolean).join(' '),
    narration: body.BillRefNumber,
    raw: body,
  };
}

module.exports = { getAccessToken, verifyCredentials, buildUrlsFromToken, registerC2BUrls, simulateC2BPayment, normalizeC2BPayload, assertCallbackUrlAllowed, c2bUrlToken, buildCallbackUrls };