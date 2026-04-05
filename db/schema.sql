-- digitalhome-edge shared memory database
-- SQLite — initialise with: sqlite3 digitalhome.db < schema.sql

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- ── Knowledge base ────────────────────────────────────────────────────────────
-- Persistent memory shared across all Claude agents.
-- Agents read this before acting; write to it when they discover something new.

CREATE TABLE IF NOT EXISTS knowledge (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    type         TEXT NOT NULL CHECK(type IN (
                     'practice',    -- recommended approach
                     'limitation',  -- known constraint or bug
                     'device_note', -- device-specific behaviour
                     'automation',  -- automation pattern that works
                     'incident'     -- something that went wrong + resolution
                 )),
    topic        TEXT NOT NULL,   -- short subject tag, e.g. 'homematic', 'hue', 'heating'
    content      TEXT NOT NULL,   -- full description
    tags         TEXT,            -- comma-separated additional tags
    source_agent TEXT,            -- which agent wrote this
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
    type, topic, content, tags,
    content='knowledge',
    content_rowid='id'
);

-- keep FTS in sync
CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge BEGIN
    INSERT INTO knowledge_fts(rowid, type, topic, content, tags)
    VALUES (new.id, new.type, new.topic, new.content, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge BEGIN
    INSERT INTO knowledge_fts(knowledge_fts, rowid, type, topic, content, tags)
    VALUES ('delete', old.id, old.type, old.topic, old.content, old.tags);
    INSERT INTO knowledge_fts(rowid, type, topic, content, tags)
    VALUES (new.id, new.type, new.topic, new.content, new.tags);
END;


-- ── Agent log ─────────────────────────────────────────────────────────────────
-- Audit trail of every significant agent decision.
-- Agents write here after each action; other agents can learn from outcomes.

CREATE TABLE IF NOT EXISTS agent_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id     TEXT NOT NULL,   -- e.g. 'claude-edge-01', 'scheduler'
    action       TEXT NOT NULL,   -- human-readable description of what was attempted
    tool_called  TEXT,            -- MCP tool name used
    payload      TEXT,            -- JSON payload sent (optional)
    result       TEXT,            -- JSON or text result received
    outcome      TEXT CHECK(outcome IN ('success', 'failure', 'partial')),
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);


-- ── Device registry ───────────────────────────────────────────────────────────
-- Canonical list of all smarthome devices. Agents read this to find addresses.
-- Updated by Node-RED or manually; not auto-discovered.

CREATE TABLE IF NOT EXISTS device (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL UNIQUE,  -- human name, e.g. 'living-room-ceiling'
    protocol     TEXT NOT NULL CHECK(protocol IN ('homematic', 'hue', 'other')),
    address      TEXT NOT NULL,         -- CCU serial e.g. 'LEQ1234567:1', or Hue light ID
    room         TEXT,                  -- e.g. 'living-room', 'bedroom', 'kitchen'
    type         TEXT,                  -- simple category: 'light', 'switch', 'thermostat', 'shutter'
    dhc_class    TEXT,                  -- DHC T-Box class: 'Light', 'Switch', 'Thermostat', 'Sensor', 'Actor', 'Controller', 'Socket', 'Gateway'
    design_view  TEXT,                  -- DHC design view: 'electrical', 'heating', 'network', 'automation'
    capability   TEXT,                  -- 'sensor', 'actor', 'controller' (comma-separated if multiple)
    model        TEXT,                  -- hardware model: 'HM-CC-RT-DN', 'LTG002', etc.
    manufacturer TEXT,                  -- 'Homematic', 'Philips', 'Innr', etc.
    ccu_ise_id   TEXT,                  -- CCU XML-API ise_id for cross-reference
    hue_unique_id TEXT,                 -- Hue Zigbee unique ID
    last_seen    TEXT,
    notes        TEXT
);


-- ── Seed: known limitations from initial setup ────────────────────────────────

INSERT OR IGNORE INTO knowledge (type, topic, content, source_agent) VALUES
    ('limitation', 'homematic',
     'LEVEL datapoint (dimmers, shutters) uses float 0.0–1.0, not integer 0–100.',
     'setup'),
    ('limitation', 'homematic',
     'Polling CCU faster than once per second causes BidCos-RF bus instability.',
     'setup'),
    ('practice', 'hue',
     'Dim bulbs to brightness 1 before turning off to extend bulb life.',
     'setup'),
    ('practice', 'nodered',
     'All device control must go through Node-RED HTTP-in endpoints. Never call CCU or Hue Bridge directly from the MCP server.',
     'setup');
