// FlashPass MCP server. FlashPass is a PRADO (PHP) app: no JSON API, every action is
// GET page -> POST same page with all form fields + PRADO_PAGESTATE + PRADO_POSTBACK_TARGET.
// Browser (Playwright) is used ONLY for login (Cloudflare Turnstile); everything else is plain fetch.
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { parse, type HTMLElement } from 'node-html-parser';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const DIR = new URL('.', import.meta.url).pathname;
const ORIGIN = 'https://flashpass.net';
const P = 'ctl0$ContentPlaceHolder$';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0 Safari/537.36';
const COOKIE_FILE = `${DIR}auth/cookie.txt`;

// Credentials: env vars (e.g. from the MCP client config) win; otherwise ./.env next to this file.
try { process.loadEnvFile(`${DIR}.env`); } catch {}
const { FLASHPASS_USER = '', FLASHPASS_PASS = '' } = process.env;
if (!FLASHPASS_USER || !FLASHPASS_PASS) {
  console.error('Set FLASHPASS_USER and FLASHPASS_PASS (env vars or .env next to server.ts).');
  process.exit(1);
}
let cookie = (() => { try { return readFileSync(COOKIE_FILE, 'utf8').trim(); } catch { return ''; } })();

/** Log in with a real (headless) browser and keep only the PHPSESSID cookie. */
async function login() {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch(process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : { channel: 'chrome' }); // ponytail: system Chrome, headless
  try {
    const page = await browser.newPage({ userAgent: UA });
    await page.goto(ORIGIN, { waitUntil: 'load' });
    await page.fill('[name="ctl0$ctl2$Username"]', FLASHPASS_USER);
    await page.fill('[name="ctl0$ctl2$Password"]', FLASHPASS_PASS);
    await Promise.all([page.waitForURL(/subscriber/, { timeout: 30000 }), page.press('[name="ctl0$ctl2$Password"]', 'Enter')]);
    const sid = (await page.context().cookies(ORIGIN)).find(c => c.name === 'PHPSESSID');
    if (!sid) throw new Error('FlashPass login failed (no session cookie)');
    cookie = `PHPSESSID=${sid.value}`;
    mkdirSync(`${DIR}auth`, { recursive: true });
    writeFileSync(COOKIE_FILE, cookie, { mode: 0o600 });
  } finally { await browser.close(); }
}

/** GET or POST a page; re-logs in once if the session expired. Returns final URL + parsed DOM. */
async function http(page: string, body?: URLSearchParams, retry = true): Promise<{ url: string; doc: HTMLElement }> {
  if (!cookie) await login();
  const res = await fetch(`${ORIGIN}/index.php?page=${page}`, {
    method: body ? 'POST' : 'GET', body,
    headers: { cookie, 'user-agent': UA, referer: `${ORIGIN}/index.php?page=${page}`, ...(body && { 'content-type': 'application/x-www-form-urlencoded' }) },
  });
  const html = await res.text();
  if (!html.includes('Log Out')) {
    if (!retry || body) throw new Error(`Not logged in after ${body ? 'POST' : 'GET'} ${page} (HTTP ${res.status}). Session may have expired mid-postback; retry.`);
    await login();
    return http(page, body, false);
  }
  return { url: res.url, doc: parse(html) };
}

const txt = (s?: string) => (s || '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const formOf = (doc: HTMLElement) => doc.querySelector('form')!;

/** Serialize the form exactly like a browser would (no buttons; only checked radios/checkboxes). */
function serialize(doc: HTMLElement) {
  const out = new URLSearchParams();
  for (const el of formOf(doc).querySelectorAll('input,select,textarea')) {
    const name = el.getAttribute('name');
    if (!name || el.hasAttribute('disabled')) continue;
    const tag = el.tagName, type = (el.getAttribute('type') || 'text').toLowerCase();
    if (tag === 'SELECT') {
      const opts = el.querySelectorAll('option');
      const sel = opts.find(o => o.hasAttribute('selected')) || opts[0];
      if (sel) out.set(name, sel.getAttribute('value') ?? txt(sel.text));
    } else if (tag === 'TEXTAREA') out.set(name, el.text);
    else if (['submit', 'image', 'button', 'reset', 'file'].includes(type)) continue;
    else if (type === 'checkbox' || type === 'radio') { if (el.hasAttribute('checked')) out.append(name, el.getAttribute('value') ?? 'on'); }
    else out.set(name, el.getAttribute('value') ?? '');
  }
  return out;
}

/** Map a human value ("Mexico", "Pax", "N12345") to the option value of a <select>. Raw values pass through. */
function optionValue(doc: HTMLElement, name: string, want: string) {
  const sel = formOf(doc).querySelector(`select[name="${name}"]`);
  if (!sel) return want;
  const opts = sel.querySelectorAll('option').map(o => ({ v: o.getAttribute('value') ?? '', t: txt(o.text).toLowerCase() }));
  const w = want.trim().toLowerCase();
  const hit = opts.find(o => o.v === want) || opts.find(o => o.t === w) || (() => {
    const m = opts.filter(o => o.t.startsWith(w) || o.t.includes(w));
    return m.length === 1 ? m[0] : undefined;
  })();
  if (!hit) throw new Error(`"${want}" is not a valid option for ${name.replace(P, '')}. Options include: ${opts.slice(0, 15).map(o => o.t).join(', ')}…`);
  return hit.v;
}

/** One PRADO postback: current form state + overrides, "clicking" `target`. */
async function postback(page: string, doc: HTMLElement, fields: Record<string, string | undefined>, target: string) {
  const body = serialize(doc);
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) body.set(P + k, optionValue(doc, P + k, v));
  body.set('PRADO_POSTBACK_TARGET', target);
  const btn = formOf(doc).querySelector(`input[type=submit][name="${target}"]`);
  if (btn) body.set(target, btn.getAttribute('value') || '');
  return http(page, body);
}

/** Visible validation/error messages on a page (PRADO renders failed validators without display:none). */
const errors = (doc: HTMLElement) => [...new Set(doc.querySelectorAll('span[id*=Validator],span[id*=validator],.error,.errors,.message-error')
  .filter(e => !/display:\s*none/i.test(e.getAttribute('style') || '')).map(e => txt(e.text)).filter(Boolean))];

/** Read the page's main DataGrid into objects keyed by column header, with `id` from the row's links. */
function grid(doc: HTMLElement) {
  const t = doc.querySelector('#ctl0_ContentPlaceHolder_DataGrid');
  if (!t) return [];
  const [head, ...rows] = t.querySelectorAll('tr');
  if (!head) return [];
  const cols = head.querySelectorAll('td,th').map(c => txt(c.text));
  return rows.map(r => {
    const cells = r.querySelectorAll('td');
    const o: Record<string, string> = {};
    cols.forEach((c, i) => { if (c) o[c] = txt(cells[i]?.text); });
    const id = r.innerHTML.match(/[?;]id=(\d+)/)?.[1];
    if (id) o.id = id;
    return o;
  });
}

/** Read a form as { FieldName: value }, showing select labels instead of numeric ids. */
function readForm(doc: HTMLElement) {
  const o: Record<string, string> = {};
  for (const el of formOf(doc).querySelectorAll('input,select')) {
    const name = el.getAttribute('name') || '';
    if (!name.startsWith(P) || /Refresh|Occupant|Duty|Address|Hidden|ctl\d/.test(name.slice(P.length))) continue;
    const k = name.slice(P.length), type = el.getAttribute('type');
    if (el.tagName === 'SELECT') {
      const opt = el.querySelectorAll('option').find(x => x.hasAttribute('selected'));
      if (opt && opt.getAttribute('value') !== '0') o[k] = txt(opt.text);
    } else if (type === 'radio') { if (el.hasAttribute('checked')) o[k] = el.getAttribute('value') || ''; }
    else if (type !== 'submit' && type !== 'image' && el.getAttribute('value')) o[k] = el.getAttribute('value')!;
  }
  return o;
}

// ponytail: global lock (one postback chain at a time); PRADO page state is per-request so this is just politeness.
let lock = Promise.resolve();
const serial = <T>(fn: () => Promise<T>) => { const p = lock.then(fn); lock = p.then(() => {}, () => {}); return p; };

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const fail = (msg: string) => ({ isError: true, content: [{ type: 'text' as const, text: msg }] });

/** Click Save; success = PRADO navigated away from the Add/Edit page. */
async function save(page: string, doc: HTMLElement, fields: Record<string, string | undefined>) {
  const r = await postback(page, doc, fields, `${P}Save`);
  const stayed = /\.(Add|Edit)/.test(new URL(r.url).searchParams.get('page') || '');
  return { ...r, saved: !stayed, errors: stayed ? errors(r.doc) : [] };
}

// ---------- schemas (keys are the real FlashPass field names) ----------
const s = (d: string) => z.string().optional().describe(d);
const COUNTRY = 'Country name, e.g. "Mexico", "United States", "Panama"';
const DATE = 'MM/DD/YYYY';
const person = z.object({
  FirstName: s('First name'), MiddleName: s('Middle name'), LastName: s('Last name(s)'),
  BirthDate: s(DATE), Sex: z.enum(['M', 'F']).optional(),
  BirthCity: s('City of birth'), BirthState: s('State of birth (code ok, e.g. BC)'), BirthCountry: s(COUNTRY),
  ResidenceCountry: s(COUNTRY), CitizenshipCountry: s(COUNTRY), Description: s('Free-text note'),
  Phone: s('Phone'), Email: s('E-mail'), Street: s('Street address'), City: s('City'), State: s('State'), PostalCode: s('Postal code'), Country: s(COUNTRY),
  DocumentType1: s('e.g. "Passport", "No document provided", "NEXUS Card"'), DocumentNumber1: s('Document number'), DocumentCountry1: s(COUNTRY), DocumentExpiration1: s(DATE),
  DocumentType2: s('Second document type'), DocumentNumber2: s('Number'), DocumentCountry2: s(COUNTRY), DocumentExpiration2: s(DATE),
}).describe('Person fields; omit any you are not setting/changing');

const flight = z.object({
  Name: s('Flight description, e.g. "MMTJ-KSAN N12345 1 Dec 2026"'), Aircraft: s('Tail number, e.g. N12345'),
  DepartureAirport: s('ICAO, e.g. MMTJ'), DepartureCity: s('City'), DepartureState: s('State code'), DepartureCountry: s(COUNTRY),
  DepartureDate: s(DATE), DepartureTime: s('Local, HHMM e.g. 0800'), Duration: s('Duration'), DeparturePlace: s('e.g. "Tijuana Intl (MMTJ)"'),
  ArrivalAirport: s('ICAO'), ArrivalCity: s('City'), ArrivalState: s('State code'), ArrivalCountry: s(COUNTRY),
  ArrivalDate: s(DATE), ArrivalTime: s('Local, HHMM'), ArrivalPlace: s('Place description'),
  EmergencyContact: s('Person name; must NOT be on the flight (defaults to the account owner)'), BorderCrossing: s('Border crossing'),
  ForeignAirport1: s('ICAO'), ForeignAirport2: s('ICAO'), ForeignAirport3: s('ICAO'), ForeignAirport4: s('ICAO'), ForeignAirport5: s('ICAO'),
}).describe('Manifest flight fields; omit any you are not setting/changing');

const occupant = z.object({
  person: z.string().describe('Person name (as in list_persons) or person id'),
  duty: z.enum(['Pilot', 'Crew', 'Pax']),
  address: z.string().optional().describe('Saved address name, e.g. "Home" (Common Used Addresses)'),
  Street: s('Address while in the USA'), City: s('City'), State: s('US state, e.g. California'), PostalCode: s('Postal code'),
});

/** Add occupants one postback at a time (each AddOccupant returns new page state). */
async function addOccupants(page: string, doc: HTMLElement, flightFields: Record<string, string | undefined>, occ: z.infer<typeof occupant>[]) {
  for (const o of occ) {
    const before = grid(doc).length;
    const r = await postback(page, doc, { ...flightFields, Occupant: o.person, Duty: o.duty, Address: o.address, Street: o.Street, City: o.City, State: o.State, PostalCode: o.PostalCode }, `${P}AddOccupant`);
    doc = r.doc;
    if (grid(doc).length <= before) throw new Error(`Could not add ${o.person}: ${errors(doc).join('; ') || 'FlashPass did not add the occupant'}`);
  }
  return doc;
}

const server = new McpServer({ name: 'flashpass', version: '1.0.0' });
const RO = { readOnlyHint: true };
const tool = (name: string, description: string, inputSchema: z.ZodObject, fn: (a: any) => Promise<any>, annotations = {}) =>
  server.registerTool(name, { description, inputSchema, annotations }, async (a: any) => {
    try { return await serial(() => fn(a)); } catch (e) { return fail((e as Error).message); }
  });

// ---------- persons ----------
tool('list_persons', 'List saved persons (passengers/crew) with their ids.', z.object({ search: z.string().optional().describe('Name substring filter') }),
  async ({ search }) => ok(grid((await http('subscriber.persons.Home')).doc).filter(p => !search || JSON.stringify(p).toLowerCase().includes(search.toLowerCase()))), RO);

tool('get_person', 'Get all fields of a saved person, including travel documents.', z.object({ id: z.string() }),
  async ({ id }) => ok(readForm((await http(`subscriber.persons.Edit&id=${id}`)).doc)), RO);

tool('create_person', 'Add a new person (passenger/crew) to the FlashPass address book.', z.object({ fields: person }),
  async ({ fields }) => {
    const page = 'subscriber.persons.Add';
    const r = await save(page, (await http(page)).doc, fields);
    if (!r.saved) return fail(`Not saved: ${r.errors.join('; ') || 'unknown validation error'}`);
    const name = `${fields.FirstName ?? ''} ${fields.LastName ?? ''}`.trim().toLowerCase();
    const hit = grid((await http('subscriber.persons.Home')).doc).filter(p => p.Name?.toLowerCase().includes(name)).sort((a, b) => +b.id - +a.id)[0];
    return ok({ saved: true, person: hit });
  });

tool('update_person', 'Change fields of an existing person. Only the fields you pass are changed.', z.object({ id: z.string(), fields: person }),
  async ({ id, fields }) => {
    const page = `subscriber.persons.Edit&id=${id}`;
    const r = await save(page, (await http(page)).doc, fields);
    return r.saved ? ok({ saved: true, person: readForm((await http(page)).doc) }) : fail(`Not saved: ${r.errors.join('; ') || 'unknown validation error'}`);
  });

// ---------- aircraft ----------
tool('list_aircraft', 'List aircraft with ids.', z.object({}), async () => ok(grid((await http('subscriber.aircrafts.Home')).doc)), RO);

tool('update_aircraft', 'Change aircraft fields (Model, Color, CallSign, DecalNumber, Operator, Owner).', z.object({
  id: z.string(), fields: z.object({ TailNumber: s('Tail'), Model: s('e.g. C172'), Color: s('Color'), CallSign: s('Call sign'), DecalNumber: s('CBP decal number'), Operator: s('Person/company name'), Owner: s('Person/company name') }),
}), async ({ id, fields }) => {
  const page = `subscriber.aircrafts.Edit&id=${id}`;
  const r = await save(page, (await http(page)).doc, fields);
  return r.saved ? ok({ saved: true, aircraft: readForm((await http(page)).doc) }) : fail(`Not saved: ${r.errors.join('; ')}`);
});

// ---------- manifests ----------
tool('list_manifests', 'List manifests with id, aircraft, route, leg, status and arrival date.', z.object({}),
  async () => ok(grid((await http('subscriber.manifests.Home')).doc)), RO);

tool('get_manifest', 'Get a manifest: flight fields and occupants (name, duty, US address).', z.object({ id: z.string() }),
  async ({ id }) => {
    const { doc } = await http(`subscriber.manifests.Edit&id=${id}`);
    return ok({ ...readForm(doc), occupants: grid(doc).map(({ Name, Duty, ...rest }) => ({ Name, Duty, address: Object.values(rest)[0] })) });
  }, RO);

tool('create_manifest_draft',
  'Create a new manifest as a DRAFT (saved, NOT submitted to CBP/eAPIS). Submitting stays a manual step on flashpass.net.',
  z.object({ fields: flight, occupants: z.array(occupant).describe('Pilot first, then crew/pax') }),
  async ({ fields, occupants }) => {
    const page = 'subscriber.manifests.Add';
    const doc = await addOccupants(page, (await http(page)).doc, fields, occupants);
    const r = await save(page, doc, fields);
    if (!r.saved) return fail(`Not saved: ${r.errors.join('; ') || 'unknown validation error'}`);
    const m = grid((await http('subscriber.manifests.Home')).doc).filter(x => !fields.Name || x.Name === fields.Name).sort((a, b) => +b.id - +a.id)[0];
    return ok({ saved: true, submitted: false, manifest: m });
  });

tool('update_manifest',
  'Change a manifest: flight fields (aircraft, times, airports…), add and/or remove occupants. Saves only; never submits to CBP. If the manifest was already submitted, it must be re-submitted manually.',
  z.object({
    id: z.string(), fields: flight.optional(),
    add_occupants: z.array(occupant).optional(),
    remove_occupants: z.array(z.string()).optional().describe('Occupant names to remove (as shown by get_manifest)'),
  }),
  async ({ id, fields = {}, add_occupants = [], remove_occupants = [] }) => {
    const page = `subscriber.manifests.Edit&id=${id}`;
    let { doc } = await http(page);
    for (const name of remove_occupants) {
      const row = doc.querySelectorAll('#ctl0_ContentPlaceHolder_DataGrid tr').find(tr => txt(tr.querySelector('td')?.text).toLowerCase() === name.trim().toLowerCase());
      const btn = row?.querySelector('a[id],input[type=submit]');
      if (!btn) throw new Error(`No occupant named "${name}" on this manifest`);
      const target = btn.getAttribute('name') || btn.getAttribute('id')!.replace(/_/g, '$');
      doc = (await postback(page, doc, fields, target)).doc;
    }
    doc = await addOccupants(page, doc, fields, add_occupants);
    const r = await save(page, doc, fields);
    if (!r.saved) return fail(`Not saved: ${r.errors.join('; ') || 'unknown validation error'}`);
    const after = (await http(page)).doc;
    const status = grid((await http('subscriber.manifests.Home')).doc).find(m => m.id === id)?.Status;
    return ok({ saved: true, status, manifest: { ...readForm(after), occupants: grid(after).map(o => `${o.Name} (${o.Duty})`) } });
  });

// ponytail: no delete or submit-to-CBP tools on purpose; add if wanted.
await server.connect(new StdioServerTransport());
