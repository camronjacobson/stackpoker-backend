import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import * as authService from './auth.service';
import { requireAuth } from '../shared/middleware/auth.middleware';
import { authRateLimit } from '../shared/middleware/rateLimit.middleware';
import { sendSuccess, sendError, sendServerError, logger } from '../shared/utils';

export const authRouter = Router();

// ─── Validation Rules ─────────────────────────────────────────────────────────

const registerValidation = [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('username').matches(/^[a-zA-Z0-9_]{3,20}$/).withMessage('Invalid username format'),
  body('displayName').isLength({ min: 2, max: 30 }),
  body('avatarId').isString().notEmpty(),
];

const loginValidation = [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
];

function handleValidation(req: Request, res: Response): boolean {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const first = errors.array()[0];
    sendError(res, 'VALIDATION_ERROR', first.msg as string, 422, (first as any).path);
    return false;
  }
  return true;
}

// ─── POST /auth/register ──────────────────────────────────────────────────────

authRouter.post('/register', authRateLimit, registerValidation, async (req: Request, res: Response) => {
  if (!handleValidation(req, res)) return;

  try {
    const deviceInfo = {
      deviceId: req.headers['x-device-id'] as string,
      deviceName: req.headers['x-device-name'] as string,
      ip: req.ip,
    };
    const result = await authService.register(req.body, deviceInfo);
    sendSuccess(res, result, 201);
  } catch (err: any) {
    if (err.code) {
      sendError(res, err.code, err.message, 409);
    } else {
      logger.error('Register error:', err);
      sendServerError(res);
    }
  }
});

// ─── POST /auth/login ─────────────────────────────────────────────────────────

authRouter.post('/login', authRateLimit, loginValidation, async (req: Request, res: Response) => {
  if (!handleValidation(req, res)) return;

  try {
    const deviceInfo = {
      deviceId: req.headers['x-device-id'] as string,
      deviceName: req.headers['x-device-name'] as string,
      ip: req.ip,
    };
    const result = await authService.login(req.body, deviceInfo);
    sendSuccess(res, result);
  } catch (err: any) {
    if (err.code === 'INVALID_CREDENTIALS') {
      sendError(res, err.code, err.message, 401);
    } else if (err.code) {
      sendError(res, err.code, err.message, 403);
    } else {
      logger.error('Login error:', err);
      sendServerError(res);
    }
  }
});

// ─── POST /auth/apple ─────────────────────────────────────────────────────────

authRouter.post('/apple', authRateLimit, async (req: Request, res: Response) => {
  try {
    const deviceInfo = {
      deviceId: req.headers['x-device-id'] as string,
      ip: req.ip,
    };
    const result = await authService.appleSignIn(req.body, deviceInfo);

    // If new user needs username, return 202 with the Apple data
    sendSuccess(res, result, result.isNewUser ? 201 : 200);
  } catch (err: any) {
    if (err.code === 'USERNAME_REQUIRED') {
      sendError(res, err.code, err.message, 202); // signal that username selection is needed
    } else if (err.code) {
      sendError(res, err.code, err.message, 400);
    } else {
      logger.error('Apple auth error:', err);
      sendServerError(res);
    }
  }
});

// ─── POST /auth/refresh ───────────────────────────────────────────────────────

authRouter.post('/refresh', async (req: Request, res: Response) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    sendError(res, 'MISSING_TOKEN', 'Refresh token required', 400);
    return;
  }

  try {
    const result = await authService.refreshTokens(refreshToken);
    sendSuccess(res, result);
  } catch (err: any) {
    if (err.code) {
      sendError(res, err.code, err.message, 401);
    } else {
      sendServerError(res);
    }
  }
});

// ─── POST /auth/logout ────────────────────────────────────────────────────────

authRouter.post('/logout', async (req: Request, res: Response) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    await authService.logout(refreshToken).catch(() => {});
  }
  sendSuccess(res, { message: 'Logged out successfully' });
});

// ─── GET /auth/username/check ─────────────────────────────────────────────────

authRouter.get('/username/check', async (req: Request, res: Response) => {
  const username = String(req.query.username || '');
  if (!username) {
    sendError(res, 'MISSING_PARAM', 'Username parameter required', 400);
    return;
  }

  const result = await authService.checkUsername(username);
  sendSuccess(res, result);
});

// ─── GET /auth/me ─────────────────────────────────────────────────────────────

authRouter.get('/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = await authService.getProfile(req.user!.sub);
    sendSuccess(res, user);
  } catch (err: any) {
    if (err.code === 'NOT_FOUND') {
      sendError(res, err.code, err.message, 404);
    } else {
      sendServerError(res);
    }
  }
});

// ─── PATCH /auth/me ───────────────────────────────────────────────────────────
// Update the current user's editable profile fields (avatar, display name).

authRouter.patch('/me',
  requireAuth,
  [
    body('avatarId').optional().isString().trim().isLength({ min: 1, max: 40 }),
    body('displayName').optional().isString().trim().isLength({ min: 2, max: 30 }),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const first = errors.array()[0];
      sendError(res, 'VALIDATION_ERROR', first.msg as string, 422);
      return;
    }
    try {
      const user = await authService.updateProfile(req.user!.sub, req.body);
      sendSuccess(res, user);
    } catch (err: any) {
      if (err.code) {
        sendError(res, err.code, err.message, 400);
      } else {
        sendServerError(res);
      }
    }
  }
);
