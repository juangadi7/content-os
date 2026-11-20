/**
 * Esquema de la base de datos propia de CONTENT OS.
 *
 * "externo"  = copiado de los archivos del generador; se sobrescribe en cada sincronización.
 * "propio"   = solo existe en CONTENT OS; el importador nunca lo pisa con datos del generador.
 */
export const MIGRATIONS: string[] = [
  /* 1 */ `
CREATE TABLE library_roots (
  id            INTEGER PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  last_sync_at  TEXT
);

CREATE TABLE campaigns (
  campaign_id         TEXT PRIMARY KEY,            -- externo: identidad
  root_id             INTEGER NOT NULL REFERENCES library_roots(id),
  folder_name         TEXT NOT NULL,               -- externo
  display_name        TEXT,                        -- externo: campaign.json "name"
  source_path         TEXT NOT NULL,               -- externo: carpeta de la campaña
  campaign_json_path  TEXT NOT NULL,               -- externo
  platform            TEXT,                        -- externo: campaign.json "platform"
  language            TEXT,                        -- externo
  campaign_id_origin  TEXT,                        -- externo: clip_ids | report | metadata
  report_date         TEXT,                        -- externo: campaign_report.json "date"
  clips_generated     INTEGER,                     -- externo: informe
  clips_rejected      INTEGER,                     -- externo: informe (solo el número)
  state               TEXT NOT NULL DEFAULT 'ok',  -- propio: ok | generating | empty | clips_empty | unreadable
  created_at          TEXT NOT NULL,               -- propio: primera importación
  updated_at          TEXT NOT NULL,               -- propio: último cambio de datos externos
  last_sync_at        TEXT NOT NULL,               -- propio
  present_in_source   INTEGER NOT NULL DEFAULT 1,  -- propio
  missing_since       TEXT                         -- propio
);
CREATE INDEX idx_campaigns_root ON campaigns(root_id);

CREATE TABLE clips (
  clip_id               TEXT PRIMARY KEY,          -- externo: identidad lógica
  campaign_id           TEXT NOT NULL REFERENCES campaigns(campaign_id),
  -- externo: METADATA\\clip_NNN.json
  metadata_version      INTEGER,
  filename              TEXT,
  full_path             TEXT,                      -- ruta que declaró el generador
  title                 TEXT,
  caption               TEXT,
  hashtags              TEXT,                      -- JSON
  language              TEXT,
  duration              REAL,
  source                TEXT,
  start_time            REAL,                      -- tramo final del clip
  end_time              REAL,
  score                 REAL,                      -- heredado del generador; puede ser NULL
  score_origin          TEXT,
  selection_reason      TEXT,
  prediction            TEXT,                      -- lo que traiga la ficha (hoy siempre NULL), JSON
  qa_score              REAL,
  status                TEXT,                      -- "status" del generador (hoy "READY")
  sha256                TEXT,
  created_at            TEXT,                      -- fin del render, según la ficha
  cover_second          REAL,
  metadata_errors       TEXT,                      -- JSON
  metadata_path         TEXT,
  metadata_json         TEXT,                      -- ficha completa
  -- externo: clip_ids.json (tramo pedido = ancla de la identidad)
  requested_start_time  REAL,
  requested_end_time    REAL,
  -- externo: QA\\clip_NNN.json emparejado con la ficha
  qa_path               TEXT,
  qa_summary            TEXT,                      -- JSON
  qa_sheet_path         TEXT,
  -- externo: portada junto a la ficha
  cover_path            TEXT,
  -- propio
  thumb_path            TEXT,                      -- copia de la portada en thumbs\\
  cover_size            INTEGER,
  cover_mtime_ms        INTEGER,
  resolved_path         TEXT,                      -- dónde está el MP4 realmente
  resolved_via          TEXT,                      -- campaign_clips | full_path | filename_search | sha_search
  file_state            TEXT NOT NULL DEFAULT 'unknown', -- ok | missing | hash_mismatch | unverified | unknown
  file_size             INTEGER,
  file_mtime_ms         INTEGER,
  file_sha256           TEXT,                      -- hash real calculado por CONTENT OS
  render_changed_at     TEXT,
  first_seen_at         TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  last_sync_at          TEXT NOT NULL,
  present_in_source     INTEGER NOT NULL DEFAULT 1,
  missing_since         TEXT
);
CREATE INDEX idx_clips_campaign ON clips(campaign_id);
CREATE INDEX idx_clips_sha ON clips(sha256);

CREATE TABLE publications (                        -- todo propio
  id                 INTEGER PRIMARY KEY,
  clip_id            TEXT NOT NULL REFERENCES clips(clip_id),
  platform           TEXT NOT NULL CHECK (platform IN ('youtube','instagram','tiktok')),
  account            TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT 'published',
  url                TEXT,
  published_at       TEXT,
  notes              TEXT,
  title_used         TEXT,
  caption_used       TEXT,
  sha256_at_publish  TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (clip_id, platform, account)
);
CREATE INDEX idx_publications_clip ON publications(clip_id);

CREATE TABLE analytics_snapshots (                 -- futuro: sin interfaz ni integración todavía
  id                         INTEGER PRIMARY KEY,
  publication_id             INTEGER NOT NULL REFERENCES publications(id),
  measured_at                TEXT NOT NULL,
  views                      INTEGER,
  likes                      INTEGER,
  comments                   INTEGER,
  shares                     INTEGER,
  saves                      INTEGER,
  followers_gained           INTEGER,
  watch_time_seconds         REAL,
  avg_view_duration_seconds  REAL,
  retention_pct              REAL,
  engagement_rate            REAL,
  origin                     TEXT NOT NULL DEFAULT 'manual',
  raw_json                   TEXT
);
CREATE INDEX idx_analytics_pub_time ON analytics_snapshots(publication_id, measured_at);

CREATE TABLE prediction_snapshots (                -- futuro: sin interfaz ni cálculo todavía
  id              INTEGER PRIMARY KEY,
  clip_id         TEXT NOT NULL REFERENCES clips(clip_id),
  created_at      TEXT NOT NULL,
  model_version   TEXT NOT NULL,
  score           REAL NOT NULL,
  scale           REAL NOT NULL DEFAULT 100,
  breakdown_json  TEXT,
  reason          TEXT,
  sha256          TEXT,
  is_current      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_predictions_clip ON prediction_snapshots(clip_id, is_current);

CREATE TABLE sync_runs (
  id              INTEGER PRIMARY KEY,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  status          TEXT NOT NULL,                   -- running | ok | ok_with_warnings | error
  roots_scanned   INTEGER NOT NULL DEFAULT 0,
  campaigns_seen  INTEGER NOT NULL DEFAULT 0,
  clips_seen      INTEGER NOT NULL DEFAULT 0,
  created         INTEGER NOT NULL DEFAULT 0,
  updated         INTEGER NOT NULL DEFAULT 0,
  disappeared     INTEGER NOT NULL DEFAULT 0,
  warnings        INTEGER NOT NULL DEFAULT 0,
  errors          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sync_events (
  id           INTEGER PRIMARY KEY,
  sync_run_id  INTEGER NOT NULL REFERENCES sync_runs(id),
  created_at   TEXT NOT NULL,
  level        TEXT NOT NULL,                      -- info | warning | error
  type         TEXT NOT NULL,                      -- clip_created, clip_updated, render_changed, clip_disappeared,
                                                   -- clip_reappeared, campaign_created, campaign_updated,
                                                   -- campaign_disappeared, campaign_reappeared, warning, error
  code         TEXT,                               -- detalle para warning/error (p. ej. metadata_without_clip_id)
  campaign_id  TEXT,
  clip_id      TEXT,
  path         TEXT,
  message      TEXT
);
CREATE INDEX idx_events_run ON sync_events(sync_run_id);
CREATE INDEX idx_events_clip ON sync_events(clip_id);

CREATE TABLE file_hashes (                         -- propio: evita recalcular SHA-256 si tamaño y fecha no cambian
  path       TEXT PRIMARY KEY,
  size       INTEGER NOT NULL,
  mtime_ms   INTEGER NOT NULL,
  sha256     TEXT NOT NULL,
  hashed_at  TEXT NOT NULL
);
`,
  /* 2 */ `
CREATE TABLE youtube_channels (                    -- propio: canales cuyos vídeos se descubren solos
  channel_id        TEXT PRIMARY KEY,              -- UC...
  handle            TEXT,                          -- @nombre
  title             TEXT,
  uploads_playlist  TEXT NOT NULL,
  added_at          TEXT NOT NULL,
  last_scan_at      TEXT
);

CREATE TABLE youtube_videos (                      -- propio: vídeos vistos en esos canales
  video_id          TEXT PRIMARY KEY,
  channel_id        TEXT NOT NULL REFERENCES youtube_channels(channel_id),
  title             TEXT,
  description       TEXT,
  published_at      TEXT,
  duration_seconds  REAL,
  publication_id    INTEGER REFERENCES publications(id),   -- NULL mientras no esté emparejado con un clip
  match_state       TEXT NOT NULL DEFAULT 'unmatched',     -- auto | manual | unmatched | ignored
  match_reason      TEXT,
  views             INTEGER,                       -- última cifra vista (también para los no emparejados)
  likes             INTEGER,
  comments          INTEGER,
  stats_at          TEXT,
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL
);
CREATE INDEX idx_ytvideos_channel ON youtube_videos(channel_id);
CREATE INDEX idx_ytvideos_publication ON youtube_videos(publication_id);
`,
  /* 3 */ `
-- propio: plazo de la campaña. El generador no sabe nada de esto.
ALTER TABLE campaigns ADD COLUMN ends_at TEXT;                       -- último día de plazo (AAAA-MM-DD), si se conoce
ALTER TABLE campaigns ADD COLUMN closed INTEGER NOT NULL DEFAULT 0;  -- 1 = el usuario la dio por cerrada
ALTER TABLE campaigns ADD COLUMN closed_at TEXT;
`,
  /* 4 */ `
-- propio: canales en los que se publica y cuántos clips al día admite cada uno (plan de «Hoy»).
CREATE TABLE accounts (
  id           INTEGER PRIMARY KEY,
  platform     TEXT NOT NULL CHECK (platform IN ('youtube','instagram','tiktok')),
  name         TEXT NOT NULL COLLATE NOCASE,        -- el mismo texto que publications.account
  daily_limit  INTEGER NOT NULL DEFAULT 3,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  UNIQUE (platform, name)
);
-- los canales que ya se usaron al marcar publicaciones entran solos
INSERT OR IGNORE INTO accounts (platform, name, created_at)
  SELECT platform, account, MIN(created_at) FROM publications WHERE account <> '' GROUP BY platform, account;
`,
  /* 5 */ `
-- propio: lo último leído de la lista pública de campañas de Vyro.
CREATE TABLE vyro_campaigns (
  vyro_id           TEXT PRIMARY KEY,
  slug              TEXT NOT NULL,
  brand             TEXT,
  name              TEXT,
  pay_rate          REAL,                          -- dólares por 1.000 visitas
  budget_total      REAL,
  budget_remaining  REAL,
  min_views         INTEGER,
  min_length        REAL,
  platforms         TEXT,                          -- JSON
  languages         TEXT,                          -- JSON
  hashtags          TEXT,                          -- JSON
  disclosure        TEXT,                          -- JSON
  material_links    TEXT,                          -- JSON
  status            TEXT,
  locked            INTEGER NOT NULL DEFAULT 0,
  starts_at         TEXT,
  ends_at           TEXT,
  created_at_vyro   TEXT,
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  present           INTEGER NOT NULL DEFAULT 1,    -- sigue en la lista de Vyro
  acknowledged_at   TEXT,                          -- NULL = nueva, aún sin ver
  campaign_id       TEXT REFERENCES campaigns(campaign_id),  -- campaña local enlazada
  link_state        TEXT NOT NULL DEFAULT 'none'   -- auto | manual | rejected | none
);
CREATE INDEX idx_vyro_campaign ON vyro_campaigns(campaign_id);

CREATE TABLE settings (                            -- propio: valores sueltos (última comprobación de Vyro…)
  key    TEXT PRIMARY KEY,
  value  TEXT
);
`,
  /* 6 */ `
-- propio: condiciones de pago de la campaña (se rellenan desde Vyro si está enlazada; se pueden corregir a mano).
ALTER TABLE campaigns ADD COLUMN pay_rate REAL;        -- dólares por 1.000 visitas
ALTER TABLE campaigns ADD COLUMN min_views INTEGER;    -- visitas mínimas para que un vídeo cobre
ALTER TABLE campaigns ADD COLUMN max_payout REAL;      -- tope de dólares por vídeo
UPDATE campaigns SET
  pay_rate = (SELECT v.pay_rate FROM vyro_campaigns v WHERE v.campaign_id = campaigns.campaign_id),
  min_views = (SELECT v.min_views FROM vyro_campaigns v WHERE v.campaign_id = campaigns.campaign_id);

-- propio: pedidos «hacer esta campaña» creados desde la pantalla de Vyro.
CREATE TABLE vyro_orders (
  vyro_id     TEXT PRIMARY KEY REFERENCES vyro_campaigns(vyro_id),
  created_at  TEXT NOT NULL,
  folder      TEXT NOT NULL,                       -- carpeta del pedido (fuera de CAMPAIGNS)
  notes       TEXT,                                -- reglas que no son públicas, pegadas por el usuario
  status      TEXT NOT NULL DEFAULT 'waiting',     -- waiting (esperando material) | ready (material completo)
  files       TEXT NOT NULL DEFAULT '[]',          -- JSON: rutas del material descargado
  ignored     TEXT NOT NULL DEFAULT '[]'           -- JSON: descargas que el usuario quitó de la lista
);
`,
  /* 7 */ `
-- externo: campaign.json "publish_checklist" (lo que hay que hacer al publicar según las reglas de la campaña), JSON.
ALTER TABLE campaigns ADD COLUMN publish_checklist TEXT;
`,
  /* 8 */ `
-- propio: qué canales publican cada campaña. Un canal con campañas asignadas solo recibe esas;
-- una campaña sin canales asignados en una plataforma va a los canales que no tienen ninguna asignada.
CREATE TABLE campaign_accounts (
  campaign_id  TEXT NOT NULL REFERENCES campaigns(campaign_id),
  account_id   INTEGER NOT NULL REFERENCES accounts(id),
  PRIMARY KEY (campaign_id, account_id)
);
CREATE INDEX idx_campaign_accounts_account ON campaign_accounts(account_id);
`,
  /* 9 */ `
-- propio: historial de cifras públicas de cada vídeo de los canales, esté o no emparejado con un clip (panel «Canales»).
CREATE TABLE youtube_video_snapshots (
  id           INTEGER PRIMARY KEY,
  video_id     TEXT NOT NULL REFERENCES youtube_videos(video_id),
  measured_at  TEXT NOT NULL,
  views        INTEGER,
  likes        INTEGER,
  comments     INTEGER
);
CREATE INDEX idx_ytsnap_video_time ON youtube_video_snapshots(video_id, measured_at);
-- lo que ya se había medido de los vídeos emparejados, y la última cifra vista de los demás
INSERT INTO youtube_video_snapshots (video_id, measured_at, views, likes, comments)
  SELECT y.video_id, s.measured_at, s.views, s.likes, s.comments FROM analytics_snapshots s
  JOIN youtube_videos y ON y.publication_id = s.publication_id WHERE s.origin = 'youtube_api' AND s.views IS NOT NULL;
INSERT INTO youtube_video_snapshots (video_id, measured_at, views, likes, comments)
  SELECT video_id, stats_at, views, likes, comments FROM youtube_videos
  WHERE publication_id IS NULL AND stats_at IS NOT NULL AND views IS NOT NULL;

-- propio: cifras públicas del canal (suscriptores, visitas totales, vídeos públicos) y su historial.
ALTER TABLE youtube_channels ADD COLUMN subscribers INTEGER;      -- NULL si el canal los oculta
ALTER TABLE youtube_channels ADD COLUMN total_views INTEGER;
ALTER TABLE youtube_channels ADD COLUMN video_count INTEGER;
ALTER TABLE youtube_channels ADD COLUMN stats_at TEXT;
CREATE TABLE youtube_channel_snapshots (
  id           INTEGER PRIMARY KEY,
  channel_id   TEXT NOT NULL REFERENCES youtube_channels(channel_id),
  measured_at  TEXT NOT NULL,
  subscribers  INTEGER,
  total_views  INTEGER,
  video_count  INTEGER
);
CREATE INDEX idx_ytchsnap_channel_time ON youtube_channel_snapshots(channel_id, measured_at);
`,
  /* 10 */ `
-- propio: tipo de canal. 'clips' = canal donde se publican clips (se empareja con ellos y cuenta en el plan y en
-- las estadísticas); 'personal' = canal del usuario ajeno a los clips: solo se miran sus cifras, en su propio apartado.
ALTER TABLE youtube_channels ADD COLUMN kind TEXT NOT NULL DEFAULT 'clips';
`,
  /* 11 */ `
-- propio: tareas que el usuario apunta en el calendario (día, hora opcional, texto, hecha o no).
CREATE TABLE calendar_tasks (
  id          INTEGER PRIMARY KEY,
  day         TEXT NOT NULL,          -- AAAA-MM-DD
  time        TEXT,                   -- HH:MM o NULL
  text        TEXT NOT NULL,
  done        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_caltasks_day ON calendar_tasks(day);
`,
  /* 12 */ `
-- propio: cuándo se envió cada publicación a Vyro («Add posts»). NULL = falta enviarla.
ALTER TABLE publications ADD COLUMN vyro_sent_at TEXT;
-- lo publicado hace más de un día ya se habrá enviado: no se pide de golpe todo el historial.
-- Lo de las últimas 24 horas y lo programado sí queda pendiente, por si acaso.
UPDATE publications SET vyro_sent_at = published_at
  WHERE published_at IS NOT NULL AND published_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day');
`,
  /* 13 */ `
-- propio: tus envíos tal como los ve Vyro («My submissions»), leídos con tu sesión. Solo lectura de Vyro.
CREATE TABLE vyro_submissions (
  vyro_clip_id     TEXT PRIMARY KEY,               -- id del envío en Vyro
  vyro_campaign_id TEXT NOT NULL,
  platform         TEXT NOT NULL,
  video_id         TEXT,                           -- id del vídeo en su plataforma
  video_url        TEXT,
  username         TEXT,                           -- cuenta con la que se publicó
  status           TEXT,                           -- pending | active | rejected | …
  views            INTEGER,
  likes            INTEGER,
  comments         INTEGER,
  earned           REAL,                           -- dólares que cuenta Vyro
  cpm              REAL,
  error            TEXT,
  submitted_at     TEXT,
  metrics_at       TEXT,
  synced_at        TEXT NOT NULL,
  publication_id   INTEGER REFERENCES publications(id)
);
CREATE INDEX idx_vyrosub_pub ON vyro_submissions(publication_id);
`,
  /* 14 */ `
-- propio: 1 = lo marcaste TÚ como enviado a Vyro (botón «Enviado»/«Ya lo envié»); 0 = lo puso la app (al leer Vyro o al instalar).
ALTER TABLE publications ADD COLUMN vyro_sent_manual INTEGER NOT NULL DEFAULT 0;
`,
  /* 15 */ `
-- propio: tus cuentas de TikTok e Instagram leídas con sus API oficiales (solo lectura), como los canales de YouTube.
CREATE TABLE social_accounts (
  platform      TEXT NOT NULL CHECK (platform IN ('tiktok','instagram')),
  account       TEXT NOT NULL,                     -- @nombre (el mismo texto que publications.account)
  display_name  TEXT,
  followers     INTEGER,
  total_likes   INTEGER,
  video_count   INTEGER,
  stats_at      TEXT,
  last_scan_at  TEXT,
  error         TEXT,                              -- último fallo al leerla (NULL = bien)
  PRIMARY KEY (platform, account)
);
CREATE TABLE social_account_snapshots (
  id            INTEGER PRIMARY KEY,
  platform      TEXT NOT NULL,
  account       TEXT NOT NULL,
  measured_at   TEXT NOT NULL,
  followers     INTEGER,
  video_count   INTEGER
);
CREATE TABLE social_videos (
  platform          TEXT NOT NULL CHECK (platform IN ('tiktok','instagram')),
  video_id          TEXT NOT NULL,
  account           TEXT NOT NULL,
  url               TEXT,
  description       TEXT,
  published_at      TEXT,
  duration_seconds  REAL,
  views             INTEGER,                       -- NULL = la plataforma no lo da (Instagram, de momento)
  likes             INTEGER,
  comments          INTEGER,
  shares            INTEGER,
  stats_at          TEXT,
  publication_id    INTEGER REFERENCES publications(id),
  match_state       TEXT NOT NULL DEFAULT 'unmatched',     -- auto | manual | unmatched | review | ignored
  match_reason      TEXT,
  first_seen_at     TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  PRIMARY KEY (platform, video_id)
);
CREATE INDEX idx_social_videos_pub ON social_videos(publication_id);
CREATE TABLE social_video_snapshots (
  id           INTEGER PRIMARY KEY,
  platform     TEXT NOT NULL,
  video_id     TEXT NOT NULL,
  measured_at  TEXT NOT NULL,
  views        INTEGER,
  likes        INTEGER,
  comments     INTEGER,
  shares       INTEGER
);
CREATE INDEX idx_social_snap_video ON social_video_snapshots(platform, video_id, measured_at);
`,
  /* 16 */ `
-- propio: cuándo dejó de aparecer el vídeo en su cuenta (lo borraste o lo hiciste privado). NULL = sigue publicado.
ALTER TABLE social_videos ADD COLUMN removed_at TEXT;
`,
  /* 17 */ `
-- propio (16-nov-2026): canales propios (GTA 6, Curiosidades, Historias Roblox).
-- Cuentas de cada canal en cada red (las apunta el usuario en la app).
CREATE TABLE own_accounts (
  id          INTEGER PRIMARY KEY,
  channel     TEXT NOT NULL,                         -- gta | curio | roblox
  platform    TEXT NOT NULL CHECK (platform IN ('tiktok','youtube','instagram')),
  account     TEXT NOT NULL COLLATE NOCASE,          -- @nombre
  created_at  TEXT NOT NULL,
  UNIQUE (channel, platform, account)
);
-- Dónde se ha subido cada vídeo: una fila por vídeo y red, con la cuenta y quién lo apuntó.
CREATE TABLE own_posts (
  id          INTEGER PRIMARY KEY,
  channel     TEXT NOT NULL,
  video       TEXT NOT NULL,                         -- carpeta del vídeo (VIDEOS_GTA6/<carpeta>, etc.)
  platform    TEXT NOT NULL CHECK (platform IN ('tiktok','youtube','instagram')),
  account     TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  url         TEXT,
  ext_id      TEXT,                                  -- id del vídeo en la red (para leer sus cifras de la API)
  posted_at   TEXT,
  source      TEXT NOT NULL DEFAULT 'manual',        -- manual | api | metricool: de dónde sale la subida
  created_at  TEXT NOT NULL,
  UNIQUE (channel, video, platform)
);
-- Cifras apuntadas a mano (o que traiga Metricool): la retención solo llega así de momento.
CREATE TABLE own_post_stats (
  id           INTEGER PRIMARY KEY,
  post_id      INTEGER NOT NULL REFERENCES own_posts(id) ON DELETE CASCADE,
  measured_at  TEXT NOT NULL,
  views        INTEGER,
  likes        INTEGER,
  comments     INTEGER,
  shares       INTEGER,
  retention    REAL,                                 -- % medio visto (0-100)
  origin       TEXT NOT NULL DEFAULT 'manual'
);
CREATE INDEX idx_own_post_stats ON own_post_stats(post_id, measured_at);
`,
  /* 18 */ `
-- propio (17-nov-2026, para la fábrica de Curiosidades): datos de YouTube Studio que no da ninguna API, apuntados a mano.
ALTER TABLE own_post_stats ADD COLUMN viewed_pct REAL;     -- «Vieron vs. deslizaron»: % que se quedó a verlo (0-100)
ALTER TABLE own_post_stats ADD COLUMN avg_view_s REAL;     -- duración media vista, en segundos
`
]

export const SCHEMA_VERSION = MIGRATIONS.length
