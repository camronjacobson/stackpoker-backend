import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import * as chipsService from './chips.service';
import { requireAuth } from '../shared/middleware/auth.middleware';
import { chipRateLimit } from '../shared/middleware/rateLimit.middleware';
import { sendSuccess, sendError, sendServerError } from '../shared/utils';

export const chipsRouter = Router();
chipsRouter.use(requireAuth);

// GET /chips/balance
chipsRouter.get('/balance', async (req: Request, res: Response) => {
  try {
    const result = await chipsService.getBalance(req.user!.sub);
    sendSuccess(res, result);
  } catch (err: any) {
    if (err.code) sendError(res, err.code, err.message, 400);
    else sendServerError(res);
  }
});

// POST /chips/daily
chipsRouter.post('/daily', async (req: Request, res: Response) => {
  try {
    const result = await chipsService.claimDailyBonus(req.user!.sub);
    sendSuccess(res, result);
  } catch (err: any) {
    if (err.code) sendError(res, err.code, err.message, 400);
    else sendServerError(res);
  }
});

// POST /chips/transfer
chipsRouter.post('/transfer',
  chipRateLimit,
  [
    body('recipientId').isUUID(),
    body('amount').isInt({ min: 100, max: 1_000_000 }),
    body('note').optional().isString().isLength({ max: 100 }),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, 'VALIDATION_ERROR', errors.array()[0].msg as string, 422);
      return;
    }
    try {
      const result = await chipsService.transferChips(
        req.user!.sub,
        req.body.recipientId,
        req.body.amount,
        req.body.note
      );
      sendSuccess(res, result);
    } catch (err: any) {
      if (err.code) sendError(res, err.code, err.message, 400);
      else sendServerError(res);
    }
  }
);

// GET /chips/history
chipsRouter.get('/history', async (req: Request, res: Response) => {
  try {
    const result = await chipsService.getHistory(
      req.user!.sub,
      parseInt(String(req.query.page || '1')),
      parseInt(String(req.query.limit || '20'))
    );
    sendSuccess(res, result);
  } catch (err: any) {
    sendServerError(res);
  }
});
