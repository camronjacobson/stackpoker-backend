import { PrismaClient } from '@prisma/client';
import { roomManager } from './roomManager';
import { logger } from '../shared/utils';

const prisma = new PrismaClient();

// ─── Bot identity registry ────────────────────────────────────────────────────
//
// Multiple bots can sit at the same table. Each bot is a real User row keyed
// by a unique `username`, so we keep a fixed roster of profiles instead of
// generating names on the fly — that way the same DB row is reused across
// table sessions, FK history (hand actions, win records, friendships if any)
// stays intact, and we never accumulate a sprawl of "StackBot_<uuid>" rows.
//
// 8 profiles covers up to a 9-max table (1 human + 8 bots). NATO phonetic so
// the names read cleanly side-by-side at a packed table and are obvious as
// AI accounts. Order is meaningful: `addBotToTable` selects the first
// profile whose username isn't already seated, so seats fill Alpha → Hotel
// in a predictable order rather than randomly. Migration
// `20260515_rename_stackbot_to_alpha` renames the original `StackBot` row
// to `StackBot_Alpha` so its FK history is preserved.
export const BOT_PROFILES = [
  { username: 'StackBot_Alpha',   displayName: 'Stack Bot Alpha',   avatarId: 'avatar_7' },
  { username: 'StackBot_Bravo',   displayName: 'Stack Bot Bravo',   avatarId: 'avatar_2' },
  { username: 'StackBot_Charlie', displayName: 'Stack Bot Charlie', avatarId: 'avatar_3' },
  { username: 'StackBot_Delta',   displayName: 'Stack Bot Delta',   avatarId: 'avatar_4' },
  { username: 'StackBot_Echo',    displayName: 'Stack Bot Echo',    avatarId: 'avatar_5' },
  { username: 'StackBot_Foxtrot', displayName: 'Stack Bot Foxtrot', avatarId: 'avatar_6' },
  { username: 'StackBot_Golf',    displayName: 'Stack Bot Golf',    avatarId: 'avatar_1' },
  { username: 'StackBot_Hotel',   displayName: 'Stack Bot Hotel',   avatarId: 'avatar_8' },
] as const;

// In-memory set for O(1) lookups — used by every "is this user a bot?" site
// (idle-sweeper exclusion, isBot flag stamping, profile route badging). Single
// source of truth: derived from BOT_PROFILES so adding/removing a profile
// updates every call site automatically.
export const BOT_USERNAMES = new Set<string>(BOT_PROFILES.map(p => p.username));

export function isBotUsername(name: string): boolean {
  return BOT_USERNAMES.has(name);
}

// FNV-1a-ish string hash → 32-bit unsigned int. Used by gameEngine to seed
// a per-bot "think delay" offset so two bots that get their turn back-to-back
// don't act on the exact same setTimeout tick (the random base delay already
// jitters but several bots ending up in the same ~150ms slice was visible
// at full tables). Stable across restarts — same userId → same offset.
export function hashStringToInt(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = (h ^ s.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

const BOT_CHIPS = BigInt(10_000_000);

// Lazy-create a bot User row keyed by its `username`. Idempotent: subsequent
// calls return the existing row untouched. Pulled out of `addBotToTable` so
// the admin test-friend seeding endpoint can guarantee all 8 bot rows exist
// up-front (so frame-equip and friendship inserts have stable userIds to
// reference) without duplicating the create-or-fetch logic.
export type BotProfile = (typeof BOT_PROFILES)[number];

export async function ensureBotUser(profile: BotProfile) {
  let bot = await prisma.user.findUnique({ where: { username: profile.username } });
  if (!bot) {
    bot = await prisma.user.create({
      data: {
        username:    profile.username,
        displayName: profile.displayName,
        avatarId:    profile.avatarId,
        chipBalance: BOT_CHIPS,
      },
    });
    logger.info(`Bot user created: ${bot.id} (${profile.username})`);
  }
  return bot;
}

export async function addBotToTable(tableId: string): Promise<void> {
  // ── Load table ────────────────────────────────────────────────────────────
  const table = await prisma.pokerTable.findUnique({ where: { id: tableId } });
  if (!table) throw new Error('Table not found');

  // ── Pick the first profile whose username isn't already seated here ──────
  // We check the live engine state (not just the DB) so a bot that's been
  // added in the current session but hasn't fully flushed to TableSession yet
  // is still considered "taken". Sequential assignment by BOT_PROFILES order
  // means Alpha sits first, Bravo second, etc. — predictable for QA and
  // matches the screenshot expectations.
  const engine = await roomManager.getOrCreate(tableId);
  const seatedUsernames = new Set(engine.getState().seats.map(s => s.username));
  const profile = BOT_PROFILES.find(p => !seatedUsernames.has(p.username));
  if (!profile) throw new Error('All bot profiles already seated at this table');

  // ── Ensure bot user exists (lazy-create per profile) ─────────────────────
  const bot = await ensureBotUser(profile);

  // ── Check for existing active session ─────────────────────────────────────
  // Belt-and-suspenders with the in-engine check above: handles the edge case
  // where a session row was left isActive=true after a crash but the engine
  // hasn't rehydrated that seat yet.
  const existing = await prisma.tableSession.findUnique({
    where: { tableId_userId: { tableId, userId: bot.id } },
  });
  if (existing?.isActive) throw new Error('Bot already at this table');

  // ── Find next open seat index ─────────────────────────────────────────────
  const takenSeats = new Set(engine.getState().seats.map(s => s.seatIndex));
  let seatIndex = 0;
  while (takenSeats.has(seatIndex) && seatIndex < table.maxPlayers) seatIndex++;
  if (seatIndex >= table.maxPlayers) throw new Error('Table is full');

  const buyIn = Number(table.minBuyIn);

  // ── Create / reactivate TableSession ─────────────────────────────────────
  await prisma.tableSession.upsert({
    where:  { tableId_userId: { tableId, userId: bot.id } },
    create: {
      tableId,
      userId:       bot.id,
      seatIndex,
      buyInAmount:  BigInt(buyIn),
      currentStack: BigInt(buyIn),
      isActive:     true,
    },
    update: {
      seatIndex,
      buyInAmount:  BigInt(buyIn),
      currentStack: BigInt(buyIn),
      isActive:     true,
      leftAt:       null,
    },
  });

  // ── Add bot seat to engine ────────────────────────────────────────────────
  engine.addPlayer({
    seatIndex,
    userId:      bot.id,
    username:    profile.username,
    displayName: profile.displayName,
    avatarId:    profile.avatarId,
    stack:       buyIn,
    status:      'WAITING' as const,
    // Bots act instantly anyway — no need for a time bank.
    timeBank:    0,
    isConnected: true,
    isBot:       true,
    // Phase 4 test scaffold: force the classic-blue card back on every bot
    // so the iOS client can verify cosmetic broadcast end-to-end without
    // needing two real accounts. Remove once a real bot-cosmetic policy
    // lands (e.g. per-personality skins) or smoke testing wraps.
    equippedCosmetics: {
      cardBack:    'card_back_classic_blue',
      avatarFrame: 'avatar_frame_mythic_inferno',
    },
  });

  logger.info(`Bot added to table ${tableId} at seat ${seatIndex} (${profile.username})`);

  // ── Auto-start hand if ready ──────────────────────────────────────────────
  if (engine.canStartHand()) {
    setTimeout(() => engine.startHand(), 1500);
  }
}
