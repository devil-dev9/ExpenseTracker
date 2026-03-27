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
  const { phone, pin } = req.body ?? {};
  validatePhone(phone);
  validatePin(pin);
  const existing = db.prepare("SELECT id FROM users WHERE phone = ?").get(phone);
  if (existing) return res.status(409).json({ error: "Phone number already registered." });
  const totalUsers = db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
  const role = totalUsers === 0 ? "admin" : "user";
  const pinHash = await bcrypt.hash(pin, 10);
  const createdAt = new Date().toISOString();
  const result = db.prepare("INSERT INTO users (phone, pin_hash, role, created_at) VALUES (?, ?, ?, ?)").run(phone, pinHash, role, createdAt);
  const userId = result.lastInsertRowid;
  db.prepare("INSERT INTO profiles (user_id, name, email, company_name, company_email, company_phone, company_address) VALUES (?, '', '', '', '', '', '')").run(userId);
  db.prepare("INSERT INTO members (user_id, name, relation, is_primary) VALUES (?, 'Me', 'Primary user', 1)").run(userId);
  req.session.userId = userId;
  res.status(201).json(buildSessionPayload(userId));
}));

app.post("/api/auth/login", asyncHandler(async (req, res) => {
  const { phone, pin } = req.body ?? {};
  validatePhone(phone);
  validatePin(pin);
  const user = db.prepare("SELECT id, pin_hash FROM users WHERE phone = ?").get(phone);
  if (!user || !(await bcrypt.compare(pin, user.pin_hash))) {
    return res.status(401).json({ error: "Invalid phone number or PIN." });
  }
  req.session.userId = user.id;
  res.json(buildSessionPayload(user.id));
}));

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
    SET name = ?, email = ?, company_name = ?, company_email = ?, company_phone = ?, company_address = ?
    WHERE user_id = ?
  `).run(payload.name, payload.email, payload.companyName, payload.companyEmail, payload.companyPhone, payload.companyAddress, req.session.userId);
  res.json({ ok: true });
});

app.post("/api/account/change-pin", requireAuth, asyncHandler(async (req, res) => {
  const { currentPin, newPin } = req.body ?? {};
  validatePin(currentPin);
  validatePin(newPin);
  const user = db.prepare("SELECT pin_hash FROM users WHERE id = ?").get(req.session.userId);
  if (!(await bcrypt.compare(currentPin, user.pin_hash))) {
    return res.status(400).json({ error: "Current PIN is incorrect." });
  }
  db.prepare("UPDATE users SET pin_hash = ? WHERE id = ?").run(await bcrypt.hash(newPin, 10), req.session.userId);
  res.json({ ok: true });
}));

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
  requireAdmin(req);
  res.json(getInvoices(req.session.userId));
});

app.post("/api/invoices", requireAuth, (req, res) => {
  requireAdmin(req);
  const payload = sanitizeInvoicePayload(req.body ?? {});
  const result = db.prepare(`
    INSERT INTO invoices (user_id, invoice_number, invoice_date, due_date, client_name, client_email, client_address, notes, tax_rate, subtotal, tax_amount, total, items_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.session.userId, payload.invoiceNumber, payload.invoiceDate, payload.dueDate, payload.clientName, payload.clientEmail, payload.clientAddress, payload.notes, payload.taxRate, payload.subtotal, payload.taxAmount, payload.total, JSON.stringify(payload.items), new Date().toISOString());
  res.status(201).json({ id: result.lastInsertRowid, ...payload });
});

app.put("/api/invoices/:id", requireAuth, (req, res) => {
  requireAdmin(req);
  ensureRowOwnership("invoices", req.session.userId, req.params.id);
  const payload = sanitizeInvoicePayload(req.body ?? {});
  db.prepare(`
    UPDATE invoices
    SET invoice_number = ?, invoice_date = ?, due_date = ?, client_name = ?, client_email = ?, client_address = ?, notes = ?, tax_rate = ?, subtotal = ?, tax_amount = ?, total = ?, items_json = ?
    WHERE id = ? AND user_id = ?
  `).run(payload.invoiceNumber, payload.invoiceDate, payload.dueDate, payload.clientName, payload.clientEmail, payload.clientAddress, payload.notes, payload.taxRate, payload.subtotal, payload.taxAmount, payload.total, JSON.stringify(payload.items), req.params.id, req.session.userId);
  res.json({ ok: true });
});

app.delete("/api/invoices/:id", requireAuth, (req, res) => {
  requireAdmin(req);
  ensureRowOwnership("invoices", req.session.userId, req.params.id);
  db.prepare("DELETE FROM invoices WHERE id = ? AND user_id = ?").run(req.params.id, req.session.userId);
  res.json({ ok: true });
});

app.get("/api/admin/users", requireAuth, (req, res) => {
  requireAdmin(req);
  const rows = db.prepare(`
    SELECT u.id, u.phone, u.role, u.created_at, COALESCE(p.name, '') AS name, COALESCE(p.email, '') AS email
    FROM users u
    LEFT JOIN profiles p ON p.user_id = u.id
    ORDER BY u.created_at ASC
  `).all();
  res.json(rows.map((row) => ({ ...row, ...buildUserSummary(row.id) })));
});

app.post("/api/admin/users", requireAuth, asyncHandler(async (req, res) => {
  requireAdmin(req);
  const { phone, pin, role } = req.body ?? {};
  validatePhone(phone);
  validatePin(pin);
  const existing = db.prepare("SELECT id FROM users WHERE phone = ?").get(phone);
  if (existing) return res.status(409).json({ error: "Phone number already registered." });
  const pinHash = await bcrypt.hash(pin, 10);
  const createdAt = new Date().toISOString();
  const nextRole = role === "admin" ? "admin" : "user";
  const result = db.prepare("INSERT INTO users (phone, pin_hash, role, created_at) VALUES (?, ?, ?, ?)").run(phone, pinHash, nextRole, createdAt);
  db.prepare("INSERT INTO profiles (user_id, name, email, company_name, company_email, company_phone, company_address) VALUES (?, '', '', '', '', '', '')").run(result.lastInsertRowid);
  db.prepare("INSERT INTO members (user_id, name, relation, is_primary) VALUES (?, 'Me', 'Primary user', 1)").run(result.lastInsertRowid);
  res.status(201).json({ id: result.lastInsertRowid, phone, role: nextRole, createdAt });
}));

app.post("/api/admin/users/:id/reset-pin", requireAuth, asyncHandler(async (req, res) => {
  requireAdmin(req);
  db.prepare("UPDATE users SET pin_hash = ? WHERE id = ?").run(await bcrypt.hash("1234", 10), req.params.id);
  res.json({ ok: true, temporaryPin: "1234" });
}));

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
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT NOT NULL UNIQUE, pin_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('user', 'admin')), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS profiles (user_id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', company_name TEXT NOT NULL DEFAULT '', company_email TEXT NOT NULL DEFAULT '', company_phone TEXT NOT NULL DEFAULT '', company_address TEXT NOT NULL DEFAULT '', FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS members (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, relation TEXT NOT NULL, is_primary INTEGER NOT NULL DEFAULT 0, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS incomes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, member_id INTEGER NOT NULL, source TEXT NOT NULL, amount REAL NOT NULL, budget_month TEXT NOT NULL, received_date TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS emis (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, member_id INTEGER NOT NULL, name TEXT NOT NULL, amount REAL NOT NULL, start_month TEXT NOT NULL, end_month TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, member_id INTEGER NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, amount REAL NOT NULL, budget_month TEXT NOT NULL, expense_date TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS goals (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, target_amount REAL NOT NULL, target_date TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS goal_contributions (id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id INTEGER NOT NULL, member_id INTEGER NOT NULL, amount REAL NOT NULL, month TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE, FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, invoice_number TEXT NOT NULL, invoice_date TEXT NOT NULL, due_date TEXT NOT NULL, client_name TEXT NOT NULL, client_email TEXT NOT NULL DEFAULT '', client_address TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', tax_rate REAL NOT NULL DEFAULT 0, subtotal REAL NOT NULL DEFAULT 0, tax_amount REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0, items_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE);
  `);
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Authentication required." });
  next();
}

function requireAdmin(req) {
  const user = db.prepare("SELECT role FROM users WHERE id = ?").get(req.session.userId);
  if (!user || user.role !== "admin") throw { statusCode: 403, message: "Admin access required." };
}

function buildSessionPayload(userId) {
  const user = db.prepare("SELECT id, phone, role, created_at FROM users WHERE id = ?").get(userId);
  return { user: { id: user.id, phone: user.phone, role: user.role, createdAt: user.created_at }, profile: getProfile(userId) };
}

function getProfile(userId) {
  const row = db.prepare("SELECT * FROM profiles WHERE user_id = ?").get(userId);
  return { name: row?.name || "", email: row?.email || "", companyName: row?.company_name || "", companyEmail: row?.company_email || "", companyPhone: row?.company_phone || "", companyAddress: row?.company_address || "" };
}

function getMembers(userId) {
  return db.prepare("SELECT * FROM members WHERE user_id = ? ORDER BY is_primary DESC, id ASC").all(userId).map((row) => ({ id: row.id, name: row.name, relation: row.relation, isPrimary: Boolean(row.is_primary) }));
}

function listRows(table, userId) {
  return db.prepare(`SELECT * FROM ${table} WHERE user_id = ? ORDER BY id DESC`).all(userId).map(normalizeRow);
}

function getGoals(userId) {
  const goals = db.prepare("SELECT * FROM goals WHERE user_id = ? ORDER BY id DESC").all(userId).map(normalizeRow);
  const contributions = db.prepare(`SELECT gc.* FROM goal_contributions gc INNER JOIN goals g ON g.id = gc.goal_id WHERE g.user_id = ? ORDER BY gc.id DESC`).all(userId);
  return goals.map((goal) => ({ ...goal, contributions: contributions.filter((item) => item.goal_id === goal.id).map((item) => ({ id: item.id, memberId: item.member_id, amount: item.amount, month: item.month, note: item.note })) }));
}

function getInvoices(userId) {
  return db.prepare("SELECT * FROM invoices WHERE user_id = ? ORDER BY id DESC").all(userId).map((row) => ({ id: row.id, invoiceNumber: row.invoice_number, invoiceDate: row.invoice_date, dueDate: row.due_date, clientName: row.client_name, clientEmail: row.client_email, clientAddress: row.client_address, notes: row.notes, taxRate: row.tax_rate, subtotal: row.subtotal, taxAmount: row.tax_amount, total: row.total, items: JSON.parse(row.items_json || "[]"), createdAt: row.created_at }));
}

function buildMonthlyReport(userId, month) {
  const incomes = db.prepare("SELECT * FROM incomes WHERE user_id = ? AND budget_month = ?").all(userId, month).map(normalizeRow);
  const expenses = db.prepare("SELECT * FROM expenses WHERE user_id = ? AND budget_month = ?").all(userId, month).map(normalizeRow);
  const emis = db.prepare("SELECT * FROM emis WHERE user_id = ? AND start_month <= ? AND end_month >= ?").all(userId, month, month).map(normalizeRow);
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
    columns: ["user_id", "member_id", "name", "amount", "start_month", "end_month", "notes"],
    values: (userId, payload) => [userId, payload.memberId, payload.name, payload.amount, payload.startMonth, payload.endMonth, payload.notes],
    updates: ["member_id = ?", "name = ?", "amount = ?", "start_month = ?", "end_month = ?", "notes = ?"],
    updateValues: (payload) => [payload.memberId, payload.name, payload.amount, payload.startMonth, payload.endMonth, payload.notes]
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
  return { name: String(payload.name || "").trim(), email: String(payload.email || "").trim(), companyName: String(payload.companyName || "").trim(), companyEmail: String(payload.companyEmail || "").trim(), companyPhone: String(payload.companyPhone || "").trim(), companyAddress: String(payload.companyAddress || "").trim() };
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
  const startMonth = requiredMonth(payload.startMonth, "Start month");
  const endMonth = requiredMonth(payload.endMonth, "End month");
  if (endMonth < startMonth) throw badRequest("End month cannot be earlier than start month.");
  return { memberId: Number(payload.memberId), name: requiredString(payload.name, "EMI name"), amount: requiredAmount(payload.amount, "EMI amount"), startMonth, endMonth, notes: String(payload.notes || "").trim() };
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
  const items = Array.isArray(payload.items) ? payload.items.map((item) => ({ description: requiredString(item.description, "Invoice item description"), quantity: requiredAmount(item.quantity, "Invoice quantity"), rate: requiredAmount(item.rate, "Invoice rate"), amount: requiredAmount(item.amount ?? Number(item.quantity) * Number(item.rate), "Invoice amount") })) : [];
  if (!items.length) throw badRequest("Invoice must include at least one line item.");
  return { invoiceNumber: requiredString(payload.invoiceNumber, "Invoice number"), invoiceDate: requiredDate(payload.invoiceDate, "Invoice date"), dueDate: requiredDate(payload.dueDate, "Due date"), clientName: requiredString(payload.clientName, "Client name"), clientEmail: String(payload.clientEmail || "").trim(), clientAddress: String(payload.clientAddress || "").trim(), notes: String(payload.notes || "").trim(), taxRate: Number(payload.taxRate || 0), subtotal: requiredAmount(payload.subtotal, "Subtotal"), taxAmount: requiredAmount(payload.taxAmount, "Tax amount"), total: requiredAmount(payload.total, "Total amount"), items };
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
  if (!/^\d{4}$/.test(String(pin ?? ""))) throw badRequest("PIN must be exactly 4 digits.");
}

function normalizeRow(row) {
  if ("member_id" in row) row.memberId = row.member_id;
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
