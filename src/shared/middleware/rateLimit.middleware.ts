import rateLimit from 'express-rate-limit';
import { Request, Response } from 'express';
import { sendError } from '../utils';

const isDev = process.env.NODE_ENV !== 'production';

// In dev, skip rate limiting entirely for requests from localhost / the iOS simulator
function skipLocalhostInDev(req: Request): boolean {
  if (!isDev) return false;
  const ip = req.ip ?? req.socket?.remoteAddress ?? '';
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1' ||
    ip.startsWith('192.168.') ||    // local network (simulator bridged)
    ip.startsWith('10.')             // local network
  );
}

// Strict: auth endpoints (login, register)
// Production: 10 per 15 min  |  Dev: 200 per 15 min (effectively no limit)
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 200 : (parseInt(process.env.AUTH_RATE_LIMIT_MAX ?? '10', 10)),
  skip: skipLocalhostInDev,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => {
    sendError(res, 'RATE_LIMITED', 'Too many requests, please try again later', 429);
  },
});

// Moderate: general API
// Production: 120/min  |  Dev: 1000/min
export const apiRateLimit = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: isDev ? 1000 : (parseInt(process.env.API_RATE_LIMIT_MAX ?? '120', 10)),
  skip: skipLocalhostInDev,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => {
    sendError(res, 'RATE_LIMITED', 'Too many requests', 429);
  },
});

// Strict: chip transfer
// Production: 20/hr  |  Dev: 200/hr
export const chipRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: isDev ? 200 : (parseInt(process.env.CHIP_RATE_LIMIT_MAX ?? '20', 10)),
  skip: skipLocalhostInDev,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => {
    sendError(res, 'RATE_LIMITED', 'Chip transfer limit reached. Try again in 1 hour', 429);
  },
});
