/**
 * OminiNote collab join registry — Cloudflare Worker.
 *
 * Stores ONLY join metadata (email, role, public peer Drive file ids).
 * Never stores notebook content.
 *
 * Auth = invite join secret (capability token, same idea as "anyone with link").
 *
 * Deploy:
 *   1. Cloudflare account (free) → Workers
 *   2. Create KV namespace "COLLAB_ROOMS"
 *   3. wrangler.toml + `npx wrangler deploy`
 *   4. Optional: route collab-api.omininote.com → this worker
 *
 * Endpoints:
 *   POST   /v1/collab/:inviteId/join
 *   GET    /v1/collab/:inviteId/members?secret=
 *   PATCH  /v1/collab/:inviteId/members/:memberId
 *   DELETE /v1/collab/:inviteId/members/:memberId?secret=
 *   DELETE /v1/collab/:inviteId?secret=
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function bad(msg, status = 400) {
  return json({ error: msg }, status);
}

function memberIdFrom(body) {
  const email = (body.email || '').trim().toLowerCase();
  if (email.includes('@')) return `email:${email}`;
  const peer = (body.peerIndexFileId || '').trim();
  if (peer) return `peer:${peer}`;
  return null;
}

async function loadRoom(env, inviteId) {
  const raw = await env.COLLAB_ROOMS.get(`room:${inviteId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveRoom(env, inviteId, room) {
  room.updatedAt = new Date().toISOString();
  await env.COLLAB_ROOMS.put(`room:${inviteId}`, JSON.stringify(room), {
    // 90 days idle rooms expire (re-join recreates)
    expirationTtl: 60 * 60 * 24 * 90,
  });
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    // /v1/collab/:inviteId/...
    if (parts[0] !== 'v1' || parts[1] !== 'collab' || !parts[2]) {
      return bad('not found', 404);
    }
    const inviteId = decodeURIComponent(parts[2]);
    if (!/^[A-Za-z0-9_-]{10,}$/.test(inviteId)) {
      return bad('invalid invite id');
    }

    // DELETE room
    if (request.method === 'DELETE' && parts.length === 3) {
      const secret = url.searchParams.get('secret') || '';
      const room = await loadRoom(env, inviteId);
      if (!room) return json({ ok: true });
      if (!timingSafeEqual(room.secret, secret)) return bad('forbidden', 403);
      await env.COLLAB_ROOMS.delete(`room:${inviteId}`);
      return json({ ok: true });
    }

    // GET members
    if (request.method === 'GET' && parts[3] === 'members') {
      const secret = url.searchParams.get('secret') || '';
      let room = await loadRoom(env, inviteId);
      // First GET with secret bootstraps empty room (owner published invite).
      if (!room) {
        if (!secret || secret.length < 16) return bad('forbidden', 403);
        room = { secret, members: {}, createdAt: new Date().toISOString() };
        await saveRoom(env, inviteId, room);
      } else if (!timingSafeEqual(room.secret, secret)) {
        return bad('forbidden', 403);
      }
      const members = Object.values(room.members || {});
      return json({ members });
    }

    // POST join
    if (request.method === 'POST' && parts[3] === 'join') {
      let body;
      try {
        body = await request.json();
      } catch {
        return bad('invalid json');
      }
      const secret = (body.secret || '').toString();
      if (secret.length < 16) return bad('invalid secret');
      let room = await loadRoom(env, inviteId);
      if (!room) {
        room = { secret, members: {}, createdAt: new Date().toISOString() };
      } else if (!timingSafeEqual(room.secret, secret)) {
        return bad('forbidden', 403);
      }
      const id = memberIdFrom(body);
      if (!id) return bad('email or peerIndexFileId required');
      const role =
        body.role === 'writer' || body.role === 'owner' ? 'writer' : 'reader';
      const email = (body.email || '').trim().toLowerCase() || null;
      const peerIndexFileId = (body.peerIndexFileId || '').trim() || null;
      if (peerIndexFileId && !/^[A-Za-z0-9_-]{10,}$/.test(peerIndexFileId)) {
        return bad('invalid peerIndexFileId');
      }
      const prev = room.members[id] || {};
      room.members[id] = {
        id,
        email: email || prev.email || null,
        role,
        peerIndexFileId: peerIndexFileId || prev.peerIndexFileId || null,
        displayName: (body.displayName || prev.displayName || null),
        joinedAt: prev.joinedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      // Cap room size (abuse)
      const keys = Object.keys(room.members);
      if (keys.length > 200) {
        return bad('room full', 429);
      }
      await saveRoom(env, inviteId, room);
      return json({ ok: true, member: room.members[id] });
    }

    // PATCH / DELETE member
    if (parts[3] === 'members' && parts[4]) {
      const memberId = decodeURIComponent(parts[4]);
      let body = {};
      if (request.method === 'PATCH') {
        try {
          body = await request.json();
        } catch {
          return bad('invalid json');
        }
      }
      const secret =
        (body.secret || url.searchParams.get('secret') || '').toString();
      const room = await loadRoom(env, inviteId);
      if (!room || !timingSafeEqual(room.secret, secret)) {
        return bad('forbidden', 403);
      }
      if (!room.members[memberId]) return bad('not found', 404);

      if (request.method === 'DELETE') {
        delete room.members[memberId];
        await saveRoom(env, inviteId, room);
        return json({ ok: true });
      }
      if (request.method === 'PATCH') {
        const role =
          body.role === 'writer' ? 'writer' : body.role === 'reader' ? 'reader' : null;
        if (!role) return bad('role must be writer or reader');
        room.members[memberId].role = role;
        room.members[memberId].updatedAt = new Date().toISOString();
        // Demote to reader → drop peer channel so writes stop being pulled
        if (role === 'reader') {
          room.members[memberId].peerIndexFileId = null;
        }
        await saveRoom(env, inviteId, room);
        return json({ ok: true, member: room.members[memberId] });
      }
    }

    return bad('not found', 404);
  },
};
