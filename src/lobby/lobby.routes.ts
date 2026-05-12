import { Router, Request, Response } from 'express';
import { body, query, param, validationResult } from 'express-validator';
import * as lobbyService from './lobby.service';
import { requireAuth } from '../shared/middleware/auth.middleware';
import { sendSuccess, sendError, sendServerError, sendNotFound, logger } from '../shared/utils';
import { roomManager } from '../game/roomManager';

export const lobbyRouter = Router();

// All lobby routes require authentication
lobbyRouter.use(requireAuth);

function handleValidation(req: Request, res: Response): boolean {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const first = errors.array()[0];
    sendError(res, 'VALIDATION_ERROR', first.msg as string, 422);
    return false;
  }
  return true;
}

// ─── GET /tables ──────────────────────────────────────────────────────────────

lobbyRouter.get('/', async (req: Request, res: Response) => {
  try {
    const result = await lobbyService.listTables({
      status: String(req.query.status || 'WAITING'),
      clubId: req.query.clubId as string | undefined,
      page: parseInt(String(req.query.page || '1')),
      limit: parseInt(String(req.query.limit || '20')),
    });
    sendSuccess(res, result);
  } catch (err: any) {
    logger.error('List tables error:', err);
    sendServerError(res);
  }
});

// ─── POST /tables ─────────────────────────────────────────────────────────────

lobbyRouter.post('/',
  [
    body('name').isString().trim().isLength({ min: 2, max: 40 }),
    body('maxPlayers').isInt({ min: 2, max: 9 }),
    body('smallBlind').isInt({ min: 1 }),
    body('bigBlind').isInt({ min: 2 }),
    body('minBuyIn').isInt({ min: 20 }),
    body('maxBuyIn').isInt({ min: 20 }),
    body('isPrivate').isBoolean(),
    body('gameType').optional().isIn(['TEXAS_HOLDEM', 'PLO']),
  ],
  async (req: Request, res: Response) => {
    if (!handleValidation(req, res)) return;
    try {
      const table = await lobbyService.createTable(req.user!.sub, req.body);
      sendSuccess(res, table, 201);
    } catch (err: any) {
      if (err.code) sendError(res, err.code, err.message, 400);
      else { logger.error('Create table error:', err); sendServerError(res); }
    }
  }
);

// ─── GET /tables/:id ─────────────────────────────────────────────────────────

lobbyRouter.get('/:id',
  param('id').isUUID(),
  async (req: Request, res: Response) => {
    if (!handleValidation(req, res)) return;
    try {
      const table = await lobbyService.getTableDetail(req.params.id, req.user!.sub);
      sendSuccess(res, table);
    } catch (err: any) {
      if (err.code === 'NOT_FOUND') sendNotFound(res, 'Table');
      else if (err.code) sendError(res, err.code, err.message, 403);
      else sendServerError(res);
    }
  }
);

// ─── POST /tables/join/:code ──────────────────────────────────────────────────

lobbyRouter.post('/join/:code',
  [
    param('code').isString().trim().notEmpty(),
    body('buyInAmount').isInt({ min: 1 }),
    body('seatIndex').optional().isInt({ min: 0, max: 8 }),
  ],
  async (req: Request, res: Response) => {
    if (!handleValidation(req, res)) return;
    try {
      const table = await lobbyService.joinTableByCode(
        req.user!.sub,
        req.params.code,
        req.body
      );
      sendSuccess(res, table);
    } catch (err: any) {
      if (err.code) sendError(res, err.code, err.message, 400);
      else { logger.error('Join table error:', err); sendServerError(res); }
    }
  }
);

// ─── POST /tables/:id/leave ───────────────────────────────────────────────────

lobbyRouter.post('/:id/leave', async (req: Request, res: Response) => {
  try {
    const result = await lobbyService.leaveTable(req.user!.sub, req.params.id);
    sendSuccess(res, result);
  } catch (err: any) {
    if (err.code) sendError(res, err.code, err.message, 400);
    else sendServerError(res);
  }
});

// ─── POST /tables/:id/topup ───────────────────────────────────────────────────

lobbyRouter.post('/:id/topup',
  body('amount').isInt({ min: 1 }),
  async (req: Request, res: Response) => {
    if (!handleValidation(req, res)) return;
    try {
      const tableId = req.params.id;
      const userId  = req.user!.sub;
      const amount  = parseInt(req.body.amount, 10);

      // Decide the path based on the live engine state. A hand is "in
      // progress" for any phase that isn't WAITING (between hands) or
      // ENDED (showdown reveal window — actually, ENDED is brief and
      // followed by the setTimeout that drains queued top-ups, so we
      // also count it as in-progress to avoid a race where the user
      // hits the endpoint in that window and accidentally takes the
      // apply path that updates DB while the engine is about to flip
      // WAITING and drain pending). If the engine doesn't exist yet
      // (no one is connected, or this is the very first sit), apply
      // immediately — there's no hand to interfere with.
      const engine = roomManager.get(tableId);
      const phase  = engine?.getState().phase;
      const handActive =
        phase === 'STARTING' || phase === 'DEALING' ||
        phase === 'BETTING'  || phase === 'SHOWDOWN' ||
        phase === 'ENDED';

      const result = await lobbyService.topUpChips(
        userId,
        tableId,
        amount,
        handActive ? 'queue' : 'apply',
      );

      // Mirror the DB write into the live engine so the broadcast reflects
      // the rebuy without waiting for the next hand to reload from DB.
      //   • apply: setStack to the new (projected) total
      //   • queue: park the amount on the seat as pendingTopUp; the engine
      //     drains it into `stack` at endHand and roomManager persists.
      if (engine) {
        if (handActive) engine.queueTopUp(userId, amount);
        else            engine.setStack(userId, parseInt(result.newStack, 10));
      }

      sendSuccess(res, result);
    } catch (err: any) {
      if (err.code) sendError(res, err.code, err.message, 400);
      else { logger.error('Top-up error:', err); sendServerError(res); }
    }
  }
);

// ─── POST /tables/:id/close ───────────────────────────────────────────────────

lobbyRouter.post('/:id/close', async (req: Request, res: Response) => {
  try {
    await lobbyService.closeTable(req.user!.sub, req.params.id);
    sendSuccess(res, { message: 'Table closed' });
  } catch (err: any) {
    if (err.code) sendError(res, err.code, err.message, 400);
    else sendServerError(res);
  }
});

// ─── POST /tables/:id/invite ──────────────────────────────────────────────────

lobbyRouter.post('/:id/invite',
  body('recipientId').isUUID(),
  async (req: Request, res: Response) => {
    if (!handleValidation(req, res)) return;
    try {
      await lobbyService.sendTableInvite(req.user!.sub, req.params.id, req.body.recipientId);
      sendSuccess(res, { message: 'Invite sent' });
    } catch (err: any) {
      if (err.code) sendError(res, err.code, err.message, 400);
      else sendServerError(res);
    }
  }
);

// ─── GET /tables/invites/pending ─────────────────────────────────────────────

lobbyRouter.get('/invites/pending', async (req: Request, res: Response) => {
  try {
    const invites = await lobbyService.getPendingInvites(req.user!.sub);
    sendSuccess(res, { invites });
  } catch (err: any) {
    sendServerError(res);
  }
});

// ─── POST /tables/invites/:id/respond ─────────────────────────────────────────

lobbyRouter.post('/invites/:id/respond',
  body('accept').isBoolean(),
  async (req: Request, res: Response) => {
    if (!handleValidation(req, res)) return;
    try {
      const result = await lobbyService.respondToInvite(
        req.user!.sub,
        req.params.id,
        req.body.accept
      );
      sendSuccess(res, result);
    } catch (err: any) {
      if (err.code) sendError(res, err.code, err.message, 400);
      else sendServerError(res);
    }
  }
);
