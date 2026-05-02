import { Router } from 'express';
import { requireAuth } from '../shared/middleware/auth.middleware';
import { addBotToTable } from './botService';
import { sendSuccess, sendError } from '../shared/utils';

export const botRouter = Router();

botRouter.use(requireAuth);

// POST /api/tables/:tableId/add-bot
botRouter.post('/:tableId/add-bot', async (req, res) => {
  try {
    const { tableId } = req.params;
    await addBotToTable(tableId);
    sendSuccess(res, { message: 'Bot added' });
  } catch (err: any) {
    sendError(res, 'BOT_ERROR', err.message ?? 'Failed to add bot', 400);
  }
});
