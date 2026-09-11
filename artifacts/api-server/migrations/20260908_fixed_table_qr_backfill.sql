-- Permanent table QR: tables.qr_code_url becomes a FIXED per-table path that
-- is never rewritten, so a printed sticker lasts as long as the table does.
--
-- Stored value is the path only (/t/{table_id}); the public domain is added by
-- the API from PUBLIC_APP_URL. Keeping the domain out of the database means a
-- domain change never requires a data migration - and never silently bakes the
-- Replit dev domain into thousands of stickers.
--
-- Idempotent: rerunning it changes nothing once every row already matches.
--
-- OPERATIONAL NOTE: any sticker already printed from the old token-based URL
-- stops matching after this runs and must be reprinted once. In this database
-- every tables.qr_code_url is currently NULL, so nothing has been printed yet
-- and there is nothing to replace - the reprint only applies if you printed
-- stickers outside this system.

UPDATE public.tables
SET qr_code_url = '/t/' || id::text
WHERE qr_code_url IS DISTINCT FROM '/t/' || id::text;

-- Check afterwards: this must return 0 rows.
-- SELECT id, table_number, qr_code_url
-- FROM public.tables
-- WHERE qr_code_url IS DISTINCT FROM '/t/' || id::text;
