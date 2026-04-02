import express from "express";
import session from "express-session";
import SQLiteStoreFactory from "connect-sqlite3";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const dataDir = path.resolve(rootDir, process.env.DATA_DIR || "data");
const dbPath = path.join(dataDir, "expense-tracker.db");

fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

initializeDatabase();

const app = express();
const SQLiteStore = SQLiteStoreFactory(session);
const isProduction = process.env.NODE_ENV === "production";

app.use(express.json({ limit: "1mb" }));
app.set("trust proxy", 1);
app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-this-secret-before-production",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction,
      maxAge: 1000 * 60 * 60 * 24 * 7
    },
    store: new SQLiteStore({
      db: "sessions.sqlite",
      dir: dataDir
    })
  })
);

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

if (isProduction && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === "change-this-secret-before-production")) {
  throw new Error("SESSION_SECRET must be set to a strong unique value in production.");
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.post("/api/auth/register", asyncHandler(async (req, res) => {
  const { name, email, phone, pin } = req.body ?? {};
  validatePhone(phone);
  validatePin(pin);
  const profile = sanitizeProfilePayload({ name, email });
  const existing = db.prepare("SELECT id FROM users WHERE phone = ?").get(phone);
  if (existing) return res.status(409).json({ error: "Phone number already registered." });
  const totalUsers = db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
  const role = totalUsers === 0 ? "admin" : "user";
  const pinHash = await bcrypt.hash(pin, 10);
  const createdAt = new Date().toISOString();
  const result = db.prepare("INSERT INTO users (phone, pin_hash, role, blocked, created_at) VALUES (?, ?, ?, 0, ?)").run(phone, pinHash, role, createdAt);
  const userId = result.lastInsertRowid;
  db.prepare("INSERT INTO profiles (user_id, name, email, address, company_name, company_email, company_phone, company_address) VALUES (?, ?, ?, ?, '', '', '', '')").run(userId, profile.name, profile.email, profile.address);
  db.prepare("INSERT INTO members (user_id, name, relation, is_primary) VALUES (?, 'Me', 'Primary user', 1)").run(userId);
  req.session.userId = userId;
  res.status(201).json(buildSessionPayload(userId));
}));

app.post("/api/auth/login", asyncHandler(async (req, res) => {
  const { phone, pin } = req.body ?? {};
  validatePhone(phone);
  validateLoginPin(pin);
  const user = db.prepare("SELECT id, pin_hash, blocked FROM users WHERE phone = ?").get(phone);
  if (!user || !(await bcrypt.compare(pin, user.pin_hash))) {
    return res.status(401).json({ error: "Invalid phone number or PIN." });
  }
  if (user.blocked) return res.status(403).json({ error: "Your account has been blocked. Please contact the admin." });
  req.session.userId = user.id;
  res.json(buildSessionPayload(user.id));
}));

app.post("/api/auth/request-reset", (req, res) => {
  const { phone } = req.body ?? {};
  validatePhone(phone);
  const user = db.prepare("SELECT id FROM users WHERE phone = ?").get(phone);
  if (!user) return res.json({ ok: true });
  const openRequest = db.prepare("SELECT id FROM reset_requests WHERE user_id = ? AND status = 'pending'").get(user.id);
  if (!openRequest) {
    db.prepare("INSERT INTO reset_requests (user_id, requested_at, status) VALUES (?, ?, 'pending')").run(user.id, new Date().toISOString());
  }
  res.json({ ok: true, message: "Reset request sent to admin." });
});

app.post("/api/auth/logout", requireAuth, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json(buildSessionPayload(req.session.userId));
});

app.put("/api/account/profile", requireAuth, (req, res) => {
  const payload = sanitizeProfilePayload(req.body ?? {});
  db.prepare(`
    UPDATE profiles
    SET name = ?, email = ?, address = ?, gstin = ?
    WHERE user_id = ?
  `).run(payload.name, payload.email, payload.address, payload.gstin, req.session.userId);
  res.json({ ok: true });
});

app.post("/api/account/change-pin", requireAuth, asyncHandler(async (req, res) => {
  const { currentPin, newPin } = req.body ?? {};
  validateLoginPin(currentPin);
  validatePin(newPin);
  const user = db.prepare("SELECT pin_hash FROM users WHERE id = ?").get(req.session.userId);
  if (!(await bcrypt.compare(currentPin, user.pin_hash))) {
    return res.status(400).json({ error: "Current PIN is incorrect." });
  }
  db.prepare("UPDATE users SET pin_hash = ? WHERE id = ?").run(await bcrypt.hash(newPin, 10), req.session.userId);
  res.json({ ok: true });
}));

app.post("/api/account/delete", requireAuth, asyncHandler(async (req, res) => {
  const { passcode } = req.body ?? {};
  validateLoginPin(passcode);
  const user = db.prepare("SELECT pin_hash FROM users WHERE id = ?").get(req.session.userId);
  if (!user || !(await bcrypt.compare(passcode, user.pin_hash))) {
    return res.status(400).json({ error: "Passcode is incorrect." });
  }
  db.prepare("DELETE FROM users WHERE id = ?").run(req.session.userId);
  req.session.destroy(() => res.json({ ok: true }));
}));

app.post("/api/account/import-legacy", requireAuth, (req, res) => {
  const summary = importLegacyData(req.session.userId, req.body ?? {});
  res.json({ ok: true, summary });
});

app.get("/api/dashboard", requireAuth, (req, res) => {
  const month = String(req.query.month || currentMonthValue());
  res.json({
    user: buildSessionPayload(req.session.userId).user,
    profile: getProfile(req.session.userId),
    members: getMembers(req.session.userId),
    incomes: listRows("incomes", req.session.userId),
    emis: listRows("emis", req.session.userId),
    expenses: listRows("expenses", req.session.userId),
    goals: getGoals(req.session.userId),
    invoices: getInvoices(req.session.userId),
    report: buildMonthlyReport(req.session.userId, month)
  });
});

app.post("/api/members", requireAuth, (req, res) => {
  const payload = sanitizeMemberPayload(req.body ?? {});
  const result = db.prepare("INSERT INTO members (user_id, name, relation, is_primary) VALUES (?, ?, ?, 0)").run(req.session.userId, payload.name, payload.relation);
  res.status(201).json({ id: result.lastInsertRowid, ...payload, isPrimary: false });
});

app.put("/api/members/:id", requireAuth, (req, res) => {
  const member = ensureMemberOwnership(req.session.userId, req.params.id);
  const payload = sanitizeMemberPayload(req.body ?? {});
  db.prepare("UPDATE members SET name = ?, relation = ? WHERE id = ? AND user_id = ?").run(payload.name, payload.relation, member.id, req.session.userId);
  res.json({ ok: true });
});

app.delete("/api/members/:id", requireAuth, (req, res) => {
  const member = ensureMemberOwnership(req.session.userId, req.params.id);
  if (member.is_primary) return res.status(400).json({ error: "Primary member cannot be removed." });
  db.prepare("DELETE FROM members WHERE id = ? AND user_id = ?").run(member.id, req.session.userId);
  res.json({ ok: true });
});

app.post("/api/incomes", requireAuth, (req, res) => createFinanceRow("incomes", req, res, sanitizeIncomePayload));
app.put("/api/incomes/:id", requireAuth, (req, res) => updateFinanceRow("incomes", req, res, sanitizeIncomePayload));
app.delete("/api/incomes/:id", requireAuth, (req, res) => deleteFinanceRow("incomes", req, res));

app.post("/api/emis", requireAuth, (req, res) => createFinanceRow("emis", req, res, sanitizeEmiPayload));
app.put("/api/emis/:id", requireAuth, (req, res) => updateFinanceRow("emis", req, res, sanitizeEmiPayload));
app.delete("/api/emis/:id", requireAuth, (req, res) => deleteFinanceRow("emis", req, res));
app.post("/api/emis/:id/payments", requireAuth, (req, res) => {
  const emi = ensureRowOwnership("emis", req.session.userId, req.params.id);
  const month = requiredMonth(req.body?.month, "Payment month");
  const existing = db.prepare("SELECT id FROM emi_payments WHERE emi_id = ? AND month = ?").get(emi.id, month);
  if (!existing) {
    db.prepare("INSERT INTO emi_payments (emi_id, month, paid_at) VALUES (?, ?, ?)").run(emi.id, month, new Date().toISOString());
  }
  res.json({ ok: true });
});
app.delete("/api/emis/:id/payments/:month", requireAuth, (req, res) => {
  const emi = ensureRowOwnership("emis", req.session.userId, req.params.id);
  const month = requiredMonth(req.params.month, "Payment month");
  db.prepare("DELETE FROM emi_payments WHERE emi_id = ? AND month = ?").run(emi.id, month);
  res.json({ ok: true });
});

app.post("/api/expenses", requireAuth, (req, res) => createFinanceRow("expenses", req, res, sanitizeExpensePayload));
app.put("/api/expenses/:id", requireAuth, (req, res) => updateFinanceRow("expenses", req, res, sanitizeExpensePayload));
app.delete("/api/expenses/:id", requireAuth, (req, res) => deleteFinanceRow("expenses", req, res));

app.post("/api/goals", requireAuth, (req, res) => {
  const payload = sanitizeGoalPayload(req.body ?? {});
  const result = db.prepare("INSERT INTO goals (user_id, name, target_amount, target_date, notes) VALUES (?, ?, ?, ?, ?)").run(req.session.userId, payload.name, payload.targetAmount, payload.targetDate, payload.notes);
  res.status(201).json({ id: result.lastInsertRowid, ...payload, contributions: [] });
});

app.put("/api/goals/:id", requireAuth, (req, res) => {
  ensureRowOwnership("goals", req.session.userId, req.params.id);
  const payload = sanitizeGoalPayload(req.body ?? {});
  db.prepare("UPDATE goals SET name = ?, target_amount = ?, target_date = ?, notes = ? WHERE id = ? AND user_id = ?").run(payload.name, payload.targetAmount, payload.targetDate, payload.notes, req.params.id, req.session.userId);
  res.json({ ok: true });
});

app.delete("/api/goals/:id", requireAuth, (req, res) => {
  ensureRowOwnership("goals", req.session.userId, req.params.id);
  db.prepare("DELETE FROM goals WHERE id = ? AND user_id = ?").run(req.params.id, req.session.userId);
  res.json({ ok: true });
});

app.post("/api/goals/:id/contributions", requireAuth, (req, res) => {
  ensureRowOwnership("goals", req.session.userId, req.params.id);
  const payload = sanitizeContributionPayload(req.body ?? {}, req.session.userId);
  const result = db.prepare("INSERT INTO goal_contributions (goal_id, member_id, amount, month, note) VALUES (?, ?, ?, ?, ?)").run(req.params.id, payload.memberId, payload.amount, payload.month, payload.note);
  res.status(201).json({ id: result.lastInsertRowid, ...payload });
});

app.delete("/api/goals/:goalId/contributions/:contributionId", requireAuth, (req, res) => {
  ensureRowOwnership("goals", req.session.userId, req.params.goalId);
  db.prepare("DELETE FROM goal_contributions WHERE id = ? AND goal_id = ?").run(req.params.contributionId, req.params.goalId);
  res.json({ ok: true });
});

app.get("/api/reports/:month", requireAuth, (req, res) => {
  res.json(buildMonthlyReport(req.session.userId, req.params.month));
});

app.get("/api/invoices", requireAuth, (req, res) => {
  res.json(getInvoices(req.session.userId));
});

app.post("/api/invoices", requireAuth, (req, res) => {
  const payload = sanitizeInvoicePayload(req.body ?? {});
  const result = db.prepare(`
    INSERT INTO invoices (user_id, invoice_number, invoice_date, due_date, client_name, client_email, client_address, bill_to, ship_to, seller_gstin, notes, tax_rate, subtotal, tax_amount, total, items_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.session.userId, payload.invoiceNumber, payload.invoiceDate, payload.dueDate, payload.clientName, payload.clientEmail, payload.clientAddress, payload.billTo, payload.shipTo, payload.sellerGstin, payload.notes, payload.taxRate, payload.subtotal, payload.taxAmount, payload.total, JSON.stringify(payload.items), new Date().toISOString());
  res.status(201).json({ id: result.lastInsertRowid, ...payload });
});

app.put("/api/invoices/:id", requireAuth, (req, res) => {
  ensureRowOwnership("invoices", req.session.userId, req.params.id);
  const payload = sanitizeInvoicePayload(req.body ?? {});
  db.prepare(`
    UPDATE invoices
    SET invoice_number = ?, invoice_date = ?, due_date = ?, client_name = ?, client_email = ?, client_address = ?, bill_to = ?, ship_to = ?, seller_gstin = ?, notes = ?, tax_rate = ?, subtotal = ?, tax_amount = ?, total = ?, items_json = ?
    WHERE id = ? AND user_id = ?
  `).run(payload.invoiceNumber, payload.invoiceDate, payload.dueDate, payload.clientName, payload.clientEmail, payload.clientAddress, payload.billTo, payload.shipTo, payload.sellerGstin, payload.notes, payload.taxRate, payload.subtotal, payload.taxAmount, payload.total, JSON.stringify(payload.items), req.params.id, req.session.userId);
  res.json({ ok: true });
});

app.delete("/api/invoices/:id", requireAuth, (req, res) => {
  ensureRowOwnership("invoices", req.session.userId, req.params.id);
  db.prepare("DELETE FROM invoices WHERE id = ? AND user_id = ?").run(req.params.id, req.session.userId);
  res.json({ ok: true });
});

app.get("/api/admin/users", requireAuth, (req, res) => {
  requireAdmin(req);
  const rows = db.prepare(`
    SELECT u.id, u.phone, u.role, u.blocked, u.created_at, COALESCE(p.name, '') AS name, COALESCE(p.email, '') AS email
    FROM users u
    LEFT JOIN profiles p ON p.user_id = u.id
    ORDER BY u.created_at ASC
  `).all();
  res.json(rows.map((row) => ({ ...row, ...buildUserSummary(row.id) })));
});

app.post("/api/admin/users", requireAuth, asyncHandler(async (req, res) => {
  requireAdmin(req);
  const { name, email, phone, pin, role } = req.body ?? {};
  validatePhone(phone);
  validatePin(pin);
  const profile = sanitizeProfilePayload({ name, email });
  const existing = db.prepare("SELECT id FROM users WHERE phone = ?").get(phone);
  if (existing) return res.status(409).json({ error: "Phone number already registered." });
  const pinHash = await bcrypt.hash(pin, 10);
  const createdAt = new Date().toISOString();
  const nextRole = role === "admin" ? "admin" : "user";
  const result = db.prepare("INSERT INTO users (phone, pin_hash, role, blocked, created_at) VALUES (?, ?, ?, 0, ?)").run(phone, pinHash, nextRole, createdAt);
  db.prepare("INSERT INTO profiles (user_id, name, email, address, company_name, company_email, company_phone, company_address) VALUES (?, ?, ?, ?, '', '', '', '')").run(result.lastInsertRowid, profile.name, profile.email, profile.address);
  db.prepare("INSERT INTO members (user_id, name, relation, is_primary) VALUES (?, 'Me', 'Primary user', 1)").run(result.lastInsertRowid);
  res.status(201).json({ id: result.lastInsertRowid, phone, role: nextRole, createdAt });
}));

app.post("/api/admin/users/:id/reset-pin", requireAuth, asyncHandler(async (req, res) => {
  requireAdmin(req);
  const temporaryPin = generateTemporaryPin();
  db.prepare("UPDATE users SET pin_hash = ? WHERE id = ?").run(await bcrypt.hash(temporaryPin, 10), req.params.id);
  db.prepare("UPDATE reset_requests SET status = 'resolved', resolved_at = ?, temporary_pin = ? WHERE user_id = ? AND status = 'pending'").run(new Date().toISOString(), temporaryPin, req.params.id);
  res.json({ ok: true, temporaryPin });
}));

app.post("/api/admin/users/:id/block", requireAuth, (req, res) => {
  requireAdmin(req);
  if (Number(req.params.id) === req.session.userId) return res.status(400).json({ error: "You cannot block the account you are currently using." });
  db.prepare("UPDATE users SET blocked = 1 WHERE id = ?").run(req.params.id);
  db.prepare("DELETE FROM sessions WHERE sess LIKE ?").run(`%"userId":${Number(req.params.id)}%`);
  res.json({ ok: true });
});

app.post("/api/admin/users/:id/unblock", requireAuth, (req, res) => {
  requireAdmin(req);
  db.prepare("UPDATE users SET blocked = 0 WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

app.get("/api/admin/reset-requests", requireAuth, (req, res) => {
  requireAdmin(req);
  const rows = db.prepare(`
    SELECT rr.id, rr.user_id AS userId, rr.requested_at AS requestedAt, rr.status, u.phone, COALESCE(p.name, '') AS name, COALESCE(p.email, '') AS email
    FROM reset_requests rr
    INNER JOIN users u ON u.id = rr.user_id
    LEFT JOIN profiles p ON p.user_id = u.id
    WHERE rr.status = 'pending'
    ORDER BY rr.requested_at DESC
  `).all();
  res.json(rows);
});

app.delete("/api/admin/users/:id", requireAuth, (req, res) => {
  requireAdmin(req);
  if (Number(req.params.id) === req.session.userId) return res.status(400).json({ error: "You cannot delete the account you are currently using." });
  db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

app.use(express.static(publicDir));
app.get("/*splat", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.statusCode || 500).json({ error: error.message || "Server error" });
});

app.listen(Number(process.env.PORT || 3000), () => {
  console.log("Expense Tracker running on http://localhost:3000");
});

function initializeDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL UNIQUE, pin_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('user', 'admin')), blocked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS profiles (user_id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', gstin TEXT NOT NULL DEFAULT '', company_name TEXT NOT NULL DEFAULT '', company_email TEXT NOT NULL DEFAULT '', company_phone TEXT NOT NULL DEFAULT '', company_address TEXT NOT NULL DEFAULT '', FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS members (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, relation TEXT NOT NULL, is_primary INTEGER NOT NULL DEFAULT 0, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS incomes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, member_id INTEGER NOT NULL, source TEXT NOT NULL, amount REAL NOT NULL, budget_month TEXT NOT NULL, received_date TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS emis (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, member_id INTEGER NOT NULL, name TEXT NOT NULL, amount REAL NOT NULL, emi_day INTEGER NOT NULL DEFAULT 1, start_month TEXT NOT NULL, end_month TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, member_id INTEGER NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, amount REAL NOT NULL, budget_month TEXT NOT NULL, expense_date TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS goals (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, target_amount REAL NOT NULL, target_date TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS goal_contributions (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id INTEGER NOT NULL, member_id INTEGER NOT NULL, amount REAL NOT NULL, month TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE, FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS emi_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, emi_id INTEGER NOT NULL, month TEXT NOT NULL, paid_at TEXT NOT NULL, UNIQUE (emi_id, month), FOREIGN KEY (emi_id) REFERENCES emis(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, invoice_number TEXT NOT NULL, invoice_date TEXT NOT NULL, due_date TEXT NOT NULL, client_name TEXT NOT NULL, client_email TEXT NOT NULL DEFAULT '', client_address TEXT NOT NULL DEFAULT '', bill_to TEXT NOT NULL DEFAULT '', ship_to TEXT NOT NULL DEFAULT '', seller_gstin TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', tax_rate REAL NOT NULL DEFAULT 0, subtotal REAL NOT NULL DEFAULT 0, tax_amount REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0, items_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS reset_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, requested_at TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending', 'resolved')), resolved_at TEXT, temporary_pin TEXT, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
  `);
  ensureColumn("users", "blocked", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("profiles", "address", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("profiles", "gstin", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("emis", "emi_day", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn("invoices", "bill_to", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("invoices", "ship_to", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("invoices", "seller_gstin", "TEXT NOT NULL DEFAULT ''");
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Authentication required." });
  const user = db.prepare("SELECT blocked FROM users WHERE id = ?").get(req.session.userId);
  if (!user) return res.status(401).json({ error: "Authentication required." });
  if (user.blocked) {
    req.session.destroy(() => {});
    return res.status(403).json({ error: "Your account has been blocked. Please contact the admin." });
  }
  next();
}

function requireAdmin(req) {
  const user = db.prepare("SELECT role FROM users WHERE id = ?").get(req.session.userId);
  if (!user || user.role !== "admin") throw { statusCode: 403, message: "Admin access required." };
}

function buildSessionPayload(userId) {
  const user = db.prepare("SELECT id, phone, role, blocked, created_at FROM users WHERE id = ?").get(userId);
  return { user: { id: user.id, phone: user.phone, role: user.role, blocked: Boolean(user.blocked), createdAt: user.created_at }, profile: getProfile(userId) };
}

function getProfile(userId) {
  const row = db.prepare("SELECT * FROM profiles WHERE user_id = ?").get(userId);
  return { name: row?.name || "", email: row?.email || "", address: row?.address || row?.company_address || "", gstin: row?.gstin || "" };
}

function getMembers(userId) {
  return db.prepare("SELECT * FROM members WHERE user_id = ? ORDER BY is_primary DESC, id ASC").all(userId).map((row) => ({ id: row.id, name: row.name, relation: row.relation, isPrimary: Boolean(row.is_primary) }));
}

function listRows(table, userId) {
  const rows = db.prepare(`SELECT * FROM ${table} WHERE user_id = ? ORDER BY id DESC`).all(userId).map(normalizeRow);
  if (table !== "emis") return rows;
  const paymentMap = getEmiPaymentMap(userId);
  return rows.map((row) => ({ ...row, paymentMonths: paymentMap.get(row.id) || [] }));
}

function getGoals(userId) {
  const goals = db.prepare("SELECT * FROM goals WHERE user_id = ? ORDER BY id DESC").all(userId).map(normalizeRow);
  const contributions = db.prepare(`SELECT gc.* FROM goal_contributions gc INNER JOIN goals g ON g.id = gc.goal_id WHERE g.user_id = ? ORDER BY gc.id DESC`).all(userId);
  return goals.map((goal) => ({ ...goal, contributions: contributions.filter((item) => item.goal_id === goal.id).map((item) => ({ id: item.id, memberId: item.member_id, amount: item.amount, month: item.month, note: item.note })) }));
}

function getInvoices(userId) {
  return db.prepare("SELECT * FROM invoices WHERE user_id = ? ORDER BY id DESC").all(userId).map((row) => ({ id: row.id, invoiceNumber: row.invoice_number, invoiceDate: row.invoice_date, dueDate: row.due_date, clientName: row.client_name, clientEmail: row.client_email, clientAddress: row.client_address, billTo: row.bill_to || row.client_address || "", shipTo: row.ship_to || "", sellerGstin: row.seller_gstin || "", notes: row.notes, taxRate: row.tax_rate, subtotal: row.subtotal, taxAmount: row.tax_amount, total: row.total, items: JSON.parse(row.items_json || "[]"), createdAt: row.created_at }));
}

function buildMonthlyReport(userId, month) {
  const incomes = db.prepare("SELECT * FROM incomes WHERE user_id = ? AND budget_month = ?").all(userId, month).map(normalizeRow);
  const expenses = db.prepare("SELECT * FROM expenses WHERE user_id = ? AND budget_month = ?").all(userId, month).map(normalizeRow);
  const paymentMap = getEmiPaymentMap(userId);
  const emis = db.prepare("SELECT * FROM emis WHERE user_id = ? AND start_month <= ? AND end_month >= ?").all(userId, month, month).map(normalizeRow).map((item) => ({ ...item, paymentMonths: paymentMap.get(item.id) || [] }));
  const goals = getGoals(userId).map((goal) => ({ name: goal.name, targetAmount: Number(goal.targetAmount || 0), savedAmount: goal.contributions.reduce((sum, item) => sum + Number(item.amount || 0), 0), monthContribution: goal.contributions.filter((item) => item.month === month).reduce((sum, item) => sum + Number(item.amount || 0), 0) }));
  const memberMap = new Map(getMembers(userId).map((member) => [member.id, member.name]));
  const memberLines = getMembers(userId).map((member) => {
    const income = incomes.filter((item) => item.memberId === member.id).reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const expense = expenses.filter((item) => item.memberId === member.id).reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const emi = emis.filter((item) => item.memberId === member.id).reduce((sum, item) => sum + Number(item.amount || 0), 0);
    return `${member.name}: Income ${formatCurrency(income)}, EMI ${formatCurrency(emi)}, Expenses ${formatCurrency(expense)}, Net ${formatCurrency(income - emi - expense)}`;
  });
  return { month, incomes: incomes.map((item) => ({ ...item, memberName: memberMap.get(item.memberId) || "Unknown" })), expenses: expenses.map((item) => ({ ...item, memberName: memberMap.get(item.memberId) || "Unknown" })), emis: emis.map((item) => ({ ...item, memberName: memberMap.get(item.memberId) || "Unknown" })), goals, totalIncome: incomes.reduce((sum, item) => sum + Number(item.amount || 0), 0), totalExpenses: expenses.reduce((sum, item) => sum + Number(item.amount || 0), 0), totalEmi: emis.reduce((sum, item) => sum + Number(item.amount || 0), 0), netBalance: incomes.reduce((sum, item) => sum + Number(item.amount || 0), 0) - expenses.reduce((sum, item) => sum + Number(item.amount || 0), 0) - emis.reduce((sum, item) => sum + Number(item.amount || 0), 0), memberLines };
}

function getEmiPaymentMap(userId) {
  const rows = db.prepare(`
    SELECT ep.emi_id AS emiId, ep.month
    FROM emi_payments ep
    INNER JOIN emis e ON e.id = ep.emi_id
    WHERE e.user_id = ?
  `).all(userId);
  const map = new Map();
  for (const row of rows) {
    const months = map.get(row.emiId) || [];
    months.push(row.month);
    map.set(row.emiId, months);
  }
  return map;
}

function buildUserSummary(userId) {
  return {
    memberCount: db.prepare("SELECT COUNT(*) AS count FROM members WHERE user_id = ?").get(userId).count,
    incomeCount: db.prepare("SELECT COUNT(*) AS count FROM incomes WHERE user_id = ?").get(userId).count,
    emiCount: db.prepare("SELECT COUNT(*) AS count FROM emis WHERE user_id = ?").get(userId).count,
    expenseCount: db.prepare("SELECT COUNT(*) AS count FROM expenses WHERE user_id = ?").get(userId).count,
    goalCount: db.prepare("SELECT COUNT(*) AS count FROM goals WHERE user_id = ?").get(userId).count,
    invoiceCount: db.prepare("SELECT COUNT(*) AS count FROM invoices WHERE user_id = ?").get(userId).count
  };
}

function createFinanceRow(table, req, res, sanitizer) {
  const payload = sanitizer(req.body ?? {}, req.session.userId);
  const mapping = financeTableMapping(table);
  const result = db.prepare(`INSERT INTO ${table} (${mapping.columns.join(", ")}) VALUES (${mapping.columns.map(() => "?").join(", ")})`).run(...mapping.values(req.session.userId, payload));
  res.status(201).json({ id: result.lastInsertRowid, ...payload });
}

function updateFinanceRow(table, req, res, sanitizer) {
  ensureRowOwnership(table, req.session.userId, req.params.id);
  const payload = sanitizer(req.body ?? {}, req.session.userId);
  const mapping = financeTableMapping(table);
  db.prepare(`UPDATE ${table} SET ${mapping.updates.join(", ")} WHERE id = ? AND user_id = ?`).run(...mapping.updateValues(payload), req.params.id, req.session.userId);
  res.json({ ok: true });
}

function deleteFinanceRow(table, req, res) {
  ensureRowOwnership(table, req.session.userId, req.params.id);
  db.prepare(`DELETE FROM ${table} WHERE id = ? AND user_id = ?`).run(req.params.id, req.session.userId);
  res.json({ ok: true });
}

function financeTableMapping(table) {
  if (table === "incomes") return {
    columns: ["user_id", "member_id", "source", "amount", "budget_month", "received_date", "notes"],
    values: (userId, payload) => [userId, payload.memberId, payload.source, payload.amount, payload.budgetMonth, payload.receivedDate, payload.notes],
    updates: ["member_id = ?", "source = ?", "amount = ?", "budget_month = ?", "received_date = ?", "notes = ?"],
    updateValues: (payload) => [payload.memberId, payload.source, payload.amount, payload.budgetMonth, payload.receivedDate, payload.notes]
  };
  if (table === "emis") return {
    columns: ["user_id", "member_id", "name", "amount", "emi_day", "start_month", "end_month", "notes"],
    values: (userId, payload) => [userId, payload.memberId, payload.name, payload.amount, payload.emiDay, payload.startMonth, payload.endMonth, payload.notes],
    updates: ["member_id = ?", "name = ?", "amount = ?", "emi_day = ?", "start_month = ?", "end_month = ?", "notes = ?"],
    updateValues: (payload) => [payload.memberId, payload.name, payload.amount, payload.emiDay, payload.startMonth, payload.endMonth, payload.notes]
  };
  return {
    columns: ["user_id", "member_id", "name", "category", "amount", "budget_month", "expense_date", "notes"],
    values: (userId, payload) => [userId, payload.memberId, payload.name, payload.category, payload.amount, payload.budgetMonth, payload.expenseDate, payload.notes],
    updates: ["member_id = ?", "name = ?", "category = ?", "amount = ?", "budget_month = ?", "expense_date = ?", "notes = ?"],
    updateValues: (payload) => [payload.memberId, payload.name, payload.category, payload.amount, payload.budgetMonth, payload.expenseDate, payload.notes]
  };
}

function ensureRowOwnership(table, userId, id) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND user_id = ?`).get(id, userId);
  if (!row) throw notFound("Resource not found.");
  return row;
}

function ensureMemberOwnership(userId, memberId) {
  const row = db.prepare("SELECT * FROM members WHERE id = ? AND user_id = ?").get(memberId, userId);
  if (!row) throw notFound("Member not found.");
  return { ...row, is_primary: Number(row.is_primary || 0), is_primary_bool: Boolean(row.is_primary) };
}

function sanitizeProfilePayload(payload) {
  return { name: String(payload.name || "").trim(), email: String(payload.email || "").trim(), address: String(payload.address || "").trim(), gstin: String(payload.gstin || "").trim().toUpperCase() };
}

function sanitizeMemberPayload(payload) {
  return { name: requiredString(payload.name, "Member name"), relation: requiredString(payload.relation, "Relation") };
}

function sanitizeIncomePayload(payload, userId) {
  ensureMemberOwnership(userId, payload.memberId);
  return { memberId: Number(payload.memberId), source: requiredString(payload.source, "Income source"), amount: requiredAmount(payload.amount, "Income amount"), budgetMonth: requiredMonth(payload.budgetMonth, "Budget month"), receivedDate: requiredDate(payload.receivedDate, "Received date"), notes: String(payload.notes || "").trim() };
}

function sanitizeEmiPayload(payload, userId) {
  ensureMemberOwnership(userId, payload.memberId);
  const startMonth = requiredMonth(payload.startMonth || currentMonthValue(), "Start month");
  const endMonth = requiredMonth(payload.endMonth, "End month");
  if (endMonth < startMonth) throw badRequest("End month cannot be earlier than start month.");
  const emiDay = Number(payload.emiDay);
  if (!Number.isInteger(emiDay) || emiDay < 1 || emiDay > 31) throw badRequest("EMI date must be a day between 1 and 31.");
  return { memberId: Number(payload.memberId), name: requiredString(payload.name, "EMI name"), amount: requiredAmount(payload.amount, "EMI amount"), emiDay, startMonth, endMonth, notes: String(payload.notes || "").trim() };
}

function sanitizeExpensePayload(payload, userId) {
  ensureMemberOwnership(userId, payload.memberId);
  return { memberId: Number(payload.memberId), name: requiredString(payload.name, "Expense name"), category: requiredString(payload.category, "Category"), amount: requiredAmount(payload.amount, "Expense amount"), budgetMonth: requiredMonth(payload.budgetMonth, "Budget month"), expenseDate: requiredDate(payload.expenseDate, "Expense date"), notes: String(payload.notes || "").trim() };
}

function sanitizeGoalPayload(payload) {
  return { name: requiredString(payload.name, "Goal name"), targetAmount: requiredAmount(payload.targetAmount, "Target amount"), targetDate: requiredDate(payload.targetDate, "Target date"), notes: String(payload.notes || "").trim() };
}

function sanitizeContributionPayload(payload, userId) {
  ensureMemberOwnership(userId, payload.memberId);
  return { memberId: Number(payload.memberId), amount: requiredAmount(payload.amount, "Contribution amount"), month: requiredMonth(payload.month, "Contribution month"), note: String(payload.note || "").trim() };
}

function sanitizeInvoicePayload(payload) {
  const items = Array.isArray(payload.items) ? payload.items.map((item) => {
    const quantity = requiredAmount(item.quantity, "Invoice quantity");
    const rate = requiredAmount(item.rate, "Invoice rate");
    const igst = Number(item.igst || 0);
    if (igst < 0) throw badRequest("IGST cannot be negative.");
    return {
      description: requiredString(item.description, "Invoice item description"),
      hsnSac: String(item.hsnSac || item.hsn_sac || "").trim(),
      quantity,
      rate,
      igst,
      amount: requiredAmount(item.amount ?? quantity * rate * (1 + igst / 100), "Invoice amount")
    };
  }) : [];
  if (!items.length) throw badRequest("Invoice must include at least one line item.");
  return {
    invoiceNumber: requiredString(payload.invoiceNumber, "Invoice number"),
    invoiceDate: requiredDate(payload.invoiceDate, "Invoice date"),
    dueDate: requiredDate(payload.dueDate || payload.invoiceDate, "Due date"),
    clientName: requiredString(payload.clientName || "Customer", "Client name"),
    clientEmail: String(payload.clientEmail || "").trim(),
    clientAddress: String(payload.clientAddress || payload.billTo || "").trim(),
    billTo: requiredString(payload.billTo || payload.clientAddress, "Bill To"),
    shipTo: requiredString(payload.shipTo || payload.billTo || payload.clientAddress, "Ship To"),
    sellerGstin: String(payload.sellerGstin || "").trim().toUpperCase(),
    notes: String(payload.notes || "").trim(),
    taxRate: Number(payload.taxRate || 0),
    subtotal: requiredAmount(payload.subtotal, "Subtotal"),
    taxAmount: requiredAmount(payload.taxAmount, "Tax amount"),
    total: requiredAmount(payload.total, "Total amount"),
    items
  };
}

function importLegacyData(userId, rawPayload) {
  const phone = db.prepare("SELECT phone FROM users WHERE id = ?").get(userId)?.phone;
  const legacy = resolveLegacyImportPayload(rawPayload, phone);
  const summary = { members: 0, incomes: 0, emis: 0, expenses: 0, goals: 0, contributions: 0, invoices: 0 };
  const transaction = db.transaction(() => {
    mergeLegacyProfile(userId, legacy.profile || {});
    const memberMap = importLegacyMembers(userId, legacy, summary);
    importLegacyFinanceRows("incomes", userId, legacy.incomes, memberMap, summary);
    importLegacyFinanceRows("emis", userId, legacy.emis, memberMap, summary);
    importLegacyFinanceRows("expenses", userId, legacy.expenses, memberMap, summary);
    importLegacyGoals(userId, legacy.goals, memberMap, summary);
    importLegacyInvoices(userId, legacy.invoices, summary);
  });
  transaction();
  return summary;
}

function resolveLegacyImportPayload(rawPayload, phone) {
  const payload = deepParse(rawPayload);
  const normalizedPhone = normalizePhone(phone);
  if (payload?.legacyData) return resolveLegacyImportPayload(payload.legacyData, phone);
  if (payload?.storage) return resolveLegacyStoragePayload(payload.storage, normalizedPhone) || payload;
  if (payload?.localStorage) return resolveLegacyStoragePayload(payload.localStorage, normalizedPhone) || payload;
  if (payload?.entries) return resolveLegacyStoragePayload(payload.entries, normalizedPhone) || payload;
  if (payload?.dump) return resolveLegacyImportPayload(payload.dump, phone);
  if (hasLegacyCollections(payload)) return payload;
  const matched = matchLegacyUserContainer(payload, normalizedPhone);
  if (matched) return matched;
  throw badRequest("Couldn't find legacy finance data in the import payload.");
}

function resolveLegacyStoragePayload(storagePayload, normalizedPhone) {
  const parsedEntries = Object.fromEntries(Object.entries(storagePayload || {}).map(([key, value]) => [key, deepParse(value)]));
  const directMatch = Object.values(parsedEntries).find(hasLegacyCollections);
  if (directMatch) return directMatch;
  const matched = matchLegacyUserContainer(parsedEntries, normalizedPhone);
  if (matched) return matched;
  const candidate = Object.entries(parsedEntries).find(([key]) => /expense|tracker|finance|budget|goal|income|emi|user/i.test(key));
  if (candidate && hasLegacyCollections(candidate[1])) return candidate[1];
  return null;
}

function matchLegacyUserContainer(payload, normalizedPhone) {
  const containers = [payload?.users, payload?.accounts, payload?.profiles, payload?.appUsers];
  for (const container of containers) {
    if (!container) continue;
    if (Array.isArray(container)) {
      const item = container.find((entry) => normalizePhone(entry?.phone || entry?.user?.phone) === normalizedPhone);
      if (item) return deepParse(item.data || item);
    } else if (typeof container === "object") {
      for (const [key, value] of Object.entries(container)) {
        if (normalizePhone(key) === normalizedPhone || normalizePhone(value?.phone || value?.user?.phone) === normalizedPhone) {
          return deepParse(value.data || value);
        }
      }
    }
  }
  return null;
}

function hasLegacyCollections(value) {
  if (!value || typeof value !== "object") return false;
  return ["members", "family", "familyMembers", "incomes", "income", "emis", "expenses", "goals", "invoices", "profile"].some((key) => key in value);
}

function mergeLegacyProfile(userId, profile) {
  const current = getProfile(userId);
  const next = sanitizeProfilePayload({
    name: current.name || profile.name || profile.fullName || "",
    email: current.email || profile.email || "",
    address: current.address || profile.address || profile.companyAddress || profile.businessAddress || "",
    gstin: current.gstin || profile.gstin || profile.taxId || ""
  });
  db.prepare(`
    UPDATE profiles
    SET name = ?, email = ?, address = ?, gstin = ?
    WHERE user_id = ?
  `).run(next.name, next.email, next.address, next.gstin, userId);
}

function importLegacyMembers(userId, legacy, summary) {
  const existingMembers = getMembers(userId);
  const primaryMember = existingMembers.find((member) => member.isPrimary) || existingMembers[0];
  const memberMap = new Map();
  const byNormalizedName = new Map(existingMembers.map((member) => [normalizeName(member.name), member]));
  const rawMembers = asArray(legacy.members || legacy.familyMembers || legacy.family);

  if (primaryMember) {
    memberMap.set("primary", primaryMember.id);
    memberMap.set("self", primaryMember.id);
    memberMap.set("me", primaryMember.id);
  }

  for (const rawMember of rawMembers) {
    const name = String(rawMember?.name || rawMember?.memberName || rawMember?.label || "").trim();
    if (!name) continue;
    const relation = String(rawMember?.relation || rawMember?.role || rawMember?.type || "Family member").trim();
    let matched = rawMember?.isPrimary || rawMember?.primary ? primaryMember : byNormalizedName.get(normalizeName(name));
    if (!matched) {
      const result = db.prepare("INSERT INTO members (user_id, name, relation, is_primary) VALUES (?, ?, ?, 0)").run(userId, name, relation);
      matched = { id: result.lastInsertRowid, name, relation, isPrimary: false };
      byNormalizedName.set(normalizeName(name), matched);
      summary.members += 1;
    }
    if (rawMember?.id != null) memberMap.set(String(rawMember.id), matched.id);
    memberMap.set(normalizeName(name), matched.id);
  }

  return { map: memberMap, primaryId: primaryMember?.id };
}

function importLegacyFinanceRows(table, userId, rows, memberMap, summary) {
  for (const rawRow of asArray(rows || [])) {
    const normalized = normalizeLegacyFinanceRow(table, rawRow, memberMap, userId);
    if (!normalized) continue;
    const isDuplicate = table === "incomes"
      ? db.prepare("SELECT id FROM incomes WHERE user_id = ? AND member_id = ? AND source = ? AND amount = ? AND budget_month = ? AND received_date = ?").get(userId, normalized.memberId, normalized.source, normalized.amount, normalized.budgetMonth, normalized.receivedDate)
      : table === "emis"
        ? db.prepare("SELECT id FROM emis WHERE user_id = ? AND member_id = ? AND name = ? AND amount = ? AND start_month = ? AND end_month = ?").get(userId, normalized.memberId, normalized.name, normalized.amount, normalized.startMonth, normalized.endMonth)
        : db.prepare("SELECT id FROM expenses WHERE user_id = ? AND member_id = ? AND name = ? AND category = ? AND amount = ? AND budget_month = ? AND expense_date = ?").get(userId, normalized.memberId, normalized.name, normalized.category, normalized.amount, normalized.budgetMonth, normalized.expenseDate);
    if (isDuplicate) continue;
    const mapping = financeTableMapping(table);
    db.prepare(`INSERT INTO ${table} (${mapping.columns.join(", ")}) VALUES (${mapping.columns.map(() => "?").join(", ")})`).run(...mapping.values(userId, normalized));
    summary[table] += 1;
  }
}

function importLegacyGoals(userId, goals, memberMap, summary) {
  for (const rawGoal of asArray(goals || [])) {
    const normalizedGoal = normalizeLegacyGoal(rawGoal);
    if (!normalizedGoal) continue;
    let goal = db.prepare("SELECT id FROM goals WHERE user_id = ? AND name = ? AND target_amount = ? AND target_date = ?").get(userId, normalizedGoal.name, normalizedGoal.targetAmount, normalizedGoal.targetDate);
    if (!goal) {
      const result = db.prepare("INSERT INTO goals (user_id, name, target_amount, target_date, notes) VALUES (?, ?, ?, ?, ?)").run(userId, normalizedGoal.name, normalizedGoal.targetAmount, normalizedGoal.targetDate, normalizedGoal.notes);
      goal = { id: result.lastInsertRowid };
      summary.goals += 1;
    }
    const contributions = normalizeLegacyGoalContributions(rawGoal, normalizedGoal, memberMap, userId);
    for (const contribution of contributions) {
      const duplicate = db.prepare("SELECT id FROM goal_contributions WHERE goal_id = ? AND member_id = ? AND amount = ? AND month = ? AND note = ?").get(goal.id, contribution.memberId, contribution.amount, contribution.month, contribution.note);
      if (duplicate) continue;
      db.prepare("INSERT INTO goal_contributions (goal_id, member_id, amount, month, note) VALUES (?, ?, ?, ?, ?)").run(goal.id, contribution.memberId, contribution.amount, contribution.month, contribution.note);
      summary.contributions += 1;
    }
  }
}

function importLegacyInvoices(userId, invoices, summary) {
  for (const rawInvoice of asArray(invoices || [])) {
    const normalized = normalizeLegacyInvoice(rawInvoice);
    if (!normalized) continue;
    const duplicate = db.prepare("SELECT id FROM invoices WHERE user_id = ? AND invoice_number = ?").get(userId, normalized.invoiceNumber);
    if (duplicate) continue;
    db.prepare(`
      INSERT INTO invoices (user_id, invoice_number, invoice_date, due_date, client_name, client_email, client_address, bill_to, ship_to, notes, tax_rate, subtotal, tax_amount, total, items_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, normalized.invoiceNumber, normalized.invoiceDate, normalized.dueDate, normalized.clientName, normalized.clientEmail, normalized.clientAddress, normalized.billTo, normalized.shipTo, normalized.notes, normalized.taxRate, normalized.subtotal, normalized.taxAmount, normalized.total, JSON.stringify(normalized.items), new Date().toISOString());
    summary.invoices += 1;
  }
}

function normalizeLegacyFinanceRow(table, rawRow, memberMap, userId) {
  if (!rawRow || typeof rawRow !== "object") return null;
  const memberId = resolveLegacyMemberId(memberMap, rawRow.memberId, rawRow.memberName || rawRow.member || rawRow.owner || rawRow.person);
  if (!memberId) return null;
  if (table === "incomes") {
    return sanitizeIncomePayload({
      memberId,
      source: rawRow.source || rawRow.name || rawRow.title || "Income",
      amount: rawRow.amount ?? rawRow.value ?? 0,
      budgetMonth: coerceMonth(rawRow.budgetMonth || rawRow.budget_month || rawRow.month || rawRow.forMonth || rawRow.spendingMonth),
      receivedDate: coerceDate(rawRow.receivedDate || rawRow.received_date || rawRow.date || rawRow.receivedOn, coerceMonth(rawRow.budgetMonth || rawRow.month)),
      notes: rawRow.notes || rawRow.note || ""
    }, userId);
  }
  if (table === "emis") {
    return sanitizeEmiPayload({
      memberId,
      name: rawRow.name || rawRow.title || rawRow.lender || "EMI",
      amount: rawRow.amount ?? rawRow.value ?? 0,
      emiDay: Number(rawRow.emiDay ?? rawRow.emi_day ?? rawRow.day ?? 1),
      startMonth: coerceMonth(rawRow.startMonth || rawRow.start_month || rawRow.month || currentMonthValue()),
      endMonth: coerceMonth(rawRow.endMonth || rawRow.end_month || rawRow.month || rawRow.startMonth || currentMonthValue()),
      notes: rawRow.notes || rawRow.note || ""
    }, userId);
  }
  return sanitizeExpensePayload({
    memberId,
    name: rawRow.name || rawRow.title || rawRow.label || "Expense",
    category: rawRow.category || rawRow.type || "Other",
    amount: rawRow.amount ?? rawRow.value ?? 0,
    budgetMonth: coerceMonth(rawRow.budgetMonth || rawRow.budget_month || rawRow.month || rawRow.forMonth),
    expenseDate: coerceDate(rawRow.expenseDate || rawRow.expense_date || rawRow.date || rawRow.spentOn, coerceMonth(rawRow.budgetMonth || rawRow.month)),
    notes: rawRow.notes || rawRow.note || ""
  }, userId);
}

function normalizeLegacyGoal(rawGoal) {
  if (!rawGoal || typeof rawGoal !== "object") return null;
  return sanitizeGoalPayload({
    name: rawGoal.name || rawGoal.title || "Goal",
    targetAmount: rawGoal.targetAmount ?? rawGoal.target_amount ?? rawGoal.amount ?? rawGoal.goalAmount ?? 0,
    targetDate: coerceDate(rawGoal.targetDate || rawGoal.target_date || rawGoal.deadline || rawGoal.date, currentMonthValue()),
    notes: rawGoal.notes || rawGoal.note || ""
  });
}

function normalizeLegacyGoalContributions(rawGoal, normalizedGoal, memberMap, userId) {
  const directContributions = asArray(rawGoal.contributions || rawGoal.progressEntries || rawGoal.entries).map((item) => {
    const memberId = resolveLegacyMemberId(memberMap, item.memberId, item.memberName || item.member || item.owner || item.person);
    if (!memberId) return null;
    return sanitizeContributionPayload({
      memberId,
      amount: item.amount ?? item.value ?? 0,
      month: coerceMonth(item.month || item.budgetMonth || item.date || normalizedGoal.targetDate),
      note: item.note || item.notes || "Imported contribution"
    }, userId);
  }).filter(Boolean);
  if (directContributions.length) return directContributions;
  const savedAmount = Number(rawGoal.savedAmount ?? rawGoal.progress ?? rawGoal.currentAmount ?? rawGoal.current_amount ?? 0);
  if (savedAmount <= 0) return [];
  return [sanitizeContributionPayload({
    memberId: memberMap.primaryId,
    amount: savedAmount,
    month: currentMonthValue(),
    note: "Imported progress"
  }, userId)];
}

function normalizeLegacyInvoice(rawInvoice) {
  if (!rawInvoice || typeof rawInvoice !== "object") return null;
  const items = asArray(rawInvoice.items || rawInvoice.lines || rawInvoice.lineItems).map((item) => ({
    description: String(item.description || item.name || item.title || "").trim(),
    quantity: Number(item.quantity ?? item.qty ?? 1),
    rate: Number(item.rate ?? item.price ?? 0),
    amount: Number(item.amount ?? (Number(item.quantity ?? item.qty ?? 1) * Number(item.rate ?? item.price ?? 0)))
  })).filter((item) => item.description);
  if (!items.length) return null;
  const subtotal = items.reduce((sum, item) => sum + item.amount, 0);
  const taxRate = Number(rawInvoice.taxRate ?? rawInvoice.tax_rate ?? 0);
  const taxAmount = Number(rawInvoice.taxAmount ?? rawInvoice.tax_amount ?? subtotal * (taxRate / 100));
  return sanitizeInvoicePayload({
    invoiceNumber: rawInvoice.invoiceNumber || rawInvoice.invoice_number || rawInvoice.number || `LEGACY-${Date.now()}`,
    invoiceDate: coerceDate(rawInvoice.invoiceDate || rawInvoice.invoice_date || rawInvoice.date, currentMonthValue()),
    dueDate: coerceDate(rawInvoice.dueDate || rawInvoice.due_date || rawInvoice.invoiceDate || rawInvoice.date, currentMonthValue()),
    clientName: rawInvoice.clientName || rawInvoice.client_name || rawInvoice.customerName || "Client",
    clientEmail: rawInvoice.clientEmail || rawInvoice.client_email || "",
    clientAddress: rawInvoice.clientAddress || rawInvoice.client_address || "",
    notes: rawInvoice.notes || rawInvoice.note || "",
    taxRate,
    subtotal,
    taxAmount,
    total: Number(rawInvoice.total ?? subtotal + taxAmount),
    items
  });
}

function resolveLegacyMemberId(memberMap, rawId, rawName) {
  if (rawId != null && memberMap.map.has(String(rawId))) return memberMap.map.get(String(rawId));
  const name = normalizeName(rawName);
  if (name && memberMap.map.has(name)) return memberMap.map.get(name);
  return memberMap.primaryId;
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [];
}

function deepParse(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return value;
    try {
      return deepParse(JSON.parse(trimmed));
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(deepParse);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, deepParse(entry)]));
  return value;
}

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "").slice(-10);
}

function coerceMonth(value) {
  const month = String(value || "").trim();
  if (/^\d{4}-\d{2}$/.test(month)) return month;
  if (/^\d{4}-\d{2}-\d{2}$/.test(month)) return month.slice(0, 7);
  const parsed = new Date(month);
  if (!Number.isNaN(parsed.getTime())) {
    return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}`;
  }
  return currentMonthValue();
}

function coerceDate(value, fallbackMonth) {
  const date = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  if (/^\d{4}-\d{2}$/.test(date)) return `${date}-01`;
  const parsed = new Date(date);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return `${coerceMonth(fallbackMonth || currentMonthValue())}-01`;
}

function requiredString(value, label) {
  const result = String(value ?? "").trim();
  if (!result) throw badRequest(`${label} is required.`);
  return result;
}

function requiredAmount(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw badRequest(`${label} must be a valid non-negative number.`);
  return number;
}

function requiredMonth(value, label) {
  const month = String(value ?? "");
  if (!/^\d{4}-\d{2}$/.test(month)) throw badRequest(`${label} is invalid.`);
  return month;
}

function requiredDate(value, label) {
  const date = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest(`${label} is invalid.`);
  return date;
}

function validatePhone(phone) {
  if (!/^\d{10}$/.test(String(phone ?? ""))) throw badRequest("Phone number must be 10 digits.");
}

function validatePin(pin) {
  if (!/^\d{6}$/.test(String(pin ?? ""))) throw badRequest("Passcode must be exactly 6 digits.");
}

function validateLoginPin(pin) {
  if (!/^\d{4,6}$/.test(String(pin ?? ""))) throw badRequest("Passcode must be 4 to 6 digits.");
}

function normalizeRow(row) {
  if ("member_id" in row) row.memberId = row.member_id;
  if ("emi_day" in row) row.emiDay = row.emi_day;
  if ("budget_month" in row) row.budgetMonth = row.budget_month;
  if ("received_date" in row) row.receivedDate = row.received_date;
  if ("start_month" in row) row.startMonth = row.start_month;
  if ("end_month" in row) row.endMonth = row.end_month;
  if ("expense_date" in row) row.expenseDate = row.expense_date;
  if ("target_amount" in row) row.targetAmount = row.target_amount;
  if ("target_date" in row) row.targetDate = row.target_date;
  return row;
}

function currentMonthValue() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function generateTemporaryPin() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function formatCurrency(value) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(Number(value || 0));
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function notFound(message) {
  const error = new Error(message);
  error.statusCode = 404;
  return error;
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
