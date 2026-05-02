import { Router, Request, Response } from 'express';
import { body, param } from 'express-validator';
import * as adminService from './admin.service';
import { requireAuth } from '../shared/middleware/auth.middleware';
import { sendSuccess, sendError, sendServerError } from '../shared/utils';
import { validationResult } from 'express-validator';

export const adminRouter = Router();
adminRouter.use(requireAuth);

function validate(req: Request, res: Response): boolean {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    sendError(res, 'VALIDATION_ERROR', errors.array()[0].msg as string, 422);
    return false;
  }
  return true;
}

// POST /admin/tables/:tableId/kick
adminRouter.post('/tables/:tableId/kick',
  body('targetUserId').isUUID(),
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return;
    try {
      await adminService.kickPlayer(req.user!.sub, req.params.tableId, req.body.targetUserId);
      sendSuccess(res, { message: 'Player kicked' });
    } catch (err: any) {
      if (err.code) sendError(res, err.code, err.message, 403);
      else sendServerError(res);
    }
  }
);

// POST /admin/tables/:tableId/reset
adminRouter.post('/tables/:tableId/reset', async (req: Request, res: Response) => {
  try {
    await adminService.resetTable(req.user!.sub, req.params.tableId);
    sendSuccess(res, { message: 'Table reset' });
  } catch (err: any) {
    if (err.code) sendError(res, err.code, err.message, 403);
    else sendServerError(res);
  }
});

// GET /admin/tables/:tableId
adminRouter.get('/tables/:tableId', async (req: Request, res: Response) => {
  try {
    const view = await adminService.getTableAdminView(req.user!.sub, req.params.tableId);
    sendSuccess(res, view);
  } catch (err: any) {
    if (err.code) sendError(res, err.code, err.message, 403);
    else sendServerError(res);
  }
});

// POST /admin/users/:userId/ban
adminRouter.post('/users/:userId/ban',
  body('reason').isString().isLength({ min: 3, max: 200 }),
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return;
    try {
      await adminService.banPlayer(req.user!.sub, req.params.userId, req.body.reason);
      sendSuccess(res, { message: 'Player banned' });
    } catch (err: any) {
      if (err.code) sendError(res, err.code, err.message, 403);
      else sendServerError(res);
    }
  }
);

// POST /admin/users/:userId/unban
adminRouter.post('/users/:userId/unban', async (req: Request, res: Response) => {
  try {
    await adminService.unbanPlayer(req.user!.sub, req.params.userId);
    sendSuccess(res, { message: 'Player unbanned' });
  } catch (err: any) {
    if (err.code) sendError(res, err.code, err.message, 403);
    else sendServerError(res);
  }
});

// POST /admin/users/:userId/grant-chips
adminRouter.post('/users/:userId/grant-chips',
  body('amount').isInt({ min: 1, max: 10_000_000 }),
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return;
    try {
      await adminService.grantChips(req.user!.sub, req.params.userId, req.body.amount);
      sendSuccess(res, { message: `Chips granted` });
    } catch (err: any) {
      if (err.code) sendError(res, err.code, err.message, 403);
      else sendServerError(res);
    }
  }
);
