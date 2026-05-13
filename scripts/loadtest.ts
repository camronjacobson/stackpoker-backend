/* eslint-disable no-console */
//
// StackPoker load test
// =====================
//
// Spins up N fake users, groups them into M tables, has them play a handful
// of hands while we measure latency, error rate, and reconnect/dropout count.
// The goal is to find the break point of the running backend (local or
// Railway) by walking up TABLES/PLAYERS_PER_TABLE until something gives.
//
// What it actually exercises:
//   1. REST /auth/register (first run) or /auth/login (subsequent runs).
//      Tokens are cached to scripts/.loadtest-tokens.json so repeat runs
//      skip the auth round-trip and avoid the per-IP authRateLimit cap.
//   2. REST /tables (create) and /tables/join/:code — the same calls the
//      iOS lobby flow makes. We deliberately do NOT bypass the buy-in /
//      seat-allocation logic; the goal is to load-test the real path.
//   3. Socket.IO connection + `join_table` emit. Identical handshake as
//      iOS (token in `auth.token`, X-Device-ID header).
//   4. `player_action` emits whenever it's our turn, driven by the
//      `game_state` push. Simple strategy: CHECK if legal, else CALL if
//      cheap, else FOLD. Small random delay (50-200ms) keeps it realistic
//      without being a bottleneck.
//
// What to watch while it runs:
//   - Backend logs: socket errors, "Auto-leave", "Auto-check/fold", any
//     prisma "Timed out fetching connection" pool errors.
//   - Railway/`top` metrics for the node process: CPU%, RSS, event-loop
//     lag. Event loop lag growing past ~50ms means you're CPU-bound.
//   - Postgres connection count (`SELECT count(*) FROM pg_stat_activity;`)
//
// Usage:
//   API_BASE=http://localhost:3000 TABLES=10 PLAYERS_PER_TABLE=6 \
//     HANDS=5 npx ts-node scripts/loadtest.ts
//
// Tunables (all env-var driven so we don't recompile to ramp):
//   API_BASE             default http://localhost:3000
//   TABLES               default 5
//   PLAYERS_PER_TABLE    default 4   (must be 2-9)
//   HANDS                default 3   (#hands per table before tear-down)
//   RAMP_UP_MS           default 50  (stagger between client starts —
//                                     avoid thundering-herd on auth)
//   STARTING_BUYIN       default 2000
//
// Caveat: the rate limiter on /auth/register will choke if you blow past
// the default 5/min from one IP. The token cache solves this on the
// second+ run, but cold-start with TABLES*PLAYERS > ~5 means you have to
// either bump RAMP_UP_MS or seed users out of band.
//

import { io, Socket } from 'socket.io-client';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

// ── Config ──────────────────────────────────────────────────────────────────

const API_BASE          = process.env.API_BASE          || 'http://localhost:3000';
const TABLES            = Number(process.env.TABLES            || 5);
const PLAYERS_PER_TABLE = Number(process.env.PLAYERS_PER_TABLE || 4);
const HANDS             = Number(process.env.HANDS             || 3);
const RAMP_UP_MS        = Number(process.env.RAMP_UP_MS        || 50);
const STARTING_BUYIN    = Number(process.env.STARTING_BUYIN    || 2000);

const TOTAL_USERS = TABLES * PLAYERS_PER_TABLE;
const TOKEN_CACHE_PATH = path.join(__dirname, '.loadtest-tokens.json');

// ── Types ───────────────────────────────────────────────────────────────────

interface CachedUser {
  email:        string;
  password:     string;
  username:     string;
  userId:       string;
  accessToken:  string;
  refreshToken: string;
}

interface LegalAction {
  action:      'FOLD' | 'CHECK' | 'CALL' | 'BET' | 'RAISE' | 'ALL_IN';
  minAmount?:  number;
  maxAmount?:  number;
  callAmount?: number;
}

interface ClientGameState {
  tableId:        string;
  activePlayerId: string | null;
  legalActions:   LegalAction[];
  phase:          string;
  handNumber:     number;
  winners:        unknown[] | null;
}

// ── Metrics ─────────────────────────────────────────────────────────────────
//
// Kept dead-simple on purpose — a Map of named counters and an array of
// per-event latency samples. We print a summary on shutdown. If you need
// histograms / p99s, pipe the samples to a real tool; the goal here is a
// gut check, not benchmark-quality data.

const metrics = {
  counters: new Map<string, number>(),
  latencies: [] as { kind: string; ms: number }[],
};

function bump(name: string, n = 1): void {
  metrics.counters.set(name, (metrics.counters.get(name) ?? 0) + n);
}
function recordLatency(kind: string, ms: number): void {
  metrics.latencies.push({ kind, ms });
}

// ── HTTP helper ─────────────────────────────────────────────────────────────
//
// Hand-rolled instead of pulling axios because (a) it's one dependency
// fewer and (b) we want bare control over headers + the exact APIResponse
// envelope the backend uses.

async function api<T = unknown>(
  method: string,
  pathOnly: string,
  body?: unknown,
  token?: string,
): Promise<T> {
  const url = `${API_BASE}/api${pathOnly}`;
  const headers: Record<string, string> = {
    'Content-Type':  'application/json',
    'Accept':        'application/json',
    'X-Device-ID':   `loadtest-${process.pid}`,
    'X-App-Version': 'loadtest',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res  = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !(json as any).success) {
    const err = (json as any).error ?? { code: `HTTP_${res.status}`, message: res.statusText };
    throw new Error(`${method} ${pathOnly} → ${err.code}: ${err.message}`);
  }
  return (json as any).data as T;
}

// ── Auth / user seeding ─────────────────────────────────────────────────────
//
// Strategy: try to load cached tokens. For any cached entry, do a
// /auth/me probe to confirm the token is still valid; if not, log back in
// with the cached email/password. For non-cached slots, register a brand
// new user. This way the second+ run is cheap (one /auth/me per user)
// and the first run is the only one that pays full registration cost.

function rand(n = 8): string {
  return randomBytes(n).toString('hex');
}

async function loadCachedUsers(): Promise<CachedUser[]> {
  try {
    const raw = await fs.readFile(TOKEN_CACHE_PATH, 'utf8');
    return JSON.parse(raw) as CachedUser[];
  } catch { return []; }
}
async function saveCachedUsers(users: CachedUser[]): Promise<void> {
  await fs.writeFile(TOKEN_CACHE_PATH, JSON.stringify(users, null, 2));
}

async function loginExisting(u: CachedUser): Promise<CachedUser> {
  const result = await api<{ tokens: { accessToken: string; refreshToken: string }, user: { id: string } }>(
    'POST', '/auth/login', { email: u.email, password: u.password },
  );
  return { ...u, userId: result.user.id, accessToken: result.tokens.accessToken, refreshToken: result.tokens.refreshToken };
}

async function registerNew(idx: number): Promise<CachedUser> {
  const tag      = rand(4);
  const email    = `loadtest_${idx}_${tag}@stackpoker.test`;
  const password = `LoadTest_${tag}_pw!`;
  const username = `lt_${idx}_${tag}`.slice(0, 20);
  const result = await api<{ tokens: { accessToken: string; refreshToken: string }, user: { id: string } }>(
    'POST', '/auth/register',
    {
      email, password, username,
      displayName: `LT ${idx}`,
      avatarId:    'avatar_1',
    },
  );
  return {
    email, password, username,
    userId: result.user.id,
    accessToken:  result.tokens.accessToken,
    refreshToken: result.tokens.refreshToken,
  };
}

async function ensureUser(idx: number, cached?: CachedUser): Promise<CachedUser> {
  // No cache entry — register from scratch.
  if (!cached) return registerNew(idx);

  // Cache hit — probe with /auth/me. Cheap and tells us if the token is
  // still valid without burning a refresh round-trip.
  try {
    await api('GET', '/auth/me', undefined, cached.accessToken);
    return cached;
  } catch {
    // Token expired (or user was wiped). Try password login; if that
    // also fails, fall back to a fresh registration.
    try { return await loginExisting(cached); }
    catch { return registerNew(idx); }
  }
}

async function seedUsers(): Promise<CachedUser[]> {
  console.log(`Seeding ${TOTAL_USERS} users…`);
  const cached = await loadCachedUsers();
  const users: CachedUser[] = [];
  for (let i = 0; i < TOTAL_USERS; i++) {
    // Stagger so we don't trip authRateLimit (5/min/IP by default).
    if (i > 0 && i % 4 === 0) await sleep(1100);
    try {
      const u = await ensureUser(i, cached[i]);
      users.push(u);
      bump('users.seeded');
    } catch (err: any) {
      console.error(`  user ${i} failed: ${err.message}`);
      bump('users.failed');
    }
  }
  await saveCachedUsers(users);
  console.log(`  → ready (${users.length}/${TOTAL_USERS})`);
  return users;
}

// ── Table provisioning ──────────────────────────────────────────────────────
//
// Each table is owned + created by the first player in the group. The
// remaining players join by /tables/join/:code. Buy-in is fixed; we keep
// the table public (isPrivate=false) so the lobby list shows them and
// you can spot-check from a real client during the run.

interface TableSession { tableId: string; joinCode: string; }

async function createTable(owner: CachedUser, label: string): Promise<TableSession> {
  const t = await api<{ id: string; joinCode: string }>(
    'POST', '/tables',
    {
      name:       `LoadTest ${label}`,
      maxPlayers: 9,
      smallBlind: 5,
      bigBlind:   10,
      minBuyIn:   500,
      maxBuyIn:   5000,
      isPrivate:  false,
      gameType:   'TEXAS_HOLDEM',
    },
    owner.accessToken,
  );
  return { tableId: t.id, joinCode: t.joinCode };
}

async function joinTable(user: CachedUser, code: string): Promise<void> {
  await api(
    'POST', `/tables/join/${code}`,
    { buyInAmount: STARTING_BUYIN },
    user.accessToken,
  );
}

// ── Per-client driver ───────────────────────────────────────────────────────
//
// Each client owns one socket, listens for `game_state`, and emits a
// single action whenever it sees itself as the active player. Action
// choice is deterministic given legalActions, so the same hand always
// plays out the same way for these bots — fine for a load test.

class LoadClient {
  socket?:    Socket;
  myTurns    = 0;
  handsSeen  = new Set<number>();
  stopped    = false;
  // De-dup: every game_state push re-runs maybeAct, and many pushes
  // arrive between when we schedule our setTimeout-delayed emit and
  // when the server processes it. Without this guard we double-fire
  // and get a flood of INVALID_ACTION "Not your turn" errors. We flip
  // it true on schedule, false when we next see a state where it's
  // someone else's turn (i.e. our action was processed).
  private actedThisTurn = false;
  // Round-trip latency: stamp Date.now() when we emit, clear when the
  // next non-self-turn game_state lands. Same idea as actedThisTurn
  // but recording the timing rather than the boolean.
  private emitStartedAt: number | null = null;

  constructor(
    public user:    CachedUser,
    public tableId: string,
    public id:      number,
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Connect to the /game namespace? — actually the backend uses the
      // default namespace, so plain io(API_BASE) is correct. We pass the
      // token via the `auth` payload (matches socketAuth in
      // socket.handler.ts:180).
      const connectStart = Date.now();
      this.socket = io(API_BASE, {
        auth:           { token: this.user.accessToken },
        transports:     ['websocket'],
        reconnection:   true,
        // Long-ish timeout — under load the handshake itself can stall.
        timeout:        10_000,
      });

      this.socket.on('connect', () => {
        recordLatency('socket.connect', Date.now() - connectStart);
        bump('socket.connected');
        // Now formally enter the room. Without this emit, the server
        // never adds us to `table:<id>` and we won't receive game_state.
        this.socket!.emit('join_table', { tableId: this.tableId });
        resolve();
      });

      this.socket.on('connect_error', (err: Error) => {
        bump('socket.connect_error');
        console.error(`  client ${this.id} connect_error: ${err.message}`);
        reject(err);
      });

      this.socket.on('disconnect', (reason: string) => {
        bump(`socket.disconnect.${reason}`);
      });

      this.socket.on('error', (envelope: any) => {
        bump('event.error');
        const e = envelope?.data ?? envelope;
        console.error(`  client ${this.id} server error: ${e?.code} ${e?.message}`);
      });

      this.socket.on('game_state', (envelope: any) => {
        const state = envelope?.data as ClientGameState | undefined;
        if (!state) return;
        bump('event.game_state');
        if (state.handNumber > 0) this.handsSeen.add(state.handNumber);
        this.maybeAct(state);
      });
    });
  }

  private maybeAct(state: ClientGameState): void {
    if (this.stopped) return;

    // Turn over to someone else (or no active player at all) — clear
    // de-dup latch and record round-trip if we had an outbound emit
    // pending. This is our action_to_state metric: how long from
    // emitting player_action until the server publishes the next
    // state in which we're no longer active.
    if (state.activePlayerId !== this.user.userId) {
      if (this.emitStartedAt !== null) {
        recordLatency('action.roundtrip', Date.now() - this.emitStartedAt);
        this.emitStartedAt = null;
      }
      this.actedThisTurn = false;
      return;
    }

    if (this.actedThisTurn) return;                           // already acted on this turn
    if (!state.legalActions || state.legalActions.length === 0) return;

    this.actedThisTurn = true;
    this.myTurns++;
    const choice = pickAction(state.legalActions);
    // Small human-ish jitter so the server isn't strictly synchronous —
    // also smooths out our own outbound traffic.
    const delay = 50 + Math.floor(Math.random() * 150);
    setTimeout(() => {
      if (this.stopped) return;
      this.emitStartedAt = Date.now();
      this.socket!.emit('player_action', {
        tableId: this.tableId,
        action:  choice.action,
        amount:  choice.amount,
      });
      bump(`action.${choice.action}`);
    }, delay);
  }

  stop(): void {
    this.stopped = true;
    this.socket?.disconnect();
  }
}

function pickAction(legal: LegalAction[]): { action: string; amount?: number } {
  // CHECK if legal — free + safe.
  const check = legal.find(a => a.action === 'CHECK');
  if (check) return { action: 'CHECK' };

  // Otherwise CALL if the call is cheap (≤ 25% of legal max). Anything
  // more, fold — keeps the bots from getting pot-stuck and burns through
  // hands quickly.
  const call = legal.find(a => a.action === 'CALL');
  if (call && (call.callAmount ?? 0) <= STARTING_BUYIN * 0.25) {
    return { action: 'CALL' };
  }

  // Sometimes RAISE small to keep hands progressing past pre-flop limps.
  // 10% of the time, min-raise; otherwise fold.
  const raise = legal.find(a => a.action === 'RAISE' || a.action === 'BET');
  if (raise && Math.random() < 0.1 && raise.minAmount) {
    return { action: raise.action, amount: raise.minAmount };
  }

  return { action: 'FOLD' };
}

// ── Top-level orchestration ─────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function run(): Promise<void> {
  console.log('────────────────────────────────────────────────');
  console.log(`Load test — ${TABLES} tables × ${PLAYERS_PER_TABLE} players = ${TOTAL_USERS} clients`);
  console.log(`API: ${API_BASE}   buyIn: ${STARTING_BUYIN}   hands target: ${HANDS}/table`);
  console.log('────────────────────────────────────────────────');

  const t0 = Date.now();

  // ── 1. Users ──────────────────────────────────────────────────────────────
  const users = await seedUsers();
  if (users.length < TOTAL_USERS) {
    console.warn(`Only ${users.length} users seeded — proceeding with what we have.`);
  }

  // ── 2. Tables ─────────────────────────────────────────────────────────────
  const groups: { table: TableSession; players: CachedUser[] }[] = [];
  for (let g = 0; g < TABLES; g++) {
    const slice = users.slice(g * PLAYERS_PER_TABLE, (g + 1) * PLAYERS_PER_TABLE);
    if (slice.length < 2) break;
    const owner = slice[0];
    try {
      const table = await createTable(owner, `${g + 1}`);
      // Owner joins their own table (creating doesn't auto-seat). Then
      // the rest join sequentially — sequential matters because
      // lobby.service hands out seat indices on a first-come basis and
      // we don't want simultaneous joins racing for the same seat.
      await joinTable(owner, table.joinCode);
      for (let p = 1; p < slice.length; p++) {
        await joinTable(slice[p], table.joinCode);
      }
      groups.push({ table, players: slice });
      bump('tables.created');
    } catch (err: any) {
      console.error(`Table ${g + 1} provisioning failed: ${err.message}`);
      bump('tables.failed');
    }
  }
  console.log(`  → ${groups.length} tables provisioned`);

  // ── 3. Sockets ────────────────────────────────────────────────────────────
  const clients: LoadClient[] = [];
  let cid = 0;
  for (const { table, players } of groups) {
    for (const u of players) {
      const c = new LoadClient(u, table.tableId, cid++);
      clients.push(c);
      // Fire-and-forget start; if it throws we just count it.
      c.start().catch(() => {/* counted in metrics */});
      if (RAMP_UP_MS > 0) await sleep(RAMP_UP_MS);
    }
  }
  console.log(`  → ${clients.length} clients connected (or attempting)`);

  // ── 4. Let them play ──────────────────────────────────────────────────────
  // Each table needs ~3 streets × N players actions per hand. With our
  // 50-200ms decision jitter, that's roughly 1-3s/hand at small tables.
  // We cap at a generous timeout so a stuck table doesn't hang the run.
  const targetUntil = Date.now() + HANDS * 60_000; // 1 min/hand worst case
  let done = false;
  while (!done && Date.now() < targetUntil) {
    await sleep(1000);
    const minHands = Math.min(...clients.map(c => c.handsSeen.size), Infinity);
    done = minHands >= HANDS;
    process.stdout.write(`\r  hands min/max: ${minHands}/${Math.max(...clients.map(c => c.handsSeen.size))}   `);
  }
  process.stdout.write('\n');

  // ── 5. Teardown ───────────────────────────────────────────────────────────
  console.log('Stopping clients…');
  for (const c of clients) c.stop();
  await sleep(500);

  // ── 6. Report ─────────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n──────── Results ────────');
  console.log(`Wall time: ${elapsed}s`);
  console.log('Counters:');
  for (const [k, v] of [...metrics.counters.entries()].sort()) {
    console.log(`  ${k.padEnd(28)} ${v}`);
  }
  // Per-kind latency summary
  const byKind = new Map<string, number[]>();
  for (const { kind, ms } of metrics.latencies) {
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind)!.push(ms);
  }
  console.log('Latencies (ms):');
  for (const [kind, samples] of byKind) {
    samples.sort((a, b) => a - b);
    const n   = samples.length;
    const p50 = samples[Math.floor(n * 0.5)] ?? 0;
    const p95 = samples[Math.floor(n * 0.95)] ?? 0;
    const max = samples[n - 1] ?? 0;
    console.log(`  ${kind.padEnd(20)} n=${n}  p50=${p50}  p95=${p95}  max=${max}`);
  }
  console.log('─────────────────────────');
}

run().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
}).then(() => process.exit(0));
