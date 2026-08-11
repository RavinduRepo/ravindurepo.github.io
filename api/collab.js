/**
 * OminiNote collaboration relay — METADATA ONLY.
 *
 * One Vercel serverless function at `https://omininote.com/api/collab`.
 *
 * Notes never touch this service. Note content lives in each participant's own
 * Google Drive as "anyone with the link" files and moves Drive-to-Drive. All
 * that is stored here is the handshake Drive itself cannot carry:
 *
 *   who joined a share · what role they have · the Drive file id of their
 *   published channel index · when they were last seen
 *
 * Why it must exist: under the `drive.file` OAuth scope (non-sensitive, no CASA
 * security assessment) an app may only touch files *that same user* created
 * with it. A folder the owner shares with a guest is invisible to the guest's
 * app, and a guest can never write a byte into the owner's Drive. So there is
 * no Drive-native channel for "I joined, here is my channel id". That single
 * fact is all this replaces.
 *
 * ## Deliberately boring plumbing
 *
 * - **CommonJS, no npm dependencies.** Storage is Upstash Redis over its REST
 *   API called with Node's built-in `fetch`, so the site stays a static repo
 *   with no install and no build step.
 * - **One file, one URL, an `action` field** — no `[...catch-all]` filenames and
 *   no rewrites. An earlier version used `api/collab/[...path].js`; Vercel
 *   decided the whole `api` folder was static content and happily served
 *   `api/README.md` as a web page while every endpoint 404'd. Routing magic is
 *   not worth that failure mode, so the only route here is the file itself.
 *
 * Security model: capability secrets, no accounts.
 *   joinKey      — in the invite link. Lets you join and read the roster.
 *   ownerSecret  — never leaves the owner's device. Required for every mutation.
 *   memberSecret — issued at join. Lets that member heartbeat and read roster.
 * Secrets are stored SHA-256 hashed; a database dump alone cannot join a share.
 */

const { createHash, randomUUID } = require('crypto');

const MAX_MEMBERS = 60;
const MAX_BODY_BYTES = 16 * 1024;
const SHARE_TTL_SECONDS = 60 * 60 * 24 * 400; // ~13 months of inactivity

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  let body;
  try {
    body = readBody(req);
  } catch (e) {
    return json(res, 400, { ok: false, error: String(e.message || e) });
  }

  // GET with no action is the health probe — handy to paste in a browser.
  const action =
    str(body.action, 40) || str(req.query && req.query.action, 40) || 'health';

  try {
    switch (action) {
      case 'health':
        return json(res, 200, { ok: true, service: 'omininote-collab', v: 1 });
      case 'share':
        return await createOrUpdateShare(res, body);
      case 'invite':
        return await recordInvite(res, body);
      case 'join':
        return await join(res, body);
      case 'roster':
        return await roster(res, body);
      case 'heartbeat':
        return await heartbeat(res, body);
      case 'member':
        return await updateMember(res, body);
      case 'leave':
        return await leaveSelf(res, body);
      case 'close':
        return await closeShare(res, body);
      default:
        return json(res, 404, { ok: false, error: 'unknown_action' });
    }
  } catch (e) {
    return json(res, 500, {
      ok: false,
      error: 'server_error',
      detail: String((e && e.message) || e),
    });
  }
};

// ── storage (Upstash Redis REST — no SDK, just fetch) ───────────────────────

/**
 * Accept every spelling the Vercel integration and a direct Upstash signup have
 * used, so a working install is never one renamed variable away from a 500.
 */
function redisConfig() {
  const env = process.env;
  const url =
    env.KV_REST_API_URL ||
    env.UPSTASH_REDIS_REST_URL ||
    env.REDIS_REST_API_URL;
  const token =
    env.KV_REST_API_TOKEN ||
    env.UPSTASH_REDIS_REST_TOKEN ||
    env.REDIS_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error(
      'no_redis_credentials: add UPSTASH_REDIS_REST_URL and ' +
        'UPSTASH_REDIS_REST_TOKEN in Vercel → Settings → Environment ' +
        'Variables, then redeploy',
    );
  }
  return { url: url.replace(/\/+$/, ''), token };
}

async function redis(command) {
  const { url, token } = redisConfig();
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!resp.ok) throw new Error(`redis ${resp.status}: ${await resp.text()}`);
  const out = await resp.json();
  if (out.error) throw new Error(`redis: ${out.error}`);
  return out.result;
}

const keyFor = (shareId) => `share:${shareId}`;

async function loadShare(shareId) {
  if (!shareId || typeof shareId !== 'string' || shareId.length > 128) {
    return null;
  }
  const raw = await redis(['GET', keyFor(shareId)]);
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function saveShare(shareId, share) {
  share.updatedAt = Date.now();
  await redis([
    'SET',
    keyFor(shareId),
    JSON.stringify(share),
    'EX',
    String(SHARE_TTL_SECONDS),
  ]);
}

// ── helpers ─────────────────────────────────────────────────────────────────

function json(res, status, payload) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // The roster changes on a human timescale but must never be served stale by
  // a CDN — the client already rate-limits how often it asks.
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).send(JSON.stringify(payload));
}

function readBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === 'object') return b;
  if (typeof b === 'string') {
    if (b.length > MAX_BODY_BYTES) throw new Error('body_too_large');
    return b ? JSON.parse(b) : {};
  }
  return {};
}

const sha256 = (v) => createHash('sha256').update(String(v)).digest('hex');

/** Length-checked compare of two hex digests. */
function hashEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const cleanEmail = (v) =>
  typeof v === 'string' && v.includes('@') ? v.trim().toLowerCase() : null;

const cleanRole = (v) => (v === 'writer' ? 'writer' : 'reader');

const str = (v, max = 200) =>
  typeof v === 'string' && v.length ? v.slice(0, max) : null;

/** Member id is derived, never client-chosen: email if known, else device. */
const memberIdOf = ({ email, deviceId }) =>
  email ? `e:${email}` : `d:${String(deviceId || '').slice(0, 80)}`;

/**
 * Does [secret] authenticate as [m]? Accepts any of the member's per-device
 * secrets, and the legacy single hash written before per-device secrets existed.
 */
function memberSecretOk(m, hash) {
  if (!m) return false;
  if (m.memberSecretHash && hashEquals(m.memberSecretHash, hash)) return true;
  for (const stored of Object.values(m.secrets || {})) {
    if (hashEquals(stored, hash)) return true;
  }
  return false;
}

/** Public view of a member — no secrets ever leave this function. */
const publicMember = (id, m) => ({
  id,
  email: m.email ?? null,
  name: m.name ?? null,
  role: m.role,
  indexFileId: m.indexFileId ?? null,
  deviceId: m.deviceId ?? null,
  joinedAt: m.joinedAt ?? null,
  lastSeenAt: m.lastSeenAt ?? null,
});

function rosterPayload(share) {
  const members = Object.entries(share.members || {}).map(([id, m]) =>
    publicMember(id, m),
  );
  // People invited by email who have not opened the invite yet — this is the
  // "did they accept?" signal the owner's People list shows.
  const joined = new Set(members.map((m) => m.email).filter(Boolean));
  const invited = Object.entries(share.invites || {})
    .filter(([email]) => !joined.has(email))
    .map(([email, inv]) => ({ email, role: inv.role, invitedAt: inv.at }));
  return {
    ok: true,
    shareId: share.shareId,
    notebookId: share.notebookId ?? null,
    name: share.name ?? null,
    ownerEmail: share.ownerEmail ?? null,
    ownerName: share.ownerName ?? null,
    ownerIndexFileId: share.ownerIndexFileId ?? null,
    defaultRole: share.defaultRole ?? 'reader',
    members,
    invited,
  };
}

// ── actions ─────────────────────────────────────────────────────────────────

/**
 * Owner creates a share, or refreshes its published channel id / metadata.
 * First call defines the secrets; later calls must present `ownerSecret`.
 */
async function createOrUpdateShare(res, body) {
  const shareId = str(body.shareId, 128);
  const joinKey = str(body.joinKey, 128);
  const ownerSecret = str(body.ownerSecret, 128);
  if (!shareId || !joinKey || !ownerSecret) {
    return json(res, 400, { ok: false, error: 'missing_fields' });
  }

  let share = await loadShare(shareId);
  if (share) {
    if (!hashEquals(share.ownerSecretHash, sha256(ownerSecret))) {
      return json(res, 403, { ok: false, error: 'forbidden' });
    }
  } else {
    share = {
      shareId,
      createdAt: Date.now(),
      ownerSecretHash: sha256(ownerSecret),
      joinKeyHash: sha256(joinKey),
      members: {},
      invites: {},
    };
  }

  // Rotating the join key invalidates every invite link handed out so far.
  if (body.rotateJoinKey === true) share.joinKeyHash = sha256(joinKey);

  share.notebookId = str(body.notebookId, 128) ?? share.notebookId ?? null;
  share.name = str(body.name, 200) ?? share.name ?? null;
  share.ownerEmail = cleanEmail(body.ownerEmail) ?? share.ownerEmail ?? null;
  share.ownerName = str(body.ownerName, 120) ?? share.ownerName ?? null;
  share.ownerIndexFileId =
    str(body.ownerIndexFileId, 128) ?? share.ownerIndexFileId ?? null;
  share.defaultRole = body.defaultRole
    ? cleanRole(body.defaultRole)
    : share.defaultRole ?? 'reader';

  await saveShare(shareId, share);
  return json(res, 200, rosterPayload(share));
}

/** Owner records "I invited this email as <role>" so join auto-assigns it. */
async function recordInvite(res, body) {
  const share = await loadShare(str(body.shareId, 128));
  if (!share) return json(res, 404, { ok: false, error: 'not_found' });
  if (!hashEquals(share.ownerSecretHash, sha256(body.ownerSecret))) {
    return json(res, 403, { ok: false, error: 'forbidden' });
  }
  const email = cleanEmail(body.email);
  if (!email) return json(res, 400, { ok: false, error: 'bad_email' });

  share.invites = share.invites || {};
  share.invites[email] = { role: cleanRole(body.role), at: Date.now() };

  // Re-inviting someone who already joined updates their role in place.
  const existing = share.members && share.members[`e:${email}`];
  if (existing) {
    existing.role = cleanRole(body.role);
    if (existing.role === 'reader') existing.indexFileId = null;
  }

  await saveShare(share.shareId, share);
  return json(res, 200, rosterPayload(share));
}

/**
 * Guest joins with the invite link's `joinKey`. Idempotent: re-joining from the
 * same account/device updates that member rather than adding a duplicate.
 */
async function join(res, body) {
  const share = await loadShare(str(body.shareId, 128));
  if (!share) return json(res, 404, { ok: false, error: 'not_found' });
  if (!hashEquals(share.joinKeyHash, sha256(body.joinKey))) {
    return json(res, 403, { ok: false, error: 'forbidden' });
  }

  // The client offers every account connected on its device, because only this
  // side knows which one the owner invited. Prefer an address that has a
  // recorded invite (or is already a member); fall back to the first offered.
  // Guessing on the client joined multi-account devices under the wrong Gmail.
  const offered = [
    cleanEmail(body.email),
    ...(Array.isArray(body.emails) ? body.emails.slice(0, 10) : []).map(
      cleanEmail,
    ),
  ].filter(Boolean);
  const email =
    offered.find(
      (e) =>
        (share.invites && share.invites[e]) ||
        (share.members && share.members[`e:${e}`]),
    ) ||
    offered[0] ||
    null;

  const deviceId = str(body.deviceId, 80);
  if (!email && !deviceId) {
    return json(res, 400, { ok: false, error: 'missing_identity' });
  }

  const id = memberIdOf({ email, deviceId });
  share.members = share.members || {};
  const prev = share.members[id];
  if (!prev && Object.keys(share.members).length >= MAX_MEMBERS) {
    return json(res, 409, { ok: false, error: 'too_many_members' });
  }

  // Role precedence: an explicit invite for this email wins, then whatever the
  // owner already set for this member, then the share default. A guest can
  // never pick their own role.
  const invited = email && share.invites ? share.invites[email] : null;
  const role =
    (prev && prev.role) ||
    (invited ? invited.role : share.defaultRole || 'reader');

  const memberSecret = randomUUID().replace(/-/g, '');
  const now = Date.now();
  // One secret **per device**, not one per member. A person may use the same
  // Google account on a phone and a tablet; with a single hash, the second
  // device's join overwrote the first's secret, the first's next roster read
  // came back 403, and it silently dropped a working share.
  const secrets = { ...((prev && prev.secrets) || {}) };
  secrets[deviceId || 'default'] = sha256(memberSecret);
  share.members[id] = {
    email,
    deviceId,
    name: str(body.name, 120) ?? (prev && prev.name) ?? null,
    role,
    indexFileId:
      role === 'writer'
        ? str(body.indexFileId, 128) ?? (prev && prev.indexFileId) ?? null
        : null,
    joinedAt: (prev && prev.joinedAt) || now,
    lastSeenAt: now,
    secrets,
  };

  await saveShare(share.shareId, share);
  return json(res, 200, {
    ...rosterPayload(share),
    memberId: id,
    memberSecret,
    role,
  });
}

/** Member reads the roster (to discover peer channels). Owner uses ownerSecret. */
async function roster(res, body) {
  const share = await loadShare(str(body.shareId, 128));
  if (!share) return json(res, 404, { ok: false, error: 'not_found' });

  const hash = sha256(body.secret || '');
  if (hashEquals(share.ownerSecretHash, hash)) {
    return json(res, 200, rosterPayload(share));
  }
  const m = share.members && share.members[str(body.memberId, 160) || ''];
  // Two different situations, and the client must not confuse them: the member
  // is gone (the owner removed them → drop the local binding) versus the secret
  // does not match (stale or wrong → a plumbing problem, keep the share).
  if (!m) return json(res, 403, { ok: false, error: 'revoked' });
  if (!memberSecretOk(m, hash)) {
    return json(res, 403, { ok: false, error: 'forbidden' });
  }
  return json(res, 200, rosterPayload(share));
}

/** Member refreshes lastSeen and (writers) their published channel id. */
async function heartbeat(res, body) {
  const share = await loadShare(str(body.shareId, 128));
  if (!share) return json(res, 404, { ok: false, error: 'not_found' });

  const m = share.members && share.members[str(body.memberId, 160) || ''];
  if (!m) return json(res, 403, { ok: false, error: 'forbidden' });
  if (!memberSecretOk(m, sha256(body.memberSecret))) {
    return json(res, 403, { ok: false, error: 'forbidden' });
  }

  m.lastSeenAt = Date.now();
  if (m.role === 'writer' && str(body.indexFileId, 128)) {
    m.indexFileId = str(body.indexFileId, 128);
  }
  if (str(body.name, 120)) m.name = str(body.name, 120);

  await saveShare(share.shareId, share);
  return json(res, 200, rosterPayload(share));
}

/** Owner changes a member's role, or removes them. */
async function updateMember(res, body) {
  const share = await loadShare(str(body.shareId, 128));
  if (!share) return json(res, 404, { ok: false, error: 'not_found' });
  if (!hashEquals(share.ownerSecretHash, sha256(body.ownerSecret))) {
    return json(res, 403, { ok: false, error: 'forbidden' });
  }

  const memberId = str(body.memberId, 160) || '';
  const m = share.members && share.members[memberId];
  if (!m) return json(res, 404, { ok: false, error: 'no_member' });

  if (body.remove === true) {
    delete share.members[memberId];
    if (m.email && share.invites) delete share.invites[m.email];
  } else {
    m.role = cleanRole(body.role);
    // A demoted writer stops being polled for contributions.
    if (m.role === 'reader') m.indexFileId = null;
    if (m.email && share.invites && share.invites[m.email]) {
      share.invites[m.email].role = m.role;
    }
  }

  await saveShare(share.shareId, share);
  return json(res, 200, rosterPayload(share));
}

/** Member removes themselves, authenticated by their own member secret. */
async function leaveSelf(res, body) {
  const share = await loadShare(str(body.shareId, 128));
  if (!share) return json(res, 200, { ok: true });

  const memberId = str(body.memberId, 160) || '';
  const m = share.members && share.members[memberId];
  if (!m) return json(res, 200, { ok: true });
  if (!memberSecretOk(m, sha256(body.memberSecret))) {
    return json(res, 403, { ok: false, error: 'forbidden' });
  }

  // Leave the owner's invite intact — they invited this person, and leaving is
  // not the same as being removed. Re-tapping the link rejoins.
  delete share.members[memberId];
  await saveShare(share.shareId, share);
  return json(res, 200, { ok: true });
}

/** Owner stops sharing entirely — everyone's roster reads start failing. */
async function closeShare(res, body) {
  const share = await loadShare(str(body.shareId, 128));
  if (!share) return json(res, 200, { ok: true });
  if (!hashEquals(share.ownerSecretHash, sha256(body.ownerSecret))) {
    return json(res, 403, { ok: false, error: 'forbidden' });
  }
  await redis(['DEL', keyFor(share.shareId)]);
  return json(res, 200, { ok: true });
}
