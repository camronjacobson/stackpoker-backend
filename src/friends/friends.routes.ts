import { Router, Request, Response } from 'express';
import { body, param, query, validationResult } from 'express-validator';
import * as friendsService from './friends.service';
import { requireAuth } from '../shared/middleware/auth.middleware';
import { sendSuccess, sendError, sendServerError } from '../shared/utils';

export const friendsRouter = Router();

friendsRouter.use(requireAuth);

function validate(req: Request, res: Response): boolean {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    sendError(res, 'VALIDATION_ERROR', errors.array()[0].msg as string, 422);
    return false;
  }
  return true;
}

// GET /friends
friendsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const friends = await friendsService.getFriends(req.user!.sub);
    sendSuccess(res, { friends });
  } catch { sendServerError(res); }
});

// GET /friends/requests
friendsRouter.get('/requests', async (req: Request, res: Response) => {
  try {
    const requests = await friendsService.getPendingRequests(req.user!.sub);
    sendSuccess(res, { requests });
  } catch { sendServerError(res); }
});

// POST /friends/request/:userId
friendsRouter.post('/request/:userId',
  param('userId').isUUID(),
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return;
    try {
      await friendsService.sendFriendRequest(req.user!.sub, req.params.userId);
      sendSuccess(res, { message: 'Friend request sent' }, 201);
    } catch (err: any) {
      if (err.code) sendError(res, err.code, err.message, 400);
      else sendServerError(res);
    }
  }
);

// POST /friends/:id/respond
friendsRouter.post('/:id/respond',
  body('accept').isBoolean(),
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return;
    try {
      await friendsService.respondToFriendRequest(req.user!.sub, req.params.id, req.body.accept);
      sendSuccess(res, { message: req.body.accept ? 'Friend added' : 'Request declined' });
    } catch (err: any) {
      if (err.code) sendError(res, err.code, err.message, 400);
      else sendServerError(res);
    }
  }
);

// DELETE /friends/:id
friendsRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    await friendsService.removeFriend(req.user!.sub, req.params.id);
    sendSuccess(res, { message: 'Friend removed' });
  } catch (err: any) {
    if (err.code) sendError(res, err.code, err.message, 400);
    else sendServerError(res);
  }
});

// POST /friends/block/:userId
friendsRouter.post('/block/:userId',
  param('userId').isUUID(),
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return;
    try {
      await friendsService.blockUser(req.user!.sub, req.params.userId);
      sendSuccess(res, { message: 'User blocked' });
    } catch { sendServerError(res); }
  }
);

// GET /friends/search?q=
friendsRouter.get('/search',
  query('q').isString().isLength({ min: 2 }),
  async (req: Request, res: Response) => {
    if (!validate(req, res)) return;
    try {
      const users = await friendsService.searchUsers(req.user!.sub, String(req.query.q));
      sendSuccess(res, { users });
    } catch { sendServerError(res); }
  }
);
