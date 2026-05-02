import winston from 'winston';
import { Response } from 'express';
import { ApiResponse, ApiError } from '../types';

// ─── Logger ───────────────────────────────────────────────────────────────────

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.colorize(),
    winston.format.printf(({ timestamp, level, message, stack }) => {
      return `${timestamp} [${level}]: ${stack || message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

// ─── Response Helpers ─────────────────────────────────────────────────────────

export function sendSuccess<T>(res: Response, data: T, statusCode = 200): Response {
  const body: ApiResponse<T> = { success: true, data };
  return res.status(statusCode).json(body);
}

export function sendError(res: Response, code: string, message: string, statusCode = 400, field?: string): Response {
  const error: ApiError = { code, message, field };
  const body: ApiResponse = { success: false, error };
  return res.status(statusCode).json(body);
}

export function sendUnauthorized(res: Response, message = 'Unauthorized'): Response {
  return sendError(res, 'UNAUTHORIZED', message, 401);
}

export function sendForbidden(res: Response, message = 'Forbidden'): Response {
  return sendError(res, 'FORBIDDEN', message, 403);
}

export function sendNotFound(res: Response, resource = 'Resource'): Response {
  return sendError(res, 'NOT_FOUND', `${resource} not found`, 404);
}

export function sendServerError(res: Response, message = 'Internal server error'): Response {
  return sendError(res, 'SERVER_ERROR', message, 500);
}

// ─── BigInt Serializer ────────────────────────────────────────────────────────

// Prisma returns BigInt for chip balances — serialize them as strings
export function serializeBigInt<T>(obj: T): T {
  return JSON.parse(
    JSON.stringify(obj, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    )
  );
}

// ─── Pagination ───────────────────────────────────────────────────────────────

export function parsePagination(query: Record<string, string | string[] | undefined>) {
  const page = Math.max(1, parseInt(String(query.page || '1')));
  const limit = Math.min(100, Math.max(1, parseInt(String(query.limit || '20'))));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

// ─── Username Validation ─────────────────────────────────────────────────────

export function isValidUsername(username: string): boolean {
  return /^[a-zA-Z0-9_]{3,20}$/.test(username);
}

export function isValidDisplayName(name: string): boolean {
  return name.length >= 2 && name.length <= 30;
}

// ─── Chip Utils ───────────────────────────────────────────────────────────────

export function formatChips(amount: bigint | number | string): string {
  const n = BigInt(amount);
  if (n >= 1_000_000n) return `${(Number(n) / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000n) return `${(Number(n) / 1_000).toFixed(1)}K`;
  return n.toString();
}
