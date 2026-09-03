#!/usr/bin/env node
/**
 * scripts/ls-poc.mjs — Lightspeed Retail R-Series proof of concept for the Biktrix Pickup Program.
 *
 * Proves, against your own Lightspeed account, that an outside app can:
 *   Note: SPEC.md §12 plans the R-Series seam around Sale/SaleLine polling. This PoC explores an
 *   alternative — modelling the pickup slot as a Lightspeed work order with an ETA Out — so the
 *   result feeds that design decision rather than implementing the spec as written.
 *
 *   1. authorise with OAuth 2.0 and refresh tokens,
 *   2. read shops, employees and work-order statuses,
 *   3. create a work order on a customer with an ETA Out (the pickup slot),
 *   4. update that work order (new ETA / new status).
 *
 * No dependencies. Node 18+ (uses global fetch).
 *
 * ── Setup ────────────────────────────────────────────────────────────────────
 *  1. Register an OAuth client at https://cloud.lightspeedapp.com/oauth/register.php (form: name,
 *     redirect URI, website, contact). Redirect URI must be HTTPS; for this PoC use:
 *       https://localhost:3000/callback
 *     You receive a client ID and client secret.
 *  2. Create a file named .env in the directory you run the script FROM (it reads ./.env):
 *       LS_CLIENT_ID=...
 *       LS_CLIENT_SECRET=...
 *       LS_REDIRECT_URI=https://localhost:3000/callback
 *  3. node ls-poc.mjs auth-url
 *       → open the printed URL, log in as a Lightspeed ADMIN (the scopes you get are
 *         capped by that user's permissions), approve. The browser lands on
 *         https://localhost:3000/callback?code=XXXX&state=... (a "can't connect" page is
 *         fine — just copy the code from the address bar).
 *  4. node ls-poc.mjs exchange XXXX
 *       → prints LS_ACCESS_TOKEN, LS_REFRESH_TOKEN, LS_ACCOUNT_ID. Paste them into .env.
 *  5. node ls-poc.mjs whoami
 *       → shops (find Vancouver's shopID), employees, work-order statuses with IDs.
 *  6. node ls-poc.mjs create-customer --first Test --last Pickup --email test@biktrix.com --phone +16045550123
 *  7. node ls-poc.mjs create-workorder --shop <shopID> --customer <customerID> --employee <employeeID> \
 *       --status <statusID> --eta "2026-09-12T13:15:00-07:00" --hookin "Shelf B3" \
 *       --desc "Juggernaut Ultra Beast 2" --color "Matte Black" --size Regular --serial BX123 \
 *       --note "PICKUP Sat 12 Sep 1:15 pm · Build by Fri 11 Sep · Box TEST-001 · Pre-order assembly + 21-point inspection"
 *       → prints the new workorderID. Open Service › Work Orders in Lightspeed and look for it;
 *         it should also appear on the work-order calendar feed on 12 Sep.
 *  8. node ls-poc.mjs update-workorder <workorderID> --status <finishedStatusID> --eta "2026-09-13T11:00:00-07:00"
 *       → proves the update path (reschedule / status change).
 *  9. node ls-poc.mjs get-workorder <workorderID>
 *
 * ── Notes ────────────────────────────────────────────────────────────────────
 *  • Refresh tokens ROTATE: every refresh returns a new refresh token and the old one is
 *    revoked once the new access token is used. This script prints the new pair whenever
 *    it refreshes — save it to .env or the next run will fail.
 *  • Field names follow the R-Series API reference (Workorder: customerID, shopID,
 *    employeeID, workorderStatusID, timeIn, etaOut, hookIn, hookOut, note, internalNote,
 *    warranty, saleID, serializedID). If the API rejects a field, its error message names
 *    it — adjust and rerun.
 *  • Rate limiting is a leaky bucket (base 90 drips, 1 drip/second). The script prints the
 *    bucket headers after each call and honours Retry-After on 429.
 */

import { readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

// ── tiny .env loader ─────────────────────────────────────────────────────────
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const env = (k, required = true) => {
  const v = process.env[k];
  if (required && !v) { console.error(`Missing ${k} (set it in .env)`); process.exit(1); }
  return v;
};

const OAUTH_AUTHORIZE = 'https://cloud.lightspeedapp.com/auth/oauth/authorize';
const OAUTH_TOKEN = 'https://cloud.lightspeedapp.com/auth/oauth/token';
const API = 'https://api.lightspeedapp.com/API/V3';

// Scopes for the PoC. Production should request the narrowest set that covers Customer + Workorder
// (SPEC.md §12 lists the Lightspeed seam but does not yet fix scopes).
const SCOPE = process.env.LS_SCOPE || 'employee:all';

// ── args ─────────────────────────────────────────────────────────────────────
const [cmd, ...rest] = process.argv.slice(2);
const args = {}; const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) { args[rest[i].slice(2)] = rest[i + 1]; i++; }
  else positional.push(rest[i]);
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
let accessToken = process.env.LS_ACCESS_TOKEN;
let refreshToken = process.env.LS_REFRESH_TOKEN;

async function tokenRequest(body) {
  const res = await fetch(OAUTH_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Token endpoint ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function refresh() {
  const j = await tokenRequest({
    client_id: env('LS_CLIENT_ID'), client_secret: env('LS_CLIENT_SECRET'),
    refresh_token: refreshToken, grant_type: 'refresh_token',
  });
  accessToken = j.access_token; refreshToken = j.refresh_token || refreshToken;
  console.error('\n⚠ Tokens refreshed — SAVE THESE to .env now:');
  console.error(`LS_ACCESS_TOKEN=${accessToken}`);
  console.error(`LS_REFRESH_TOKEN=${refreshToken}\n`);
}

async function api(method, path, body, { retried = false } = {}) {
  // Absolute URLs (e.g. Account.json during `exchange`) don't need LS_ACCOUNT_ID yet.
  const absolute = path.startsWith('http');
  const accountID = env('LS_ACCOUNT_ID', !absolute);
  const url = absolute ? path : `${API}/Account/${accountID}/${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const bucket = res.headers.get('x-ls-api-bucket-level');
  const drip = res.headers.get('x-ls-api-drip-rate');
  if (bucket) console.error(`  [rate] bucket ${bucket} · drip ${drip}/s`);

  if (res.status === 401 && refreshToken && !retried) {
    console.error('  401 → refreshing token and retrying once');
    await refresh();
    return api(method, path, body, { retried: true });
  }
  if (res.status === 429) {
    const wait = Number(res.headers.get('retry-after') || 2);
    console.error(`  429 → waiting ${wait}s`);
    await new Promise(r => setTimeout(r, wait * 1000));
    return api(method, path, body, { retried });
  }
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}\n${JSON.stringify(json, null, 2)}`);
  return json;
}

// Lightspeed returns a single object or an array depending on count; normalise.
const list = (obj, key) => obj?.[key] ? (Array.isArray(obj[key]) ? obj[key] : [obj[key]]) : [];
const table = rows => rows.length ? console.table(rows) : console.log('  (none)');

async function createSerialized({ customer, desc, color, size, serial, item }) {
  if (!customer || !desc) throw new Error('usage: create-serialized --customer ID --desc "Juggernaut Ultra Beast 2" [--color "Matte Black"] [--size Regular] [--serial SN] [--item itemID]');
  const body = {
    customerID: Number(customer),
    description: desc,
    ...(color ? { colorName: color } : {}),
    ...(size ? { sizeName: size } : {}),
    ...(serial ? { serial } : {}),
    ...(item ? { itemID: Number(item) } : {}),
  };
  const res = await api('POST', 'Serialized.json', body);
  return (res?.Serialized ?? res).serializedID;
}

// ── commands ─────────────────────────────────────────────────────────────────
const commands = {
  async 'auth-url'() {
    const state = randomBytes(8).toString('hex');
    const u = new URL(OAUTH_AUTHORIZE);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', env('LS_CLIENT_ID'));
    u.searchParams.set('scope', SCOPE);
    u.searchParams.set('state', state);
    // redirect_uri must match the one registered with the client
    if (process.env.LS_REDIRECT_URI) u.searchParams.set('redirect_uri', process.env.LS_REDIRECT_URI);
    console.log('\nOpen this in a browser, sign in as a Lightspeed admin, approve:\n');
    console.log(u.toString());
    console.log(`\nThen: node ls-poc.mjs exchange <code>   (state should be ${state})\n`);
  },

  async exchange() {
    const code = positional[0];
    if (!code) throw new Error('usage: exchange <code>');
    const j = await tokenRequest({
      client_id: env('LS_CLIENT_ID'), client_secret: env('LS_CLIENT_SECRET'),
      code, grant_type: 'authorization_code',
      ...(process.env.LS_REDIRECT_URI ? { redirect_uri: process.env.LS_REDIRECT_URI } : {}),
    });
    accessToken = j.access_token; refreshToken = j.refresh_token;
    const acct = await api('GET', `${API}/Account.json`);
    const accountID = acct?.Account?.accountID ?? list(acct, 'Account')[0]?.accountID;
    console.log('\nAdd these to .env:\n');
    console.log(`LS_ACCESS_TOKEN=${accessToken}`);
    console.log(`LS_REFRESH_TOKEN=${refreshToken}`);
    console.log(`LS_ACCOUNT_ID=${accountID}`);
    console.log(`\nAccess token expires in ${j.expires_in}s; scope granted: ${j.scope ?? SCOPE}\n`);
  },

  async refresh() { await refresh(); },

  async whoami() {
    const acct = await api('GET', `${API}/Account.json`);
    console.log('\nAccount:', acct?.Account?.name ?? acct);
    console.log('\nShops:');
    table(list(await api('GET', 'Shop.json'), 'Shop').map(s => ({ shopID: s.shopID, name: s.name, timeZone: s.timeZone })));
    console.log('\nEmployees (first 100):');
    table(list(await api('GET', 'Employee.json?limit=100'), 'Employee')
      .map(e => ({ employeeID: e.employeeID, name: `${e.firstName} ${e.lastName}`, archived: e.archived })));
    console.log('\nWork order statuses:');
    table(list(await api('GET', 'WorkorderStatus.json'), 'WorkorderStatus')
      .map(s => ({ workorderStatusID: s.workorderStatusID, name: s.name, sortOrder: s.sortOrder })));
  },

  async 'find-customer'() {
    const q = args.last || positional[0];
    if (!q) throw new Error('usage: find-customer --last <lastName>');
    const res = await api('GET', `Customer.json?lastName=~,%25${encodeURIComponent(q)}%25&load_relations=${encodeURIComponent('["Contact"]')}&limit=50`);
    table(list(res, 'Customer').map(c => ({
      customerID: c.customerID,
      name: `${c.firstName} ${c.lastName}`,
      email: list(c.Contact?.Emails, 'ContactEmail')[0]?.address ?? '',
      phone: list(c.Contact?.Phones, 'ContactPhone')[0]?.number ?? '',
    })));
  },

  async 'create-customer'() {
    const { first, last, email, phone } = args;
    if (!first || !last) throw new Error('usage: create-customer --first F --last L [--email e] [--phone +1...]');
    const body = {
      firstName: first, lastName: last,
      Contact: {
        ...(email ? { Emails: { ContactEmail: [{ address: email, useType: 'Primary' }] } } : {}),
        ...(phone ? { Phones: { ContactPhone: [{ number: phone, useType: 'Mobile' }] } } : {}),
      },
    };
    const res = await api('POST', 'Customer.json', body);
    console.log('\nCreated customerID:', res?.Customer?.customerID, '\n');
  },

  // The "Customer Item" block on a work order (Description / Color / Size / Serial) is a separate
  // Serialized record linked via workorder.serializedID.
  async 'create-serialized'() {
    const id = await createSerialized(args);
    console.log('\nCreated serializedID:', id, '\n');
  },

  async 'create-workorder'() {
    const { shop, customer, employee, status, eta, note, hookin, sale } = args;
    let { serialized } = args;
    if (!shop || !customer || !status) throw new Error('usage: create-workorder --shop ID --customer ID --status ID [--employee ID] [--eta ISO] [--note ...] [--hookin ...] [--sale ID] [--serialized ID | --desc "Model" --color "Colour" --size "Size" [--serial SN]]');
    if (!serialized && (args.desc || args.color || args.size || args.serial)) {
      serialized = await createSerialized({ ...args, customer });
      console.error('Created serializedID', serialized, 'for the Customer Item block');
    }
    const body = {
      shopID: Number(shop),
      customerID: Number(customer),
      workorderStatusID: Number(status),
      ...(employee ? { employeeID: Number(employee) } : {}),
      timeIn: new Date().toISOString(),
      ...(eta ? { etaOut: eta } : {}),
      ...(hookin ? { hookIn: hookin } : {}),
      note: note || 'PICKUP — test work order from ls-poc.mjs',
      internalNote: `Created by ls-poc.mjs at ${new Date().toISOString()}`,
      warranty: false,
      ...(sale ? { saleID: Number(sale) } : {}),
      ...(serialized ? { serializedID: Number(serialized) } : {}),
    };
    console.error('POST Workorder.json', JSON.stringify(body, null, 2));
    const res = await api('POST', 'Workorder.json', body);
    const wo = res?.Workorder ?? res;
    console.log('\n✅ Created work order');
    console.log('   workorderID :', wo.workorderID);
    console.log('   status      :', wo.workorderStatusID);
    console.log('   etaOut      :', wo.etaOut);
    console.log('   timeIn      :', wo.timeIn);
    console.log('\nNow open Service › Work Orders in Lightspeed and find this ID; check the work-order calendar feed for the ETA Out date.\n');
  },

  async 'update-workorder'() {
    const id = positional[0];
    if (!id) throw new Error('usage: update-workorder <workorderID> [--status ID] [--eta ISO] [--note ...] [--hookout ...] [--serialized ID]');
    const body = {
      ...(args.status ? { workorderStatusID: Number(args.status) } : {}),
      ...(args.eta ? { etaOut: args.eta } : {}),
      ...(args.note ? { note: args.note } : {}),
      ...(args.hookout ? { hookOut: args.hookout } : {}),
      ...(args.serialized ? { serializedID: Number(args.serialized) } : {}),
    };
    const res = await api('PUT', `Workorder/${id}.json`, body);
    const wo = res?.Workorder ?? res;
    console.log('\n✅ Updated work order', wo.workorderID, '→ status', wo.workorderStatusID, '· etaOut', wo.etaOut, '\n');
  },

  async 'get-workorder'() {
    const id = positional[0];
    if (!id) throw new Error('usage: get-workorder <workorderID>');
    const res = await api('GET', `Workorder/${id}.json?load_relations=${encodeURIComponent('["WorkorderStatus","Customer"]')}`);
    console.log(JSON.stringify(res, null, 2));
  },

  async 'list-workorders'() {
    // Recently changed work orders for a shop — the shape an hourly sync (see SPEC.md §12, R-Series
    // "Later" column; R-Series has no webhooks) would poll.
    const { shop, since } = args;
    if (!shop) throw new Error('usage: list-workorders --shop ID [--since ISO]');
    const q = new URLSearchParams({ shopID: shop, limit: '50', orderby: 'timeStamp', orderby_desc: '1' });
    if (since) q.set('timeStamp', `>,${since}`);
    q.set('load_relations', '["WorkorderStatus"]');
    const res = await api('GET', `Workorder.json?${q}`);
    table(list(res, 'Workorder').map(w => ({
      workorderID: w.workorderID, customerID: w.customerID, status: w.WorkorderStatus?.name ?? w.workorderStatusID,
      etaOut: w.etaOut, timeStamp: w.timeStamp,
    })));
  },
};

// ── run ──────────────────────────────────────────────────────────────────────
if (!cmd || !commands[cmd]) {
  console.log(`\nls-poc.mjs — commands:\n  ${Object.keys(commands).join('\n  ')}\n\nSee the header of this file for the step-by-step.\n`);
  process.exit(cmd ? 1 : 0);
}
commands[cmd]().catch(e => { console.error('\n❌', e.message, '\n'); process.exit(1); });
