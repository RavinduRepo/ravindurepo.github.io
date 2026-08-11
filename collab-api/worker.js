/**
 * OminiNote collaboration relay — METADATA ONLY.
 *
 * Notes never touch this Worker. Note content lives in the participants' own
 * Google Drives as "anyone with the link" files; this service only stores the
 * handshake that Drive itself cannot carry:
 *
 *   who joined a share · what role they have · the Drive file id of their
 *   published channel index · when they were last seen
 *
 * Why it exists: under the `drive.file` OAuth scope (non-sensitive, no CASA
 * security assessment) an app can only touch files *that same user* created
 * with it. A folder the owner shares with a guest is invisible to the guest's
 * app, and a guest can never write a byte into the owner's Drive. So there is
 * no Drive-native channel for "I joined, here is my channel id". That single
 * fact is all this Worker replaces.
 *
 * Security model: capability secrets, no accounts.
 *   joinKey      — in the invite link. Lets you join and read the roster.
 *   ownerSecret  — never leaves the owner's device. Required to mutate members.
 *   memberSecret — issued at join. Lets that member heartbeat and read roster.
 * Secrets are stored as SHA-256 hashes; a KV dump alone cannot rejoin a share.
 *
 * Deploy:  npx wrangler deploy      (see README.md)
 */

const MAX_MEMBERS = 60;
const MAX_BODY_BYTES = 16 * 1024;
const SHARE_TTL_SECONDS = 60 * 60 * 24 * 400; // ~13 months of inactivity

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      switch (`${request.method} ${path}`) {
        case 'GET /':
        case 'GET /v1/health':
          return json({ ok: true, service: 'omininote-collab-relay', v: 1 });
        case 'POST /v1/share':
          return await createOrUpdateShare(request, env);
        case 'POST /v1/invite':
          return await recordInvite(request, env);
        case 'POST /v1/join':
          return await join(request, env);
        case 'GET /v1/roster':
          return await roster(request, env, url);
        case 'POST /v1/heartbeat':
          return await heartbeat(request, env);
        case 'POST /v1/member':
          return await updateMember(request, env);
        case 'POST /v1/leave':
          return await leaveSelf(request, env);
        case 'POST /v1/close':
          return await closeShare(request, env);
        default:
          return json({ ok: false, error: 'not_found' }, 404);
      }
    } catch (e) {
      return json({ ok: false, error: 'server_error', detail: String(e) }, 500);
    }
  },
};

// ── helpers ─────────────────────────────────────────────────────────────────

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new Error('body_too_large');
  if (!text) return {};
  return JSON.parse(text);
}

async function sha256(value) {
  const data = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Constant-time-ish compare of two equal-length hex digests. */
function hashEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const keyFor = (shareId) => `share:${shareId}`;

async function loadShare(env, shareId) {
  if (!shareId || typeof shareId !== 'string' || shareId.length > 128) {
    return null;
  }
  const raw = await env.COLLAB.get(keyFor(shareId));
  return raw ? JSON.parse(raw) : null;
}

async function saveShare(env, shareId, share) {
  share.updatedAt = Date.now();
  await env.COLLAB.put(keyFor(shareId), JSON.stringify(share), {
    expirationTtl: SHARE_TTL_SECONDS,
  });
}

const cleanEmail = (v) =>
  typeof v === 'string' && v.includes('@') ? v.trim().toLowerCase() : null;

const cleanRole = (v) => (v === 'writer' ? 'writer' : 'reader');

const str = (v, max = 200) =>
  typeof v === 'string' && v.length ? v.slice(0, max) : null;

/** Member id is derived, never client-chosen: email if known, else device. */
function memberIdOf({ email, deviceId }) {
  if (email) return `e:${email}`;
  return `d:${String(deviceId || '').slice(0, 80)}`;
}

/** Public view of a member — no secrets ever leave the Worker. */
function publicMember(id, m) {
  return {
    id,
    email: m.email ?? null,
    name: m.name ?? null,
    role: m.role,
    indexFileId: m.indexFileId ?? null,
    deviceId: m.deviceId ?? null,
    joinedAt: m.joinedAt ?? null,
    lastSeenAt: m.lastSeenAt ?? null,
  };
}

function rosterPayload(share) {
  const members = Object.entries(share.members || {}).map(([id, m]) =>
    publicMember(id, m),
  );
  // People invited by email who have not opened the invite yet.
  const joined = new Set(
    members.map((m) => m.email).filter((e) => typeof e === 'string'),
  );
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
    closed: share.closed === true,
    members,
    invited,
  };
}

// ── endpoints ───────────────────────────────────────────────────────────────

/**
 * Owner creates a share, or refreshes its published channel id / metadata.
 * First call defines the secrets; later calls must present `ownerSecret`.
 */
async function createOrUpdateShare(request, env) {
  const body = await readBody(request);
  const shareId = str(body.shareId, 128);
  const joinKey = str(body.joinKey, 128);
  const ownerSecret = str(body.ownerSecret, 128);
  if (!shareId || !joinKey || !ownerSecret) {
    return json({ ok: false, error: 'missing_fields' }, 400);
  }

  let share = await loadShare(env, shareId);
  if (share) {
    if (!hashEquals(share.ownerSecretHash, await sha256(ownerSecret))) {
      return json({ ok: false, error: 'forbidden' }, 403);
    }
  } else {
    share = {
      shareId,
      createdAt: Date.now(),
      ownerSecretHash: await sha256(ownerSecret),
      joinKeyHash: await sha256(joinKey),
      members: {},
      invites: {},
    };
  }

  // Rotating the join key invalidates every old invite link.
  if (body.rotateJoinKey === true) share.joinKeyHash = await sha256(joinKey);

  share.notebookId = str(body.notebookId, 128) ?? share.notebookId ?? null;
  share.name = str(body.name, 200) ?? share.name ?? null;
  share.ownerEmail = cleanEmail(body.ownerEmail) ?? share.ownerEmail ?? null;
  share.ownerName = str(body.ownerName, 120) ?? share.ownerName ?? null;
  share.ownerIndexFileId =
    str(body.ownerIndexFileId, 128) ?? share.ownerIndexFileId ?? null;
  share.defaultRole = body.defaultRole
    ? cleanRole(body.defaultRole)
    : share.defaultRole ?? 'reader';
  share.closed = false;

  await saveShare(env, shareId, share);
  return json(rosterPayload(share));
}

/** Owner records "I invited this email as <role>" so join auto-assigns it. */
async function recordInvite(request, env) {
  const body = await readBody(request);
  const share = await loadShare(env, str(body.shareId, 128));
  if (!share) return json({ ok: false, error: 'not_found' }, 404);
  if (!hashEquals(share.ownerSecretHash, await sha256(body.ownerSecret))) {
    return json({ ok: false, error: 'forbidden' }, 403);
  }
  const email = cleanEmail(body.email);
  if (!email) return json({ ok: false, error: 'bad_email' }, 400);

  share.invites = share.invites || {};
  share.invites[email] = { role: cleanRole(body.role), at: Date.now() };

  // Re-inviting someone who already joined updates their role in place.
  const existing = share.members?.[`e:${email}`];
  if (existing) {
    existing.role = cleanRole(body.role);
    if (existing.role === 'reader') existing.indexFileId = null;
  }

  await saveShare(env, share.shareId, share);
  return json(rosterPayload(share));
}

/**
 * Guest joins with the invite link's `joinKey`. Idempotent: re-joining from the
 * same account/device updates that member rather than adding a duplicate.
 */
async function join(request, env) {
  const body = await readBody(request);
  const share = await loadShare(env, str(body.shareId, 128));
  if (!share) return json({ ok: false, error: 'not_found' }, 404);
  if (share.closed) return json({ ok: false, error: 'closed' }, 410);
  if (!hashEquals(share.joinKeyHash, await sha256(body.joinKey))) {
    return json({ ok: false, error: 'forbidden' }, 403);
  }

  const email = cleanEmail(body.email);
  const deviceId = str(body.deviceId, 80);
  if (!email && !deviceId) {
    return json({ ok: false, error: 'missing_identity' }, 400);
  }

  const id = memberIdOf({ email, deviceId });
  share.members = share.members || {};
  const prev = share.members[id];
  if (!prev && Object.keys(share.members).length >= MAX_MEMBERS) {
    return json({ ok: false, error: 'too_many_members' }, 409);
  }
  if (prev?.revoked) return json({ ok: false, error: 'revoked' }, 403);

  // Role precedence: an explicit invite for this email wins, then whatever the
  // owner already set for this member, then the share default. A guest can
  // never pick their own role.
  const invited = email ? share.invites?.[email] : null;
  const role = prev?.role ?? (invited ? invited.role : share.defaultRole ?? 'reader');

  const memberSecret = crypto.randomUUID().replaceAll('-', '');
  const now = Date.now();
  share.members[id] = {
    email,
    deviceId,
    name: str(body.name, 120) ?? prev?.name ?? null,
    role,
    indexFileId: role === 'writer'
      ? str(body.indexFileId, 128) ?? prev?.indexFileId ?? null
      : null,
    joinedAt: prev?.joinedAt ?? now,
    lastSeenAt: now,
    memberSecretHash: await sha256(memberSecret),
  };

  await saveShare(env, share.shareId, share);
  return json({ ...rosterPayload(share), memberId: id, memberSecret, role });
}

/** Member reads the roster (to discover peer channels). Owner may use ownerSecret. */
async function roster(request, env, url) {
  const share = await loadShare(env, url.searchParams.get('shareId'));
  if (!share) return json({ ok: false, error: 'not_found' }, 404);

  const secret = url.searchParams.get('secret') || '';
  const memberId = url.searchParams.get('memberId') || '';
  const hash = await sha256(secret);

  if (hashEquals(share.ownerSecretHash, hash)) return json(rosterPayload(share));

  const m = share.members?.[memberId];
  if (!m || m.revoked || !hashEquals(m.memberSecretHash, hash)) {
    return json({ ok: false, error: 'forbidden' }, 403);
  }
  return json(rosterPayload(share));
}

/** Member refreshes lastSeen and (writers) their published channel id. */
async function heartbeat(request, env) {
  const body = await readBody(request);
  const share = await loadShare(env, str(body.shareId, 128));
  if (!share) return json({ ok: false, error: 'not_found' }, 404);

  const memberId = str(body.memberId, 160) ?? '';
  const m = share.members?.[memberId];
  if (!m || m.revoked) return json({ ok: false, error: 'forbidden' }, 403);
  if (!hashEquals(m.memberSecretHash, await sha256(body.memberSecret))) {
    return json({ ok: false, error: 'forbidden' }, 403);
  }

  m.lastSeenAt = Date.now();
  if (m.role === 'writer' && str(body.indexFileId, 128)) {
    m.indexFileId = str(body.indexFileId, 128);
  }
  if (str(body.name, 120)) m.name = str(body.name, 120);

  await saveShare(env, share.shareId, share);
  return json(rosterPayload(share));
}

/** Owner changes a member's role or removes them. */
async function updateMember(request, env) {
  const body = await readBody(request);
  const share = await loadShare(env, str(body.shareId, 128));
  if (!share) return json({ ok: false, error: 'not_found' }, 404);
  if (!hashEquals(share.ownerSecretHash, await sha256(body.ownerSecret))) {
    return json({ ok: false, error: 'forbidden' }, 403);
  }

  const memberId = str(body.memberId, 160) ?? '';
  const m = share.members?.[memberId];
  if (!m) return json({ ok: false, error: 'no_member' }, 404);

  if (body.remove === true) {
    delete share.members[memberId];
    if (m.email) delete share.invites?.[m.email];
  } else {
    m.role = cleanRole(body.role);
    // A demoted writer stops being polled for contributions.
    if (m.role === 'reader') m.indexFileId = null;
    if (m.email && share.invites?.[m.email]) share.invites[m.email].role = m.role;
  }

  await saveShare(env, share.shareId, share);
  return json(rosterPayload(share));
}

/** Member removes themselves, authenticated by their own member secret. */
async function leaveSelf(request, env) {
  const body = await readBody(request);
  const share = await loadShare(env, str(body.shareId, 128));
  if (!share) return json({ ok: true });

  const memberId = str(body.memberId, 160) ?? '';
  const m = share.members?.[memberId];
  if (!m) return json({ ok: true });
  if (!hashEquals(m.memberSecretHash, await sha256(body.memberSecret))) {
    return json({ ok: false, error: 'forbidden' }, 403);
  }

  delete share.members[memberId];
  // Leave the owner's invite intact — they invited this person, and leaving is
  // not the same as being removed. Re-tapping the link rejoins.
  await saveShare(env, share.shareId, share);
  return json({ ok: true });
}

/** Owner stops sharing entirely — everyone's roster reads start failing. */
async function closeShare(request, env) {
  const body = await readBody(request);
  const share = await loadShare(env, str(body.shareId, 128));
  if (!share) return json({ ok: true });
  if (!hashEquals(share.ownerSecretHash, await sha256(body.ownerSecret))) {
    return json({ ok: false, error: 'forbidden' }, 403);
  }
  await env.COLLAB.delete(keyFor(share.shareId));
  return json({ ok: true });
}
