-- ─── Bot account rename: StackBot → StackBot_Alpha ──────────────────────────
--
-- The bot system is moving from a single `StackBot` user to a roster of
-- 8 NATO-phonetic profiles (see botService.ts BOT_PROFILES). This rename
-- preserves the original StackBot user row — and crucially its FK history
-- (TableSession rows, any hand-action audit trail) — by making it the
-- "Alpha" profile in the new scheme rather than deleting and recreating.
--
-- Idempotent: the UPDATE matches zero rows on fresh databases (no StackBot
-- row to rename) and on already-migrated databases (already renamed). The
-- `username` column is UNIQUE so the rename is safe even if a future
-- profile-seed migration also inserts StackBot_Alpha — it would conflict
-- there, not here.

UPDATE "users"
SET "username"    = 'StackBot_Alpha',
    "displayName" = 'Stack Bot Alpha'
WHERE "username" = 'StackBot';
