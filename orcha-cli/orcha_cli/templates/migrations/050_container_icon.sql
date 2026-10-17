-- D14: a per-project cosmetic icon, shared by the portal and the desktop app.
--
-- Shape (validated by the API, never read by any server-side logic):
--   {"kind": "emoji", "value": "🚀"}
--   {"kind": "glyph", "value": "<glyph name>", "color": 0-9 | null}
-- NULL = unset (both apps draw the neutral default glyph — never initials).
-- ADD-only: existing projects keep NULL; nothing is reset or migrated.
ALTER TABLE containers ADD COLUMN IF NOT EXISTS icon JSONB NULL;
