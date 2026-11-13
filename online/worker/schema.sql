-- Boxshelf Online · esquema D1 (SQLite). Se aplica una vez: wrangler d1 execute boxshelf-online --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS users (
  code        TEXT PRIMARY KEY,          -- 12 dígitos, el código de amigo
  name        TEXT NOT NULL,
  name_lower  TEXT NOT NULL,             -- nombres únicos sin importar mayúsculas
  description TEXT DEFAULT '',
  avatar      TEXT DEFAULT '',
  banner      TEXT DEFAULT '',
  favorites   TEXT DEFAULT '[]',         -- JSON: lista de ids favoritos
  totalMs     INTEGER DEFAULT 0,
  passwordHash TEXT DEFAULT '',
  email       TEXT DEFAULT '',
  email_lower TEXT DEFAULT '',
  emailVerified INTEGER DEFAULT 0,
  playing     TEXT DEFAULT '',           -- "jugando ahora" (fase 3)
  tokenHash   TEXT NOT NULL,             -- la única llave de la cuenta; el token nunca se guarda tal cual
  createdAt   INTEGER,
  updatedAt   INTEGER DEFAULT 0,
  friends     TEXT DEFAULT '[]',         -- JSON: códigos mutuos
  incoming    TEXT DEFAULT '[]',         -- JSON: solicitudes recibidas
  outgoing    TEXT DEFAULT '[]'          -- JSON: solicitudes enviadas
);
CREATE INDEX IF NOT EXISTS idx_users_name  ON users(name_lower);
CREATE INDEX IF NOT EXISTS idx_users_token ON users(tokenHash);

-- registro de altas: unas cuantas por IP y hora, para que nadie cultive códigos
CREATE TABLE IF NOT EXISTS reglog (ip TEXT, at INTEGER);
CREATE INDEX IF NOT EXISTS idx_reglog ON reglog(at);

-- verificaciones de correo pendientes (código de 6 dígitos que vence en 10 min)
CREATE TABLE IF NOT EXISTS pending_verifications (
  email     TEXT PRIMARY KEY,
  code      TEXT NOT NULL,
  name      TEXT NOT NULL,
  password  TEXT NOT NULL,
  expiresAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email_lower);
