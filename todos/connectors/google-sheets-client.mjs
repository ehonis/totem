import { readFileSync } from 'node:fs';
import { sign } from 'node:crypto';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

function base64url(value) {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
}

function loadCredentials(file) {
  let credentials;
  try { credentials = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`Unable to read Google Sheets service-account credentials: ${error.message}`); }
  if (!credentials?.client_email || !credentials?.private_key) {
    throw new Error('Google Sheets credentials require client_email and private_key');
  }
  return {
    clientEmail: credentials.client_email,
    privateKey: credentials.private_key,
    tokenUri: credentials.token_uri || 'https://oauth2.googleapis.com/token',
  };
}

function nowMs(now) {
  const value = now();
  const milliseconds = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error('Google Sheets client clock returned an invalid time');
  return milliseconds;
}

async function responseJson(response, label) {
  let body;
  try { body = await response.json(); }
  catch { throw new Error(`${label} returned a non-JSON response (${response.status})`); }
  if (!response.ok) {
    const message = body?.error?.message || `${label} failed with HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return body;
}

export function createGoogleSheetsClient({ credentialsFile, fetch = globalThis.fetch, now = Date.now } = {}) {
  if (!credentialsFile) throw new TypeError('createGoogleSheetsClient requires credentialsFile');
  if (typeof fetch !== 'function') throw new TypeError('createGoogleSheetsClient requires fetch');
  const credentials = loadCredentials(credentialsFile);
  let cachedToken = null;

  async function accessToken() {
    const current = nowMs(now);
    if (cachedToken && cachedToken.expiresAt - 60_000 > current) return cachedToken.value;
    const issuedAt = Math.floor(current / 1000);
    const header = base64url({ alg: 'RS256', typ: 'JWT' });
    const claims = base64url({
      iss: credentials.clientEmail,
      scope: SCOPE,
      aud: credentials.tokenUri,
      iat: issuedAt,
      exp: issuedAt + 3600,
    });
    const unsigned = `${header}.${claims}`;
    const assertion = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), credentials.privateKey).toString('base64url')}`;
    const response = await fetch(credentials.tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
    const body = await responseJson(response, 'Google OAuth token exchange');
    if (!body?.access_token || !Number.isFinite(Number(body.expires_in))) {
      throw new Error('Google OAuth token exchange returned malformed credentials');
    }
    cachedToken = { value: body.access_token, expiresAt: current + Number(body.expires_in) * 1000 };
    return cachedToken.value;
  }

  async function request(url, init = {}) {
    const token = await accessToken();
    const response = await fetch(url, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...init.headers,
        Authorization: `Bearer ${token}`,
      },
    });
    return responseJson(response, 'Google Sheets API');
  }

  return {
    getMetadata(spreadsheetId) {
      return request(`${SHEETS_API}/${encodeURIComponent(spreadsheetId)}?includeGridData=false`);
    },
    readRange(spreadsheetId, range) {
      return request(`${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`);
    },
    batchUpdateValues(spreadsheetId, data) {
      return request(`${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
      });
    },
    batchUpdateSpreadsheet(spreadsheetId, requests) {
      return request(`${SHEETS_API}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({ requests }),
      });
    },
  };
}
