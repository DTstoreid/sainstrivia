-- Skema Cloudflare D1 (LOBBY_DB) untuk SainsTrivia Hybrid
-- Catatan: Worker src/index.js juga otomatis membuat tabel ini saat pertama kali berjalan.

CREATE TABLE IF NOT EXISTS lobbies (
  code TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lobbies_updated_at ON lobbies(updated_at);

CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
