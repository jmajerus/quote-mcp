-- A concept's former slugs (src/snapshot.ts SNAPSHOT_SCHEMA), so a link made before a slug change still resolves.
ALTER TABLE concepts ADD COLUMN former_slugs TEXT NOT NULL DEFAULT '[]';
