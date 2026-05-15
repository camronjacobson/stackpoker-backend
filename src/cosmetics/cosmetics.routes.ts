import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import * as cosmeticsService from './cosmetics.service';
import { requireAuth } from '../shared/middleware/auth.middleware';
import { chipRateLimit } from '../shared/middleware/rateLimit.middleware';
import { sendSuccess, sendError, sendServerError } from '../shared/utils';

export const cosmeticsRouter = Router();
cosmeticsRouter.use(requireAuth);

// POST /cosmetics/purchase
//
// Body: { cosmeticId: string, expectedPrice?: string }
//   - cosmeticId — catalog id, e.g. "card_back_classic_red"
//   - expectedPrice — optional BigInt-as-string; if present, server enforces
//     equality with cosmetic.priceChips. Critical safety check against
//     catalog/client drift; once iOS sends it consistently, drop the
//     `.optional()` to make it required.
//
// Response: { newBalance: string, ownedCosmeticId: string, granted: true }
//
// Errors (code / status):
//   COSMETIC_NOT_FOUND         404 — unknown cosmeticId
//   COSMETIC_NOT_PURCHASABLE   409 — unlockCondition != 'purchase' (achievement/etc.)
//   COSMETIC_NOT_AVAILABLE     410 — limited-time window closed
//   PRICE_MISMATCH             409 — expectedPrice != server priceChips
//   INSUFFICIENT_CHIPS         400 — balance < price (atomic check)
//   ALREADY_OWNED              409 — unique constraint violation
//   RATE_LIMITED               429 — chipRateLimit middleware
//   VALIDATION_ERROR           422 — express-validator
//   SERVER_ERROR               500 — anything unexpected
cosmeticsRouter.post('/purchase',
  chipRateLimit,
  [
    body('cosmeticId').isString().trim().isLength({ min: 1, max: 200 }),
    body('expectedPrice').optional().isString().matches(/^\d+$/), // BigInt-as-decimal-string
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      sendError(res, 'VALIDATION_ERROR', errors.array()[0].msg as string, 422);
      return;
    }
    try {
      const result = await cosmeticsService.purchaseCosmetic(
        req.user!.sub,
        req.body.cosmeticId,
        req.body.expectedPrice,
      );
      sendSuccess(res, result);
    } catch (e: any) {
      // CodedError from service — use its status code.
      if (e && typeof e.code === 'string' && typeof e.status === 'number') {
        sendError(res, e.code, e.message, e.status);
        return;
      }
      sendServerError(res);
    }
  }
);
