CREATE TABLE products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  image_url TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  sn INTEGER NOT NULL,
  code TEXT NOT NULL UNIQUE,
  checkcode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  scan_count INTEGER NOT NULL DEFAULT 0,
  first_scan_at TEXT,
  verify_count INTEGER NOT NULL DEFAULT 0,
  first_verify_at TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (batch_id, sn)
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label_id INTEGER REFERENCES labels(id),
  type TEXT NOT NULL,
  ip_hash TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_batches_product ON batches(product_id);
CREATE INDEX idx_labels_scan_count ON labels(scan_count);
CREATE INDEX idx_labels_verify_count ON labels(verify_count);
CREATE INDEX idx_events_label ON events(label_id, created_at);
