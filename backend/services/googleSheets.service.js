'use strict';

/* ===========================================================================
   googleSheets.service
   ---------------------------------------------------------------------------
   Append run results to a Google Sheet. Authenticated with a Google service
   account (the simplest model for a local single-user install): the operator
   sets GOOGLE_SERVICE_ACCOUNT_JSON once, shares each target sheet with the
   service account's e-mail, and every monitored/scheduled/manual run appends
   its rows.

   Auth is done directly (service-account JWT → OAuth2 token) with the deps we
   already have — jsonwebtoken (RS256) + node-fetch — so there is NO heavy
   `googleapis` dependency. Values are written with valueInputOption=RAW so a
   scraped cell like "=cmd()" is stored as literal text, never a live formula
   (spreadsheet formula-injection guard).

   The row-shaping (`parseSpreadsheetId`, `buildRows`) is pure and unit-tested;
   only `getAccessToken` / `getFirstRow` / `appendRows` touch the network.
   ========================================================================= */

const fs = require('fs');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const { unionHeaders, recordValue, isRecord, SCALAR_COLUMN } = require('../utils/resultsExport');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

let _accountCache;                 // undefined = not resolved yet
let _token = null;                 // { access_token, exp }

// ── service account ─────────────────────────────────────────────────────────

// Resolve the service-account credentials once. GOOGLE_SERVICE_ACCOUNT_JSON may
// be inline JSON or a path; GOOGLE_SERVICE_ACCOUNT_KEY_FILE is always a path.
// Returns { client_email, private_key } or null when not configured / invalid.
function getServiceAccount() {
  if (_accountCache !== undefined) return _accountCache;
  _accountCache = resolveServiceAccount();
  return _accountCache;
}

function resolveServiceAccount() {
  const inline = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const file = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  let raw = null;
  try {
    if (inline && inline.trim().startsWith('{')) raw = inline;
    else if (inline && inline.trim()) raw = fs.readFileSync(inline.trim(), 'utf8');
    else if (file && file.trim()) raw = fs.readFileSync(file.trim(), 'utf8');
  } catch (err) {
    console.warn(`[sheets] could not read service-account key: ${err.message}`);
    return null;
  }
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) {
    console.warn('[sheets] GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON');
    return null;
  }
  if (!parsed.client_email || !parsed.private_key) {
    console.warn('[sheets] service-account JSON is missing client_email/private_key');
    return null;
  }
  return { client_email: parsed.client_email, private_key: parsed.private_key };
}

function isConfigured() { return !!getServiceAccount(); }
function getServiceAccountEmail() { const a = getServiceAccount(); return a ? a.client_email : null; }

// For tests: forget the cached account/token so env changes take effect.
function _resetCache() { _accountCache = undefined; _token = null; }

// ── auth token (cached until ~1 min before expiry) ──────────────────────────

async function getAccessToken() {
  const acct = getServiceAccount();
  if (!acct) throw new Error('Google service account is not configured');
  const now = Math.floor(Date.now() / 1000);
  if (_token && _token.exp - 60 > now) return _token.access_token;

  const assertion = jwt.sign(
    { iss: acct.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 },
    acct.private_key,
    { algorithm: 'RS256' },
  );
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Google token exchange failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  _token = { access_token: json.access_token, exp: now + (json.expires_in || 3600) };
  return _token.access_token;
}

// ── Sheets REST ─────────────────────────────────────────────────────────────

// First row of a tab (to detect an existing header row). Returns string[] or [].
async function getFirstRow(spreadsheetId, sheetName) {
  const token = await getAccessToken();
  const range = encodeURIComponent(`${sheetName}!1:1`);
  const res = await fetch(`${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values/${range}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(sheetsError(res.status, text));
  }
  const json = await res.json();
  return (json.values && json.values[0]) ? json.values[0].map(String) : [];
}

// Append rows (array of arrays) after the last row with data in the tab.
async function appendValues(spreadsheetId, sheetName, values) {
  if (!values.length) return { appended: 0 };
  const token = await getAccessToken();
  const range = encodeURIComponent(sheetName);
  const url = `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values/${range}:append`
    + `?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(sheetsError(res.status, text));
  }
  return { appended: values.length };
}

function sheetsError(status, text) {
  if (status === 403) return 'Google Sheets denied access (403). Share the sheet with the service-account e-mail as an Editor.';
  if (status === 404) return 'Spreadsheet not found (404). Check the spreadsheet ID / URL.';
  let msg = '';
  try { msg = JSON.parse(text)?.error?.message || ''; } catch (_) {}
  return `Google Sheets API error (HTTP ${status})${msg ? `: ${msg}` : ''}`;
}

// High-level: append a run's chosen output list to a sheet, writing a header
// row first when the tab is empty. Returns { appended, wroteHeaders }.
async function appendResults(spreadsheetId, sheetName, results, { output }) {
  const existing = await getFirstRow(spreadsheetId, sheetName);
  const { headers, writeHeaders, dataRows } = buildRows(results, { output }, existing);
  const values = writeHeaders ? [headers, ...dataRows] : dataRows;
  const { appended } = await appendValues(spreadsheetId, sheetName, values);
  return { appended: dataRows.length, wroteHeaders: writeHeaders, rowsSent: appended, headers };
}

// ── pure helpers (unit-tested) ──────────────────────────────────────────────

// Accept a full Google Sheets URL or a bare ID; return the spreadsheet ID.
function parseSpreadsheetId(input) {
  if (!input || typeof input !== 'string') return null;
  const s = input.trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1];
  // A bare id is letters/digits/-/_ and reasonably long; reject anything with a slash.
  if (/^[a-zA-Z0-9-_]+$/.test(s)) return s;
  return null;
}

/* Shape a run's `output` list into sheet rows.
     existingHeaders present → align every row to the sheet's current columns
       (stable schema; missing keys blank, extra keys ignored), no header row.
     empty sheet → derive headers from the union of the rows and write them.
   Returns { headers, writeHeaders, dataRows }. */
function buildRows(results, { output }, existingHeaders = []) {
  const list = results && Array.isArray(results[output]) ? results[output] : [];

  if (existingHeaders && existingHeaders.length) {
    const dataRows = list.map(row => existingHeaders.map(h => cellToSheet(recordValue(row, h))));
    return { headers: existingHeaders, writeHeaders: false, dataRows };
  }

  const headers = unionHeaders(list); // null when the list holds no records
  if (headers === null) {
    // Flat scalar list → single "value" column.
    const dataRows = list.map(v => [cellToSheet(v)]);
    return { headers: [SCALAR_COLUMN], writeHeaders: list.length > 0, dataRows };
  }
  const dataRows = list.map(row => headers.map(h => cellToSheet(recordValue(row, h))));
  return { headers, writeHeaders: headers.length > 0, dataRows };
}

// Cell → a Sheets-safe scalar. Objects/arrays become JSON text; null/undefined
// become blank; numbers/booleans/strings pass through.
function cellToSheet(v) {
  if (v == null) return '';
  if (isRecord(v) || Array.isArray(v)) return JSON.stringify(v);
  return v;
}

module.exports = {
  isConfigured, getServiceAccountEmail, getServiceAccount,
  getAccessToken, getFirstRow, appendValues, appendResults,
  parseSpreadsheetId, buildRows, cellToSheet, _resetCache,
};
