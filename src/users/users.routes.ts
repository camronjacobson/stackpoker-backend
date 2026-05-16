import { Router, Request, Response } from 'express';
import { param, validationResult } from 'express-validator';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../shared/middleware/auth.middleware';
import { sendSuccess, sendError, sendServerError } from '../shared/utils';
import { isBotUsername } from '../game/botService';

// ─── Users router ─────────────────────────────────────────────────────────────
// Lightweight per-user endpoints used by the in-game opponent popup. Anything
// heavier (full profile / settings / history) belongs in its own router.

const prisma = new PrismaClient();
export const usersRouter = Router();

usersRouter.use(requireAuth);

function validate(req: Request, res: Response): boolean {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    sendError(res, 'VALIDATION_ERROR', errors.array()[0].msg as string, 422);
    return false;
  }
  return true;
}

// GET /api/users/:id/quick-profile
// Returns the minimal data the in-game popup needs:
//   • identity (username/displayName/avatarId)
//   • VPIP stats (handsPlayed + vpipHands so client can render the %)
//   • friendship status relative to the caller — so the popup's friend
//     button can render the right CTA (Add / Pending / Friends / Respond).
usersRouter.get('/:id/quick-profile',
  param('id').isUUID(),
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return;

    const meId    = req.user!.sub;
    const otherId = req.params.id;

    try {
      const user = await prisma.user.findUnique({
        where: { id: otherId },
        select: {
          id: true,
          username: true,
          displayName: true,
          avatarId: true,
          handsPlayed: true,
          vpipHands: true,
        },
      });

      // Bot accounts (see botService.ts — BOT_PROFILES) never have
      // VPIP/handsPlayed written for them, which means the popup was
      // rendering "0%" with "0 hands" for every bot tap and the player
      // rightly read that as a glitch. Surface an `isBot` flag so the
      // client can swap the stat row for an "AI Opponent — stats not
      // tracked" line instead of a meaningless 0%.
      const isBot = isBotUsername(user?.username ?? '');

      if (!user) return sendError(res, 'NOT_FOUND', 'User not found', 404);

      // Look up either direction of the friendship in a single query.
      // direction is from the caller's POV: OUTGOING = I sent the request,
      // INCOMING = they sent it to me. NONE means no row exists.
      let friendshipStatus: 'NONE' | 'PENDING' | 'ACCEPTED' | 'BLOCKED' = 'NONE';
      let friendshipDirection: 'OUTGOING' | 'INCOMING' | undefined;
      let friendshipId: string | undefined;

      if (meId !== otherId) {
        const friendship = await prisma.friendship.findFirst({
          where: {
            OR: [
              { senderId: meId,    receiverId: otherId },
              { senderId: otherId, receiverId: meId    },
            ],
          },
        });
        if (friendship) {
          friendshipStatus    = friendship.status as typeof friendshipStatus;
          friendshipDirection = friendship.senderId === meId ? 'OUTGOING' : 'INCOMING';
          friendshipId        = friendship.id;
        }
      }

      sendSuccess(res, {
        userId:      user.id,
        username:    user.username,
        displayName: user.displayName,
        avatarId:    user.avatarId,
        handsPlayed: user.handsPlayed,
        vpipHands:   user.vpipHands,
        friendshipStatus,
        friendshipDirection,
        friendshipId,
        isSelf:      meId === otherId,
        isBot,
      });
    } catch (err) {
      sendServerError(res);
    }
  }
);
