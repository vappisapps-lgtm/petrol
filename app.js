const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const session = require("express-session");
const initSqlJs = require("sql.js");
const mysql = require("mysql2/promise");

const BASE_DIR = __dirname;
const LEGACY_DATABASE = path.join(BASE_DIR, "petrol_station.sqlite3");
const DEFAULT_DATA_DIR =
  process.platform === "win32"
    ? BASE_DIR
    : path.join(process.env.HOME || path.dirname(BASE_DIR), "petrol-station-data");
const DATA_DIR = process.env.PETROL_DATA_DIR || DEFAULT_DATA_DIR;
const DATABASE = process.env.PETROL_DB || path.join(DATA_DIR, "petrol_station.sqlite3");
const PORT = Number(process.env.PORT || 3000);
const DB_DIALECT = String(process.env.DB_DIALECT || "sqlite").toLowerCase();
const MYSQL_CONFIG = {
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_LIMIT || 5),
};
const MYSQL_MIGRATION_CODE = String(process.env.MYSQL_MIGRATION_CODE || "").trim();

const app = express();
let db;
let mysqlPool;
let dbInitialized = false;

const PRODUCTS = ["MS", "HSD"];
const DEFAULT_EXPENSE_CATEGORIES = ["Tea", "Cleaning", "Maintenance", "Staff advance", "Miscellaneous"];
const PAYMENT_TYPES = ["Cash", "Phone Pay", "Card", "Credit", "Personal", "Others"];
const USING_MYSQL = DB_DIALECT === "mysql";
const MIGRATION_TABLES = [
  "station",
  "users",
  "tanks",
  "pumps",
  "nozzles",
  "shift_defs",
  "customers",
  "days",
  "tank_readings",
  "day_nozzle_readings",
  "day_pump_testing",
  "shift_entries",
  "shift_payments",
  "expenses",
  "purchases",
  "credit_ledger",
];

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use("/static", express.static(path.join(BASE_DIR, "static")));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-this-before-live-use",
    resave: false,
    saveUninitialized: false,
    cookie: { sameSite: "lax" },
  })
);

const MYSQL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS station (
    id INT PRIMARY KEY,
    station_name VARCHAR(255) NOT NULL,
    owner_name VARCHAR(255) NOT NULL,
    address TEXT,
    location VARCHAR(255),
    contact VARCHAR(100),
    pumps_count INT DEFAULT 0,
    nozzles_per_pump INT DEFAULT 0,
    default_testing_qty DECIMAL(12,3) DEFAULT 5,
    beta_enabled TINYINT DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    mobile VARCHAR(100),
    role VARCHAR(50) NOT NULL,
    password_hash TEXT NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'Active',
    assigned_pumps TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS tanks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    product VARCHAR(20) NOT NULL,
    capacity DECIMAL(14,3) NOT NULL,
    opening_dip DECIMAL(14,3) DEFAULT 0,
    current_stock DECIMAL(14,3) DEFAULT 0,
    status VARCHAR(50) DEFAULT 'Active'
  )`,
  `CREATE TABLE IF NOT EXISTS pumps (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    status VARCHAR(50) DEFAULT 'Active'
  )`,
  `CREATE TABLE IF NOT EXISTS nozzles (
    id INT AUTO_INCREMENT PRIMARY KEY,
    pump_id INT NOT NULL,
    name VARCHAR(255) NOT NULL,
    product VARCHAR(20) NOT NULL,
    tank_id INT NOT NULL,
    status VARCHAR(50) DEFAULT 'Active',
    INDEX (pump_id),
    INDEX (tank_id)
  )`,
  `CREATE TABLE IF NOT EXISTS shift_defs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    start_time VARCHAR(20) NOT NULL,
    end_time VARCHAR(20) NOT NULL,
    description TEXT,
    status VARCHAR(50) DEFAULT 'Active'
  )`,
  `CREATE TABLE IF NOT EXISTS customers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    mobile VARCHAR(100),
    vehicle_number VARCHAR(100),
    company_name VARCHAR(255),
    address TEXT,
    credit_limit DECIMAL(14,2) DEFAULT 0,
    balance DECIMAL(14,2) DEFAULT 0,
    status VARCHAR(50) DEFAULT 'Active'
  )`,
  `CREATE TABLE IF NOT EXISTS days (
    id INT AUTO_INCREMENT PRIMARY KEY,
    business_date VARCHAR(20) NOT NULL UNIQUE,
    ms_price DECIMAL(12,2) NOT NULL,
    hsd_price DECIMAL(12,2) NOT NULL,
    opening_ms DECIMAL(14,3) DEFAULT 0,
    opening_hsd DECIMAL(14,3) DEFAULT 0,
    testing_done TINYINT DEFAULT 0,
    testing_ms_qty DECIMAL(14,3) DEFAULT 0,
    testing_hsd_qty DECIMAL(14,3) DEFAULT 0,
    opening_cash DECIMAL(14,2) DEFAULT 0,
    notes TEXT,
    status VARCHAR(50) DEFAULT 'Open',
    actual_ms DECIMAL(14,3),
    actual_hsd DECIMAL(14,3),
    actual_cash DECIMAL(14,2) DEFAULT 0,
    closed_at TIMESTAMP NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tank_readings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    day_id INT NOT NULL,
    tank_id INT NOT NULL,
    opening_dip DECIMAL(14,3) DEFAULT 0,
    closing_dip DECIMAL(14,3),
    UNIQUE KEY unique_day_tank (day_id, tank_id),
    INDEX (tank_id)
  )`,
  `CREATE TABLE IF NOT EXISTS day_nozzle_readings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    day_id INT NOT NULL,
    nozzle_id INT NOT NULL,
    opening_meter DECIMAL(14,3) NOT NULL DEFAULT 0,
    closing_meter DECIMAL(14,3),
    UNIQUE KEY unique_day_nozzle (day_id, nozzle_id),
    INDEX (nozzle_id)
  )`,
  `CREATE TABLE IF NOT EXISTS day_pump_testing (
    id INT AUTO_INCREMENT PRIMARY KEY,
    day_id INT NOT NULL,
    pump_id INT NOT NULL,
    ms_qty DECIMAL(14,3) DEFAULT 0,
    hsd_qty DECIMAL(14,3) DEFAULT 0,
    UNIQUE KEY unique_day_pump (day_id, pump_id),
    INDEX (pump_id)
  )`,
  `CREATE TABLE IF NOT EXISTS shift_entries (
    id INT AUTO_INCREMENT PRIMARY KEY,
    day_id INT NOT NULL,
    business_date VARCHAR(20) NOT NULL,
    shift_def_id INT NOT NULL,
    user_id INT NOT NULL,
    nozzle_id INT NOT NULL,
    tank_id INT NOT NULL,
    product VARCHAR(20) NOT NULL,
    opening_meter DECIMAL(14,3) NOT NULL,
    closing_meter DECIMAL(14,3),
    litres_sold DECIMAL(14,3) DEFAULT 0,
    rate DECIMAL(12,2) DEFAULT 0,
    sales_amount DECIMAL(14,2) DEFAULT 0,
    cash DECIMAL(14,2) DEFAULT 0,
    upi DECIMAL(14,2) DEFAULT 0,
    card DECIMAL(14,2) DEFAULT 0,
    credit DECIMAL(14,2) DEFAULT 0,
    customer_id INT,
    expenses DECIMAL(14,2) DEFAULT 0,
    beta DECIMAL(14,2) DEFAULT 0,
    miscellaneous DECIMAL(14,2) DEFAULT 0,
    misc_note TEXT,
    remarks TEXT,
    shortage_excess DECIMAL(14,2) DEFAULT 0,
    testing_qty DECIMAL(14,3) DEFAULT 0,
    status VARCHAR(50) DEFAULT 'Open',
    opened_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closed_at TIMESTAMP NULL,
    INDEX (day_id),
    INDEX (user_id),
    INDEX (nozzle_id),
    INDEX (tank_id)
  )`,
  `CREATE TABLE IF NOT EXISTS shift_payments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    shift_entry_id INT NOT NULL,
    product VARCHAR(20),
    payment_type VARCHAR(50),
    amount DECIMAL(14,2) DEFAULT 0,
    cash DECIMAL(14,2) DEFAULT 0,
    upi DECIMAL(14,2) DEFAULT 0,
    card DECIMAL(14,2) DEFAULT 0,
    credit DECIMAL(14,2) DEFAULT 0,
    customer_id INT,
    note TEXT,
    recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (shift_entry_id)
  )`,
  `CREATE TABLE IF NOT EXISTS expenses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    business_date VARCHAR(20) NOT NULL,
    shift_entry_id INT,
    paid_by INT,
    category VARCHAR(255) NOT NULL,
    amount DECIMAL(14,2) NOT NULL,
    note TEXT,
    payment_mode VARCHAR(50) DEFAULT 'Cash',
    approved TINYINT DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS purchases (
    id INT AUTO_INCREMENT PRIMARY KEY,
    business_date VARCHAR(20) NOT NULL,
    product VARCHAR(20) NOT NULL,
    quantity DECIMAL(14,3) NOT NULL,
    supplier VARCHAR(255),
    invoice_number VARCHAR(255),
    rate DECIMAL(12,2) DEFAULT 0,
    total_amount DECIMAL(14,2) DEFAULT 0,
    tank_id INT NOT NULL,
    before_stock DECIMAL(14,3) DEFAULT 0,
    after_stock DECIMAL(14,3) DEFAULT 0,
    notes TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (tank_id)
  )`,
  `CREATE TABLE IF NOT EXISTS credit_ledger (
    id INT AUTO_INCREMENT PRIMARY KEY,
    customer_id INT NOT NULL,
    business_date VARCHAR(20) NOT NULL,
    entry_type VARCHAR(50) NOT NULL,
    product VARCHAR(20),
    litres DECIMAL(14,3) DEFAULT 0,
    amount DECIMAL(14,2) NOT NULL,
    vehicle_number VARCHAR(100),
    pump_nozzle VARCHAR(255),
    team_member VARCHAR(255),
    shift_entry_id INT,
    payment_mode VARCHAR(50),
    notes TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (customer_id),
    INDEX (shift_entry_id)
  )`,
];

async function initMysqlDb() {
  for (const sql of MYSQL_SCHEMA) await db.query(sql);
  for (const sql of [
    "ALTER TABLE shift_entries ADD COLUMN testing_qty DECIMAL(14,3) DEFAULT 0",
    "ALTER TABLE days ADD COLUMN testing_ms_qty DECIMAL(14,3) DEFAULT 0",
    "ALTER TABLE days ADD COLUMN testing_hsd_qty DECIMAL(14,3) DEFAULT 0",
    "ALTER TABLE shift_payments ADD COLUMN product VARCHAR(20)",
    "ALTER TABLE shift_payments ADD COLUMN payment_type VARCHAR(50)",
    "ALTER TABLE shift_payments ADD COLUMN amount DECIMAL(14,2) DEFAULT 0",
  ]) {
    try {
      await db.query(sql);
    } catch (_err) {}
  }
  await db.query(`
    INSERT IGNORE INTO day_nozzle_readings(day_id, nozzle_id, opening_meter)
    SELECT se.day_id, se.nozzle_id, se.opening_meter
    FROM shift_entries se
    JOIN (
      SELECT day_id, nozzle_id, MIN(id) first_entry_id
      FROM shift_entries
      GROUP BY day_id, nozzle_id
    ) firsts ON firsts.first_entry_id=se.id
  `);
}

async function initDb() {
  if (dbInitialized) return;
  if (USING_MYSQL) {
    await initMysqlDb();
    dbInitialized = true;
    return;
  }
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS station (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      station_name TEXT NOT NULL,
      owner_name TEXT NOT NULL,
      address TEXT,
      location TEXT,
      contact TEXT,
      pumps_count INTEGER DEFAULT 0,
      nozzles_per_pump INTEGER DEFAULT 0,
      default_testing_qty REAL DEFAULT 5,
      beta_enabled INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      mobile TEXT,
      role TEXT NOT NULL CHECK(role IN ('admin','manager','pump_boy')),
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Active',
      assigned_pumps TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS tanks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      product TEXT NOT NULL CHECK(product IN ('MS','HSD')),
      capacity REAL NOT NULL,
      opening_dip REAL DEFAULT 0,
      current_stock REAL DEFAULT 0,
      status TEXT DEFAULT 'Active'
    );
    CREATE TABLE IF NOT EXISTS pumps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'Active'
    );
    CREATE TABLE IF NOT EXISTS nozzles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pump_id INTEGER NOT NULL REFERENCES pumps(id),
      name TEXT NOT NULL,
      product TEXT NOT NULL CHECK(product IN ('MS','HSD')),
      tank_id INTEGER NOT NULL REFERENCES tanks(id),
      status TEXT DEFAULT 'Active'
    );
    CREATE TABLE IF NOT EXISTS shift_defs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'Active'
    );
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      mobile TEXT,
      vehicle_number TEXT,
      company_name TEXT,
      address TEXT,
      credit_limit REAL DEFAULT 0,
      balance REAL DEFAULT 0,
      status TEXT DEFAULT 'Active'
    );
    CREATE TABLE IF NOT EXISTS days (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_date TEXT NOT NULL UNIQUE,
      ms_price REAL NOT NULL,
      hsd_price REAL NOT NULL,
      opening_ms REAL DEFAULT 0,
      opening_hsd REAL DEFAULT 0,
      testing_done INTEGER DEFAULT 0,
      testing_ms_qty REAL DEFAULT 0,
      testing_hsd_qty REAL DEFAULT 0,
      opening_cash REAL DEFAULT 0,
      notes TEXT,
      status TEXT DEFAULT 'Open',
      actual_ms REAL,
      actual_hsd REAL,
      actual_cash REAL DEFAULT 0,
      closed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS tank_readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day_id INTEGER NOT NULL REFERENCES days(id),
      tank_id INTEGER NOT NULL REFERENCES tanks(id),
      opening_dip REAL DEFAULT 0,
      closing_dip REAL,
      UNIQUE(day_id, tank_id)
    );
    CREATE TABLE IF NOT EXISTS day_nozzle_readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day_id INTEGER NOT NULL REFERENCES days(id),
      nozzle_id INTEGER NOT NULL REFERENCES nozzles(id),
      opening_meter REAL NOT NULL DEFAULT 0,
      closing_meter REAL,
      UNIQUE(day_id, nozzle_id)
    );
    CREATE TABLE IF NOT EXISTS day_pump_testing (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day_id INTEGER NOT NULL REFERENCES days(id),
      pump_id INTEGER NOT NULL REFERENCES pumps(id),
      ms_qty REAL DEFAULT 0,
      hsd_qty REAL DEFAULT 0,
      UNIQUE(day_id, pump_id)
    );
    CREATE TABLE IF NOT EXISTS shift_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day_id INTEGER NOT NULL REFERENCES days(id),
      business_date TEXT NOT NULL,
      shift_def_id INTEGER NOT NULL REFERENCES shift_defs(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      nozzle_id INTEGER NOT NULL REFERENCES nozzles(id),
      tank_id INTEGER NOT NULL REFERENCES tanks(id),
      product TEXT NOT NULL CHECK(product IN ('MS','HSD')),
      opening_meter REAL NOT NULL,
      closing_meter REAL,
      litres_sold REAL DEFAULT 0,
      rate REAL DEFAULT 0,
      sales_amount REAL DEFAULT 0,
      cash REAL DEFAULT 0,
      upi REAL DEFAULT 0,
      card REAL DEFAULT 0,
      credit REAL DEFAULT 0,
      customer_id INTEGER REFERENCES customers(id),
      expenses REAL DEFAULT 0,
      beta REAL DEFAULT 0,
      miscellaneous REAL DEFAULT 0,
      misc_note TEXT,
      remarks TEXT,
      shortage_excess REAL DEFAULT 0,
      testing_qty REAL DEFAULT 0,
      status TEXT DEFAULT 'Open',
      opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      closed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS shift_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shift_entry_id INTEGER NOT NULL REFERENCES shift_entries(id),
      product TEXT,
      payment_type TEXT,
      amount REAL DEFAULT 0,
      cash REAL DEFAULT 0,
      upi REAL DEFAULT 0,
      card REAL DEFAULT 0,
      credit REAL DEFAULT 0,
      customer_id INTEGER REFERENCES customers(id),
      note TEXT,
      recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_date TEXT NOT NULL,
      shift_entry_id INTEGER REFERENCES shift_entries(id),
      paid_by INTEGER REFERENCES users(id),
      category TEXT NOT NULL,
      amount REAL NOT NULL,
      note TEXT,
      payment_mode TEXT DEFAULT 'Cash',
      approved INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_date TEXT NOT NULL,
      product TEXT NOT NULL CHECK(product IN ('MS','HSD')),
      quantity REAL NOT NULL,
      supplier TEXT,
      invoice_number TEXT,
      rate REAL DEFAULT 0,
      total_amount REAL DEFAULT 0,
      tank_id INTEGER NOT NULL REFERENCES tanks(id),
      before_stock REAL DEFAULT 0,
      after_stock REAL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS credit_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      business_date TEXT NOT NULL,
      entry_type TEXT NOT NULL CHECK(entry_type IN ('credit','payment')),
      product TEXT,
      litres REAL DEFAULT 0,
      amount REAL NOT NULL,
      vehicle_number TEXT,
      pump_nozzle TEXT,
      team_member TEXT,
      shift_entry_id INTEGER REFERENCES shift_entries(id),
      payment_mode TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  for (const sql of [
    "ALTER TABLE shift_entries ADD COLUMN testing_qty REAL DEFAULT 0",
    "ALTER TABLE days ADD COLUMN testing_ms_qty REAL DEFAULT 0",
    "ALTER TABLE days ADD COLUMN testing_hsd_qty REAL DEFAULT 0",
    "ALTER TABLE shift_payments ADD COLUMN product TEXT",
    "ALTER TABLE shift_payments ADD COLUMN payment_type TEXT",
    "ALTER TABLE shift_payments ADD COLUMN amount REAL DEFAULT 0",
  ]) {
    try {
      db.exec(sql);
    } catch (_err) {}
  }
  db.exec(`
    INSERT OR IGNORE INTO day_nozzle_readings(day_id, nozzle_id, opening_meter)
    SELECT se.day_id, se.nozzle_id, se.opening_meter
    FROM shift_entries se
    JOIN (
      SELECT day_id, nozzle_id, MIN(id) first_entry_id
      FROM shift_entries
      GROUP BY day_id, nozzle_id
    ) firsts ON firsts.first_entry_id=se.id
  `);
  persistDb();
  dbInitialized = true;
}

function mysqlOrderSql(sql) {
  return sql
    .replaceAll(
      "CASE WHEN name GLOB 'Pump [0-9]*' THEN CAST(SUBSTR(name, 6) AS INTEGER) ELSE 999999 END, name",
      "CASE WHEN name REGEXP '^Pump [0-9]+' THEN CAST(SUBSTRING(name, 6) AS UNSIGNED) ELSE 999999 END, name"
    )
    .replaceAll(
      "CASE WHEN p.name GLOB 'Pump [0-9]*' THEN CAST(SUBSTR(p.name, 6) AS INTEGER) ELSE 999999 END, p.name",
      "CASE WHEN p.name REGEXP '^Pump [0-9]+' THEN CAST(SUBSTRING(p.name, 6) AS UNSIGNED) ELSE 999999 END, p.name"
    );
}

async function all(sql, params = []) {
  if (USING_MYSQL) {
    const [rows] = await db.execute(mysqlOrderSql(sql), params);
    return rows;
  }
  const stmt = db.prepare(sql);
  const rows = [];
  try {
    stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject());
  } finally {
    stmt.free();
  }
  return rows;
}

async function one(sql, params = []) {
  return (await all(sql, params))[0];
}

async function run(sql, params = []) {
  if (USING_MYSQL) {
    const [info] = await db.execute(mysqlOrderSql(sql), params);
    return { lastInsertRowid: info.insertId || 0, changes: info.affectedRows || 0 };
  }
  const stmt = db.prepare(sql);
  try {
    stmt.run(params);
  } finally {
    stmt.free();
  }
  const info = await one("SELECT last_insert_rowid() AS lastInsertRowid, changes() AS changes");
  persistDb();
  return info;
}

function persistDb() {
  if (!db || USING_MYSQL) return;
  fs.mkdirSync(path.dirname(DATABASE), { recursive: true });
  fs.writeFileSync(DATABASE, Buffer.from(db.export()));
}

function prepareDatabaseFile() {
  fs.mkdirSync(path.dirname(DATABASE), { recursive: true });
  if (fs.existsSync(DATABASE)) return;
  if (DATABASE !== LEGACY_DATABASE && fs.existsSync(LEGACY_DATABASE)) {
    fs.copyFileSync(LEGACY_DATABASE, DATABASE);
    return;
  }
}

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function litres(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function rs(value) {
  return `Rs. ${money(value).toFixed(2)}`;
}

function ltr(value) {
  return `${litres(value).toFixed(3)} L`;
}

function option(value, label, selected) {
  return `<option value="${esc(value)}"${String(value) === String(selected) ? " selected" : ""}>${esc(label ?? value)}</option>`;
}

function optionDisabled(value, label, selected, disabled = false) {
  return `<option value="${esc(value)}"${String(value) === String(selected) ? " selected" : ""}${disabled ? " disabled" : ""}>${esc(label ?? value)}</option>`;
}

function flash(req, category, message) {
  req.session.flash = req.session.flash || [];
  req.session.flash.push({ category, message });
}

function popFlash(req) {
  const messages = req.session.flash || [];
  req.session.flash = [];
  return messages;
}

async function setupRequired() {
  return Number((await one("SELECT COUNT(*) AS c FROM users")).c) === 0;
}

async function activeDay() {
  return await one("SELECT * FROM days WHERE status='Open' ORDER BY business_date DESC LIMIT 1");
}

function productPrice(day, product) {
  return Number(product === "MS" ? day.ms_price : day.hsd_price);
}

async function lastMeter(nozzleId) {
  const row = await one(
    "SELECT closing_meter FROM shift_entries WHERE nozzle_id=? AND closing_meter IS NOT NULL ORDER BY id DESC LIMIT 1",
    [nozzleId]
  );
  return row ? Number(row.closing_meter) : null;
}

async function dayOpeningMeter(dayId, nozzleId) {
  const row = await one("SELECT opening_meter FROM day_nozzle_readings WHERE day_id=? AND nozzle_id=?", [dayId, nozzleId]);
  return row ? Number(row.opening_meter) : null;
}

function fieldValue(values, name, fallback = "") {
  return values && Object.prototype.hasOwnProperty.call(values, name) ? values[name] : fallback;
}

function inlineError(message) {
  return message ? `<div class="form-error span-2">${esc(message)}</div>` : "";
}

async function detectShift(timeStr) {
  const shifts = await all("SELECT * FROM shift_defs WHERE status='Active' ORDER BY start_time");
  if (!shifts.length) return null;
  const now = timeStr || new Date().toTimeString().slice(0, 5);
  for (const shift of shifts) {
    if (shift.end_time < shift.start_time) {
      if (now >= shift.start_time || now <= shift.end_time) return shift;
    } else if (now >= shift.start_time && now <= shift.end_time) {
      return shift;
    }
  }
  return shifts[0];
}

async function getShiftPaymentsTotal(entryId) {
  return await one(
    `SELECT
     COALESCE(SUM(CASE WHEN payment_type='Cash' THEN amount ELSE cash END),0) cash,
     COALESCE(SUM(CASE WHEN payment_type='Phone Pay' THEN amount ELSE upi END),0) upi,
     COALESCE(SUM(CASE WHEN payment_type='Card' THEN amount ELSE card END),0) card,
     COALESCE(SUM(CASE WHEN payment_type='Credit' THEN amount ELSE credit END),0) credit,
     COALESCE(SUM(CASE WHEN payment_type='Personal' THEN amount ELSE 0 END),0) personal,
     COALESCE(SUM(CASE WHEN payment_type='Others' THEN amount ELSE 0 END),0) others,
     COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE cash+upi+card+credit END),0) total
     FROM shift_payments WHERE shift_entry_id=?`,
    [entryId]
  );
}

function paymentColumn(paymentType) {
  if (paymentType === "Cash") return "cash";
  if (paymentType === "Phone Pay") return "upi";
  if (paymentType === "Card") return "card";
  if (paymentType === "Credit") return "credit";
  return null;
}

async function getPumpPaymentRows(pumpId, req) {
  const where = req.user.role === "pump_boy" ? "AND se.user_id=?" : "";
  const params = req.user.role === "pump_boy" ? [pumpId, req.user.id] : [pumpId];
  return await all(
    `SELECT sp.recorded_at time, sp.product, sp.payment_type, sp.amount, sp.note, c.name customer
     FROM shift_payments sp
     JOIN shift_entries se ON se.id=sp.shift_entry_id
     JOIN nozzles n ON n.id=se.nozzle_id
     LEFT JOIN customers c ON c.id=sp.customer_id
     WHERE n.pump_id=? AND se.status='Open' ${where}
     ORDER BY sp.recorded_at DESC, sp.id DESC`,
    params
  );
}

async function getPumpPaymentTotals(pumpId, req) {
  const rows = await getPumpPaymentRows(pumpId, req);
  const totals = { cash: 0, phone_pay: 0, card: 0, credit: 0, personal: 0, others: 0, total: 0 };
  for (const row of rows) {
    const amount = money(row.amount);
    if (row.payment_type === "Cash") totals.cash = money(totals.cash + amount);
    if (row.payment_type === "Phone Pay") totals.phone_pay = money(totals.phone_pay + amount);
    if (row.payment_type === "Card") totals.card = money(totals.card + amount);
    if (row.payment_type === "Credit") totals.credit = money(totals.credit + amount);
    if (row.payment_type === "Personal") totals.personal = money(totals.personal + amount);
    if (row.payment_type === "Others") totals.others = money(totals.others + amount);
    totals.total = money(totals.total + amount);
  }
  return totals;
}

async function decrementLargestTank(product, quantity) {
  const tank = await one("SELECT id FROM tanks WHERE product=? AND status='Active' ORDER BY current_stock DESC LIMIT 1", [product]);
  if (tank) await run("UPDATE tanks SET current_stock=current_stock-? WHERE id=?", [quantity, tank.id]);
}

function verifyWerkzeug(password, stored) {
  if (!stored || !stored.includes("$")) return false;
  const [method, salt, digest] = stored.split("$");
  try {
    if (method.startsWith("scrypt:")) {
      const [, n, r, p] = method.split(":");
      const key = crypto.scryptSync(password, salt, 64, {
        N: Number(n),
        r: Number(r),
        p: Number(p),
        maxmem: 128 * Number(n) * Number(r) * 2,
      });
      return crypto.timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(key.toString("hex"), "hex"));
    }
    if (method.startsWith("pbkdf2:")) {
      const [, hashName, iterations] = method.split(":");
      const key = crypto.pbkdf2Sync(password, salt, Number(iterations), 32, hashName);
      return crypto.timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(key.toString("hex"), "hex"));
    }
  } catch (_err) {
    return false;
  }
  return false;
}

function hashWerkzeug(password) {
  const salt = crypto.randomBytes(12).toString("base64url");
  const key = crypto.scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 67108864 });
  return `scrypt:32768:8:1$${salt}$${key.toString("hex")}`;
}

function adminResetConfig() {
  const filePath = path.join(BASE_DIR, "tmp", "admin-reset-code.txt");
  const envCode = String(process.env.ADMIN_RESET_CODE || "").trim();
  if (envCode) return { code: envCode, source: "environment" };
  if (fs.existsSync(filePath)) {
    const fileCode = fs.readFileSync(filePath, "utf8").trim();
    if (fileCode) return { code: fileCode, source: "file", filePath };
  }
  return null;
}

function readSqliteRows(sqliteDb, sql, params = []) {
  const stmt = sqliteDb.prepare(sql);
  const rows = [];
  try {
    stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject());
  } finally {
    stmt.free();
  }
  return rows;
}

async function migrateSqliteToMysql(sqlitePath) {
  if (!USING_MYSQL) throw new Error("Migration is only available when DB_DIALECT=mysql.");
  if (!fs.existsSync(sqlitePath)) throw new Error(`SQLite file was not found at ${sqlitePath}.`);
  const targetUsers = await one("SELECT COUNT(*) c FROM users");
  if (Number(targetUsers?.c || 0) > 0) {
    throw new Error("MySQL already has users, so migration stopped to avoid duplicating or overwriting data.");
  }
  const SQL = await initSqlJs();
  const sqliteDb = new SQL.Database(fs.readFileSync(sqlitePath));
  const summary = [];
  await db.query("SET FOREIGN_KEY_CHECKS=0");
  try {
    for (const tableName of MIGRATION_TABLES) {
      const exists = readSqliteRows(sqliteDb, "SELECT name FROM sqlite_master WHERE type='table' AND name=?", [tableName])[0];
      if (!exists) {
        summary.push({ table: tableName, rows: 0, skipped: true });
        continue;
      }
      const columns = readSqliteRows(sqliteDb, `PRAGMA table_info(${tableName})`).map((c) => c.name);
      const rows = readSqliteRows(sqliteDb, `SELECT * FROM ${tableName}`);
      if (!rows.length) {
        summary.push({ table: tableName, rows: 0 });
        continue;
      }
      const quotedTable = `\`${tableName}\``;
      const quotedColumns = columns.map((c) => `\`${c}\``).join(", ");
      const placeholders = columns.map(() => "?").join(", ");
      const sql = `INSERT INTO ${quotedTable} (${quotedColumns}) VALUES (${placeholders})`;
      for (const row of rows) {
        await db.execute(sql, columns.map((c) => (row[c] === undefined ? null : row[c])));
      }
      summary.push({ table: tableName, rows: rows.length });
    }
  } finally {
    sqliteDb.close();
    await db.query("SET FOREIGN_KEY_CHECKS=1");
  }
  return summary;
}

async function ensureConfiguredPumpProducts() {
  const tankIds = {};
  for (const product of PRODUCTS) {
    let tank = await one("SELECT * FROM tanks WHERE product=? AND status='Active' ORDER BY id LIMIT 1", [product]);
    if (!tank) {
      const created = await run("INSERT INTO tanks(name, product, capacity, opening_dip, current_stock, status) VALUES(?,?,?,?,?,?)", [
        `${product} Tank`,
        product,
        20000,
        0,
        0,
        "Active",
      ]);
      tank = await one("SELECT * FROM tanks WHERE id=?", [created.lastInsertRowid]);
    }
    tankIds[product] = tank.id;
  }
  const pumps = await all("SELECT * FROM pumps WHERE status='Active'");
  for (const pump of pumps) {
    for (const product of PRODUCTS) {
      const existing = await one("SELECT id FROM nozzles WHERE pump_id=? AND product=? AND status='Active'", [pump.id, product]);
      if (!existing) {
        await run("INSERT INTO nozzles(pump_id, name, product, tank_id, status) VALUES(?,?,?,?,?)", [
          pump.id,
          `${pump.name} ${product}`,
          product,
          tankIds[product],
          "Active",
        ]);
      }
    }
  }
}

function pumpOrderSql(alias = "p") {
  return `CASE WHEN ${alias}.name GLOB 'Pump [0-9]*' THEN CAST(SUBSTR(${alias}.name, 6) AS INTEGER) ELSE 999999 END, ${alias}.name`;
}

function groupPumpEntries(entries) {
  const grouped = new Map();
  for (const e of entries) {
    if (!grouped.has(e.pump_id)) {
      grouped.set(e.pump_id, {
        pump_id: e.pump_id,
        business_date: e.business_date,
        pump: e.pump,
        user_name: e.user_name,
        shift_name: e.shift_name,
        ms_opening: "",
        hsd_opening: "",
        ms_closing: "",
        hsd_closing: "",
        status: e.status,
      });
    }
    const row = grouped.get(e.pump_id);
    if (e.product === "MS") {
      row.ms_opening = e.opening_meter;
      row.ms_closing = e.closing_meter ?? "";
    }
    if (e.product === "HSD") {
      row.hsd_opening = e.opening_meter;
      row.hsd_closing = e.closing_meter ?? "";
    }
  }
  return Array.from(grouped.values());
}

async function activePumpGroups(req) {
  const where = req.user.role === "pump_boy" ? "AND se.user_id=?" : "";
  const params = req.user.role === "pump_boy" ? [req.user.id] : [];
  return groupPumpEntries(
    await all(
      `SELECT se.id, se.business_date, p.id pump_id, p.name pump, se.product, u.name user_name, sd.name shift_name,
       se.opening_meter, se.closing_meter, se.status
       FROM shift_entries se
       JOIN users u ON u.id=se.user_id
       JOIN shift_defs sd ON sd.id=se.shift_def_id
       JOIN nozzles n ON n.id=se.nozzle_id
       JOIN pumps p ON p.id=n.pump_id
       WHERE se.status='Open' ${where}
       ORDER BY ${pumpOrderSql("p")}, se.product`,
      params
    )
  );
}

async function dashboardMetrics() {
  const day = await activeDay();
  if (!day) return { day: null };
  const totals = await one(
    `SELECT COALESCE(SUM(sales_amount),0) sales, COALESCE(SUM(cash),0) cash,
     COALESCE(SUM(upi),0) upi, COALESCE(SUM(card),0) card, COALESCE(SUM(credit),0) credit,
     COALESCE(SUM(expenses),0) expenses, COALESCE(SUM(beta),0) beta,
     COALESCE(SUM(CASE WHEN product='MS' THEN litres_sold ELSE 0 END),0) ms_litres,
     COALESCE(SUM(CASE WHEN product='HSD' THEN litres_sold ELSE 0 END),0) hsd_litres,
     COALESCE(SUM(CASE WHEN product='MS' THEN sales_amount ELSE 0 END),0) ms_sales,
     COALESCE(SUM(CASE WHEN product='HSD' THEN sales_amount ELSE 0 END),0) hsd_sales
     FROM shift_entries WHERE day_id=? AND status='Closed'`,
    [day.id]
  );
  return {
    day,
    totals,
    open_shifts: (await one("SELECT COUNT(*) c FROM shift_entries WHERE day_id=? AND status='Open'", [day.id])).c,
    tank_stock: await all("SELECT product, COALESCE(SUM(current_stock),0) stock FROM tanks GROUP BY product"),
    credit_pending: (await one("SELECT COALESCE(SUM(balance),0) b FROM customers WHERE status='Active'")).b,
    top_customers: await all("SELECT name, balance FROM customers WHERE balance>0 ORDER BY balance DESC LIMIT 5"),
    pump_sales: await all(
      `SELECT p.name pump, COALESCE(SUM(se.sales_amount),0) sales, COALESCE(SUM(se.litres_sold),0) litres
       FROM pumps p
       LEFT JOIN nozzles n ON n.pump_id=p.id
       LEFT JOIN shift_entries se ON se.nozzle_id=n.id AND se.day_id=? AND se.status='Closed'
       GROUP BY p.id, p.name ORDER BY p.name`,
      [day.id]
    ),
    boy_sales: await all(
      `SELECT u.name, COALESCE(SUM(se.sales_amount),0) sales, COALESCE(SUM(se.litres_sold),0) litres
       FROM users u JOIN shift_entries se ON se.user_id=u.id
       WHERE se.day_id=? AND se.status='Closed'
       GROUP BY u.id, u.name ORDER BY sales DESC`,
      [day.id]
    ),
    payment_totals: await all(
      `SELECT sp.payment_type, COALESCE(SUM(sp.amount),0) amount
       FROM shift_payments sp JOIN shift_entries se ON se.id=sp.shift_entry_id
       WHERE se.day_id=?
       GROUP BY sp.payment_type
       ORDER BY sp.payment_type`,
      [day.id]
    ),
  };
}

async function requireLogin(req, res, next) {
  try {
    if ((await setupRequired()) && req.path !== "/setup") return res.redirect("/setup");
    if (!req.user) return res.redirect("/login");
    next();
  } catch (err) {
    next(err);
  }
}

function requireRoles(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect("/login");
    if (!roles.includes(req.user.role)) return res.status(403).send("Forbidden");
    next();
  };
}

app.use(async (req, _res, next) => {
  try {
    await initDb();
    req.station = await one("SELECT * FROM station WHERE id=1");
    req.user = req.session.userId
      ? await one("SELECT * FROM users WHERE id=? AND status='Active'", [req.session.userId])
      : null;
    next();
  } catch (err) {
    next(err);
  }
});

function layout(req, title, content) {
  const messages = popFlash(req)
    .map((m) => `<div class="flash ${esc(m.category)}">${esc(m.message)}</div>`)
    .join("");
  const navAdmin =
    req.user && ["admin", "manager"].includes(req.user.role)
      ? `
      <a href="/day/start">Day Start</a>
      <a href="/shift/start">Start Shift</a>
      <a href="/shifts/active">Active Shifts</a>
      <a href="/shift/close">Close Shift</a>
      <a href="/purchase">Fuel Inward</a>
      <a href="/credit/payment">Credit Payments</a>
      <a href="/day/close">Day Closing</a>
      <a href="/reports">Reports</a>
      <div class="nav-label">Setup</div>
      <a href="/master/tanks">Tanks</a>
      <a href="/master/pumps">Pumps</a>
      <a href="/master/team">Team</a>
      <a href="/master/shifts">Shifts</a>
      <a href="/master/customers">Credit Customers</a>
      ${req.user.role === "admin" ? '<a href="/station">Station</a>' : ""}`
      : `
      <a href="/shift/start">Start Shift</a>
      <a href="/shifts/active">Active Shifts</a>
      <a href="/shift/close">Close Shift</a>`;
  return `<!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${esc(title || "Petrol Station Manager")}</title>
    <link rel="stylesheet" href="/static/app.css">
  </head>
  <body>
    ${
      req.user
        ? `<aside class="sidebar">
          <div class="brand"><span class="brand-mark">${esc((req.station?.station_name || "P").slice(0, 1))}</span>
            <div><strong>${esc(req.station?.station_name || "Petrol OS")}</strong><small>${esc(req.station?.location || "Operations")}</small></div></div>
          <nav><a href="/">Dashboard</a>${navAdmin}</nav>
          <div class="upgrade"><strong>Daily Operations</strong><span>Readings, stock, cash and credit stay connected.</span></div>
        </aside>`
        : ""
    }
    <main class="${req.user ? "shell" : "auth-shell"}">
      ${
        req.user
          ? `<header class="topbar"><div class="search">Search station records...</div><div class="profile"><span class="badge">${esc(req.user.role.replace("_", " "))}</span><strong>${esc(req.user.name)}</strong><a href="/logout">Logout</a></div></header>`
          : ""
      }
      ${messages ? `<div class="flash-wrap">${messages}</div>` : ""}
      ${content}
    </main>
  </body></html>`;
}

function table(rows) {
  if (!rows.length) return `<div class="table-wrap"><table><thead><tr><th>Records</th></tr></thead><tbody><tr><td>No records yet.</td></tr></tbody></table></div>`;
  const keys = Object.keys(rows[0]);
  return `<div class="table-wrap"><table><thead><tr>${keys.map((k) => `<th>${esc(k.replaceAll("_", " "))}</th>`).join("")}</tr></thead><tbody>
    ${rows.map((r) => `<tr>${keys.map((k) => `<td>${k === "actions" ? r[k] : esc(r[k])}</td>`).join("")}</tr>`).join("")}
  </tbody></table></div>`;
}

function pageHead(title, crumb = "", action = "") {
  return `<section class="page-head"><div><small>${esc(crumb)}</small><h1>${esc(title)}</h1></div>${action}</section>`;
}

app.get("/setup", async (req, res) => {
  if (!(await setupRequired())) return res.redirect("/");
  res.send(
    layout(
      req,
      "Setup",
      `<section class="auth-card"><h1>Setup Petrol Station</h1><p class="muted">Create the owner login and first station profile.</p>
      <form method="post" class="grid-form">
        <label class="field"><span>Station name</span><input name="station_name" required></label>
        <label class="field"><span>Owner name</span><input name="owner_name" required></label>
        <label class="field"><span>Location</span><input name="location"></label>
        <label class="field"><span>Contact / login ID</span><input name="contact"></label>
        <label class="field span-2"><span>Address</span><textarea name="address"></textarea></label>
        <label class="field"><span>Default testing litres</span><input name="default_testing_qty" type="number" step="0.001" value="5"></label>
        <label class="field"><span>Password</span><input name="password" type="password" required></label>
        <div class="action-row"><button class="primary">Create Station</button></div>
      </form></section>`
    )
  );
});

app.post("/setup", async (req, res) => {
  if (!(await setupRequired())) return res.redirect("/");
  if (!req.body.station_name || !req.body.owner_name || String(req.body.password || "").length < 6) {
    flash(req, "error", "Station, owner, and a password of at least 6 characters are required.");
    return res.redirect("/setup");
  }
  await run(
    `INSERT INTO station(id, station_name, owner_name, address, location, contact, default_testing_qty)
     VALUES(1,?,?,?,?,?,?)`,
    [
      req.body.station_name,
      req.body.owner_name,
      req.body.address || "",
      req.body.location || "",
      req.body.contact || "",
      Number(req.body.default_testing_qty || 5),
    ]
  );
  const user = await run("INSERT INTO users(name, mobile, role, password_hash) VALUES(?,?,?,?)", [
    req.body.owner_name,
    req.body.contact || "",
    "admin",
    hashWerkzeug(req.body.password),
  ]);
  req.session.userId = user.lastInsertRowid;
  flash(req, "success", "Station setup complete.");
  res.redirect("/");
});

app.get("/login", async (req, res) => {
  if (await setupRequired()) return res.redirect("/setup");
  res.send(
    layout(
      req,
      "Login",
      `<section class="auth-card"><h1>Login</h1><p class="muted">Use your mobile/login ID and password.</p>
      <form method="post" class="grid-form">
        <label class="field span-2"><span>Username / login ID</span><input name="mobile" required></label>
        <label class="field span-2"><span>Password</span><input name="password" type="password" required></label>
        <div class="action-row"><button class="primary">Login</button></div>
      </form></section>`
    )
  );
});

app.post("/login", async (req, res) => {
  const user = await one("SELECT * FROM users WHERE mobile=? AND status='Active'", [String(req.body.mobile || "").trim()]);
  if (user && verifyWerkzeug(req.body.password || "", user.password_hash)) {
    req.session.userId = user.id;
    return res.redirect("/");
  }
  flash(req, "error", "Invalid username or password.");
  res.redirect("/login");
});

function renderAdminReset(req, res, values = {}, message = "", category = "error") {
  const resetConfig = adminResetConfig();
  const messageHtml = message ? `<div class="flash ${esc(category)} span-2">${esc(message)}</div>` : "";
  res.send(
    layout(
      req,
      "Reset Admin Password",
      `<section class="auth-card"><h1>Reset Admin</h1><p class="muted">Use the temporary reset code from Hostinger to set a new admin password.</p>
      <form method="post" class="grid-form">
        ${messageHtml}
        ${
          resetConfig
            ? ""
            : '<div class="form-error span-2">Reset is not enabled. Set ADMIN_RESET_CODE in Hostinger environment variables, or create tmp/admin-reset-code.txt with a one-time code.</div>'
        }
        <label class="field span-2"><span>Admin login ID</span><input name="mobile" value="${esc(fieldValue(values, "mobile", ""))}"><small>Optional. Leave blank to reset the first active admin.</small></label>
        <label class="field span-2"><span>Reset code</span><input name="reset_code" value="${esc(fieldValue(values, "reset_code", ""))}" required></label>
        <label class="field span-2"><span>New password</span><input name="password" type="password" required></label>
        <label class="field span-2"><span>Confirm password</span><input name="confirm_password" type="password" required></label>
        <div class="action-row"><a class="secondary link-button" href="/login">Back to login</a><button class="primary" ${resetConfig ? "" : "disabled"}>Reset Password</button></div>
      </form></section>`
    )
  );
}

app.get("/reset-admin", async (req, res) => {
  renderAdminReset(req, res);
});

app.post("/reset-admin", async (req, res) => {
  const resetConfig = adminResetConfig();
  const mobile = String(req.body.mobile || "").trim();
  const resetCode = String(req.body.reset_code || "").trim();
  const password = String(req.body.password || "");
  const confirmPassword = String(req.body.confirm_password || "");
  if (!resetConfig) return renderAdminReset(req, res, req.body, "Reset is not enabled on this deployment.");
  const submittedCode = Buffer.from(resetCode);
  const expectedCode = Buffer.from(resetConfig.code);
  if (submittedCode.length !== expectedCode.length || !crypto.timingSafeEqual(submittedCode, expectedCode)) {
    return renderAdminReset(req, res, req.body, "Invalid reset code.");
  }
  if (password.length < 6) return renderAdminReset(req, res, req.body, "Password must be at least 6 characters.");
  if (password !== confirmPassword) return renderAdminReset(req, res, req.body, "Passwords do not match.");
  let admin = mobile ? await one("SELECT * FROM users WHERE mobile=? AND role='admin' AND status='Active'", [mobile]) : null;
  if (!admin) admin = await one("SELECT * FROM users WHERE role='admin' AND status='Active' ORDER BY id LIMIT 1");
  if (!admin && mobile) {
    const created = await run("INSERT INTO users(name, mobile, role, password_hash, status) VALUES(?,?,?,?,?)", [
      "Emergency Admin",
      mobile,
      "admin",
      hashWerkzeug(password),
      "Active",
    ]);
    admin = await one("SELECT * FROM users WHERE id=?", [created.lastInsertRowid]);
  }
  if (!admin) return renderAdminReset(req, res, req.body, "No active admin was found. Enter the login ID you want to create, then submit again.");
  await run("UPDATE users SET password_hash=? WHERE id=?", [hashWerkzeug(password), admin.id]);
  if (resetConfig.source === "file") {
    try {
      fs.unlinkSync(resetConfig.filePath);
    } catch (_err) {}
  }
  flash(req, "success", `Admin password reset for login ID ${admin.mobile}. Login with the new password.`);
  res.redirect("/login");
});

app.get("/admin/mysql-migrate", async (req, res) => {
  if (!USING_MYSQL || !MYSQL_MIGRATION_CODE) return res.status(404).send("Not found");
  res.send(
    `<!doctype html><html><head><meta charset="utf-8"><title>MySQL Migration</title><link rel="stylesheet" href="/static/app.css"></head><body>
    <main class="auth-shell"><section class="auth-card"><h1>Move SQLite Data to MySQL</h1>
    <p class="muted">This copies the old live SQLite database into empty MySQL tables. It will stop if MySQL already has users.</p>
    <form method="post" class="grid-form">
      <label class="field span-2"><span>Migration code</span><input name="migration_code" required></label>
      <label class="field span-2"><span>SQLite path</span><input name="sqlite_path" value="${esc(process.env.PETROL_SQLITE_IMPORT || DATABASE)}"></label>
      <div class="action-row"><button class="primary">Copy Data</button></div>
    </form></section></main></body></html>`
  );
});

app.post("/admin/mysql-migrate", async (req, res) => {
  if (!USING_MYSQL || !MYSQL_MIGRATION_CODE) return res.status(404).send("Not found");
  const submitted = String(req.body.migration_code || "").trim();
  const a = Buffer.from(submitted);
  const b = Buffer.from(MYSQL_MIGRATION_CODE);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(403).send("Invalid migration code.");
  try {
    const sqlitePath = String(req.body.sqlite_path || process.env.PETROL_SQLITE_IMPORT || DATABASE).trim();
    const summary = await migrateSqliteToMysql(sqlitePath);
    res.send(
      `<!doctype html><html><head><meta charset="utf-8"><title>Migration Complete</title><link rel="stylesheet" href="/static/app.css"></head><body>
      <main class="auth-shell"><section class="auth-card"><h1>Migration Complete</h1>
      ${table(summary)}<div class="action-row"><a class="primary link-button" href="/login">Go to login</a></div></section></main></body></html>`
    );
  } catch (err) {
    res.status(400).send(
      `<!doctype html><html><head><meta charset="utf-8"><title>Migration Stopped</title><link rel="stylesheet" href="/static/app.css"></head><body>
      <main class="auth-shell"><section class="auth-card"><h1>Migration Stopped</h1>
      <div class="flash error">${esc(err.message)}</div><div class="action-row"><a class="secondary link-button" href="/admin/mysql-migrate">Back</a></div></section></main></body></html>`
    );
  }
});

app.get("/logout", async (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

app.get("/", requireLogin, async (req, res) => {
  const metrics = await dashboardMetrics();
  if (!metrics.day) {
    return res.send(
      layout(
        req,
        "Dashboard",
        `${pageHead(`Welcome Back, ${req.user.name}`, "Home > Dashboard")}
        <section class="empty-state"><h2>No open business day</h2><p>Start the day with product prices and opening dips before pump entries begin.</p><a class="primary link-button" href="/day/start">Start Day</a></section>`
      )
    );
  }
  const m = metrics;
  const openingRows = await dayOpeningRows(m.day.id);
  const openEntries = await all(
    `SELECT se.business_date, p.name pump, se.product, u.name user_name, se.opening_meter, se.status
     FROM shift_entries se
     JOIN users u ON u.id=se.user_id
     JOIN nozzles n ON n.id=se.nozzle_id
     JOIN pumps p ON p.id=n.pump_id
     WHERE se.day_id=? AND se.status='Open'
     ORDER BY p.name, n.product, n.name`,
    [m.day.id]
  );
  res.send(
    layout(
      req,
      "Dashboard",
      `${pageHead(`Welcome Back, ${req.user.name}`, "Home > Dashboard", '<div style="display:flex;gap:8px;"><a class="primary link-button" href="/shift/start">Start Shift</a><a class="link-button" href="/shifts/active">Active Shifts</a></div>')}
      <section class="stat-grid">
        <div class="stat hero"><span>Today sales</span><strong>${rs(m.totals.sales)}</strong><small>${esc(m.day.business_date)}</small></div>
        <div class="stat"><span>Cash</span><strong>${rs(m.totals.cash)}</strong><small>Opening ${rs(m.day.opening_cash)}</small></div>
        <div class="stat"><span>UPI / Card</span><strong>${rs(Number(m.totals.upi) + Number(m.totals.card))}</strong><small>Digital collections</small></div>
        <div class="stat"><span>Credit pending</span><strong>${rs(m.credit_pending)}</strong><small>${esc(m.open_shifts)} open shifts</small></div>
      </section>
      <section class="dashboard-grid">
        <div class="panel wide"><div class="panel-title"><h2>Analytic View</h2><span class="badge">${esc(m.day.status)}</span></div>
          <div class="mini-grid">
            <article><strong>MS litres</strong><span>${ltr(m.totals.ms_litres)}</span></article>
            <article><strong>MS sales</strong><span>${rs(m.totals.ms_sales)}</span></article>
            <article><strong>HSD litres</strong><span>${ltr(m.totals.hsd_litres)}</span></article>
            <article><strong>HSD sales</strong><span>${rs(m.totals.hsd_sales)}</span></article>
          </div>
        </div>
        <div class="panel"><div class="panel-title"><h2>Stock Available</h2></div>${m.tank_stock.map((r) => `<div class="ledger-line"><span>${esc(r.product)}</span><strong>${ltr(r.stock)}</strong></div>`).join("")}</div>
        <div class="panel"><div class="panel-title"><h2>Pump-wise Sales</h2></div>${m.pump_sales.map((r) => `<div class="ledger-line"><span>${esc(r.pump)}</span><strong>${rs(r.sales)}</strong></div>`).join("") || '<p class="muted">No pump sales yet.</p>'}</div>
        <div class="panel"><div class="panel-title"><h2>Payment Split</h2></div>${m.payment_totals.map((r) => `<div class="ledger-line"><span>${esc(r.payment_type || "Unsorted")}</span><strong>${rs(r.amount)}</strong></div>`).join("") || '<p class="muted">No shift payments logged yet.</p>'}</div>
        <div class="panel"><div class="panel-title"><h2>Top Credit Customers</h2></div>${m.top_customers.map((c) => `<div class="ledger-line"><span>${esc(c.name)}</span><strong>${rs(c.balance)}</strong></div>`).join("") || '<p class="muted">No pending customer credit.</p>'}</div>
        <div class="panel wide"><div class="panel-title"><h2>Day Opening Readings</h2><span class="badge">${esc(m.day.business_date)}</span></div>${table(openingRows)}</div>
        <div class="panel wide"><div class="panel-title"><h2>Open Shift Records</h2><span class="badge">${esc(m.open_shifts)} open</span></div>${table(openEntries)}</div>
        <div class="panel wide"><div class="panel-title"><h2>Boy-wise Sales</h2></div>${table(m.boy_sales)}</div>
      </section>`
    )
  );
});

app.route("/station")
  .get(requireLogin, requireRoles("admin"), async (req, res) => {
    const s = req.station || {};
    const defaultPumpCount = s.pumps_count || (await one("SELECT COUNT(*) c FROM pumps WHERE status='Active'")).c || 2;
    res.send(
      layout(req, "Station", `${pageHead("Station Settings", "Setup > Station")}
      <section class="form-card"><form method="post" class="grid-form">
        ${["station_name", "owner_name", "location", "contact"].map((k) => `<label class="field"><span>${esc(k.replaceAll("_", " "))}</span><input name="${k}" value="${esc(s[k])}"></label>`).join("")}
        <label class="field span-2"><span>Address</span><textarea name="address">${esc(s.address)}</textarea></label>
        <label class="field"><span>Pumps count</span><input name="pumps_count" type="number" value="${esc(defaultPumpCount)}"></label>
        <label class="field"><span>Default testing qty</span><input name="default_testing_qty" type="number" step="0.001" value="${esc(s.default_testing_qty || 5)}"></label>
        <label class="field"><span>Beta enabled</span><select name="beta_enabled">${option("1", "Yes", s.beta_enabled ? "1" : "")}${option("", "No", s.beta_enabled ? "" : "")}</select></label>
        <div class="action-row"><button class="primary">Save Station</button></div>
      </form></section>`)
    );
  })
  .post(requireLogin, requireRoles("admin"), async (req, res) => {
    await run(
      `UPDATE station SET station_name=?, owner_name=?, address=?, location=?, contact=?, pumps_count=?,
       nozzles_per_pump=?, default_testing_qty=?, beta_enabled=? WHERE id=1`,
      [
        req.body.station_name,
        req.body.owner_name,
        req.body.address || "",
        req.body.location || "",
        req.body.contact || "",
        Number(req.body.pumps_count || 0),
        2,
        Number(req.body.default_testing_qty || 5),
        req.body.beta_enabled ? 1 : 0,
      ]
    );
    flash(req, "success", "Station settings updated.");
    res.redirect("/station");
  });

async function masterForm(kind, rows) {
  const tanks = await all("SELECT * FROM tanks WHERE status='Active'");
  const pumps = await all("SELECT * FROM pumps WHERE status='Active'");
  let fields = "";
  if (kind === "tanks") {
    fields = `<label class="field"><span>Tank name</span><input name="name" required></label>
      <label class="field"><span>Product</span><select name="product">${PRODUCTS.map((p) => option(p, p)).join("")}</select></label>
      <label class="field"><span>Capacity litres</span><input name="capacity" type="number" step="0.001" required></label>
      <label class="field"><span>Opening dip litres</span><input name="opening_dip" type="number" step="0.001"></label>
      <label class="field"><span>Current stock litres</span><input name="current_stock" type="number" step="0.001"></label>
      <label class="field"><span>Status</span><select name="status">${option("Active")}${option("Inactive")}</select></label>`;
  } else if (kind === "pumps") {
    fields = `<label class="field"><span>Pump name / number</span><input name="name" required></label><label class="field"><span>Status</span><select name="status">${option("Active")}${option("Inactive")}</select></label>`;
  } else if (kind === "team") {
    fields = `<label class="field"><span>Employee name</span><input name="name" required></label>
      <label class="field"><span>Username / login ID</span><input name="mobile" required></label>
      <label class="field"><span>Role</span><select name="role">${option("manager", "Manager")}${option("pump_boy", "Pump Boy / Team Member")}${option("admin", "Owner / Admin")}</select></label>
      <label class="field"><span>PIN / password</span><input name="password" type="password" required></label>
      <label class="field"><span>Assigned pumps</span><input name="assigned_pumps"></label>
      <label class="field"><span>Status</span><select name="status">${option("Active")}${option("Inactive")}</select></label>`;
  } else if (kind === "shifts") {
    fields = `<label class="field"><span>Shift name</span><input name="name" required></label>
      <label class="field"><span>Status</span><select name="status">${option("Active")}${option("Inactive")}</select></label>
      <label class="field"><span>Start time</span><input name="start_time" type="time" required></label>
      <label class="field"><span>End time</span><input name="end_time" type="time" required></label>
      <label class="field span-2"><span>Description</span><textarea name="description"></textarea></label>`;
  } else if (kind === "customers") {
    fields = `<label class="field"><span>Customer name</span><input name="name" required></label>
      <label class="field"><span>Mobile</span><input name="mobile"></label>
      <label class="field"><span>Vehicle number</span><input name="vehicle_number"></label>
      <label class="field"><span>Company</span><input name="company_name"></label>
      <label class="field"><span>Credit limit</span><input name="credit_limit" type="number" step="0.01"></label>
      <label class="field"><span>Opening balance</span><input name="opening_balance" type="number" step="0.01"></label>
      <label class="field"><span>Status</span><select name="status">${option("Active")}${option("Inactive")}</select></label>
      <label class="field"><span>Address</span><textarea name="address"></textarea></label>`;
  }
  return `<section class="form-card"><div class="form-card-head"><div><h2>Add ${esc(kind)}</h2><p>Fill the required fields and save. Existing records stay visible below.</p></div></div><form method="post" class="grid-form">${fields}<div class="action-row"><button class="primary">Save</button></div></form></section><section class="table-card">${table(rows)}</section>`;
}

app.get("/master/:kind", requireLogin, requireRoles("admin", "manager"), async (req, res) => {
  const kind = req.params.kind;
  if (kind === "nozzles") return res.redirect("/master/pumps");
  const queries = {
    tanks: "SELECT * FROM tanks ORDER BY product, name",
    pumps: "SELECT * FROM pumps ORDER BY name",
    team: "SELECT id, name, mobile, role, status, assigned_pumps FROM users ORDER BY role, name",
    shifts: "SELECT * FROM shift_defs ORDER BY start_time",
    customers: "SELECT * FROM customers ORDER BY name",
  };
  if (!queries[kind]) return res.status(404).send("Not found");
  let rows = await all(queries[kind]);
  if (kind === "team") rows = rows.map((r) => ({ ...r, actions: `<a class="link-button secondary" href="/master/team/${esc(r.id)}/edit">Edit</a>` }));
  res.send(layout(req, `Master ${kind}`, `${pageHead(`Add New ${kind}`, `Setup > ${kind}`)}${await masterForm(kind, rows)}`));
});

app.post("/master/:kind", requireLogin, requireRoles("admin", "manager"), async (req, res) => {
  const b = req.body;
  const kind = req.params.kind;
  if (kind === "nozzles") return res.redirect("/master/pumps");
  if (kind === "tanks") await run("INSERT INTO tanks(name, product, capacity, opening_dip, current_stock, status) VALUES(?,?,?,?,?,?)", [b.name, b.product, Number(b.capacity), Number(b.opening_dip || 0), Number(b.current_stock || 0), b.status || "Active"]);
  else if (kind === "pumps") await run("INSERT INTO pumps(name, status) VALUES(?,?)", [b.name, b.status || "Active"]);
  else if (kind === "team") await run("INSERT INTO users(name, mobile, role, password_hash, status, assigned_pumps) VALUES(?,?,?,?,?,?)", [b.name, b.mobile, b.role, hashWerkzeug(b.password), b.status || "Active", b.assigned_pumps || ""]);
  else if (kind === "shifts") await run("INSERT INTO shift_defs(name, start_time, end_time, description, status) VALUES(?,?,?,?,?)", [b.name, b.start_time, b.end_time, b.description || "", b.status || "Active"]);
  else if (kind === "customers") await run("INSERT INTO customers(name, mobile, vehicle_number, company_name, address, credit_limit, balance, status) VALUES(?,?,?,?,?,?,?,?)", [b.name, b.mobile || "", b.vehicle_number || "", b.company_name || "", b.address || "", Number(b.credit_limit || 0), Number(b.opening_balance || 0), b.status || "Active"]);
  else return res.status(404).send("Not found");
  flash(req, "success", "Record saved.");
  res.redirect(`/master/${kind}`);
});

function renderTeamEdit(req, res, user, values = {}, error = "") {
  const v = { ...user, ...values };
  res.send(layout(req, "Edit Team Member", `${pageHead("Edit Team Member", "Setup > Team")}
    <section class="form-card"><form method="post" class="grid-form">
      ${inlineError(error)}
      <label class="field"><span>Employee name</span><input name="name" value="${esc(fieldValue(v, "name", ""))}" required></label>
      <label class="field"><span>Username / login ID</span><input name="mobile" value="${esc(fieldValue(v, "mobile", ""))}" required></label>
      <label class="field"><span>Role</span><select name="role">${option("manager", "Manager", fieldValue(v, "role", ""))}${option("pump_boy", "Pump Boy / Team Member", fieldValue(v, "role", ""))}${option("admin", "Owner / Admin", fieldValue(v, "role", ""))}</select></label>
      <label class="field"><span>New PIN / password</span><input name="password" type="password"><small>Leave blank to keep current password.</small></label>
      <label class="field"><span>Assigned pumps</span><input name="assigned_pumps" value="${esc(fieldValue(v, "assigned_pumps", ""))}"></label>
      <label class="field"><span>Status</span><select name="status">${option("Active", "Active", fieldValue(v, "status", ""))}${option("Inactive", "Inactive", fieldValue(v, "status", ""))}</select></label>
      <div class="action-row"><a class="secondary link-button" href="/master/team">Cancel</a><button class="primary">Save Changes</button></div>
    </form></section>`));
}

app.get("/master/team/:id/edit", requireLogin, requireRoles("admin", "manager"), async (req, res) => {
  const user = await one("SELECT id, name, mobile, role, status, assigned_pumps FROM users WHERE id=?", [Number(req.params.id)]);
  if (!user) return res.redirect("/master/team");
  renderTeamEdit(req, res, user);
});

app.post("/master/team/:id/edit", requireLogin, requireRoles("admin", "manager"), async (req, res) => {
  const user = await one("SELECT id, name, mobile, role, status, assigned_pumps FROM users WHERE id=?", [Number(req.params.id)]);
  if (!user) return res.redirect("/master/team");
  const b = req.body;
  if (!b.name || !b.mobile) return renderTeamEdit(req, res, user, b, "Name and login ID are required.");
  if (String(b.password || "").trim()) {
    await run("UPDATE users SET name=?, mobile=?, role=?, password_hash=?, status=?, assigned_pumps=? WHERE id=?", [
      b.name,
      b.mobile,
      b.role,
      hashWerkzeug(b.password),
      b.status || "Active",
      b.assigned_pumps || "",
      user.id,
    ]);
  } else {
    await run("UPDATE users SET name=?, mobile=?, role=?, status=?, assigned_pumps=? WHERE id=?", [
      b.name,
      b.mobile,
      b.role,
      b.status || "Active",
      b.assigned_pumps || "",
      user.id,
    ]);
  }
  flash(req, "success", "Team member updated.");
  res.redirect("/master/team");
});

async function dayOpeningRows(dayId) {
  const rows = await all(
    `SELECT d.business_date, p.id pump_id, p.name pump, n.product, dnr.opening_meter
     FROM day_nozzle_readings dnr
     JOIN days d ON d.id=dnr.day_id
     JOIN nozzles n ON n.id=dnr.nozzle_id
     JOIN pumps p ON p.id=n.pump_id
     WHERE d.id=?
     ORDER BY p.name, n.product, n.name`,
    [dayId]
  );
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.pump_id)) grouped.set(row.pump_id, { business_date: row.business_date, pump: row.pump, ms_opening: "", hsd_opening: "" });
    const item = grouped.get(row.pump_id);
    if (row.product === "MS") item.ms_opening = row.opening_meter;
    if (row.product === "HSD") item.hsd_opening = row.opening_meter;
  }
  return Array.from(grouped.values());
}

async function renderDayStart(req, res, values = {}, error = "") {
  await ensureConfiguredPumpProducts();
  const tanks = await all("SELECT * FROM tanks WHERE status='Active' ORDER BY product, name");
  const nozzles = await all(
    `SELECT n.*, p.name pump
     FROM nozzles n JOIN pumps p ON p.id=n.pump_id
     WHERE n.status='Active' AND p.status='Active'
     ORDER BY CASE WHEN p.name GLOB 'Pump [0-9]*' THEN CAST(SUBSTR(p.name, 6) AS INTEGER) ELSE 999999 END, p.name, n.product, n.name`
  );
  const pumps = await all(
    `SELECT DISTINCT p.id, p.name
     FROM pumps p JOIN nozzles n ON n.pump_id=p.id
     WHERE p.status='Active' AND n.status='Active'
     ORDER BY CASE WHEN p.name GLOB 'Pump [0-9]*' THEN CAST(SUBSTR(p.name, 6) AS INTEGER) ELSE 999999 END, p.name`
  );
  for (const nozzle of nozzles) {
    nozzle.suggested_opening = (await lastMeter(nozzle.id)) ?? 0;
  }
  const currentDay = await activeDay();
  const currentRows = currentDay ? await dayOpeningRows(currentDay.id) : [];
  const recentDays = await all("SELECT id, business_date, ms_price, hsd_price, opening_cash, status FROM days ORDER BY business_date DESC LIMIT 10");
  res.send(layout(req, "Day Start", `${pageHead("Start Business Day", "Operations > Day Start")}
    <section class="form-card"><form method="post" class="grid-form">
      ${inlineError(error)}
      <label class="field"><span>Business date / sales date</span><input name="business_date" type="date" value="${esc(fieldValue(values, "business_date", todayIso()))}" required><small>Opening readings are previous closing readings carried into this date.</small></label>
      <label class="field"><span>Opening cash</span><input name="opening_cash" type="number" step="0.01" value="${esc(fieldValue(values, "opening_cash", ""))}"></label>
      <label class="field"><span>MS price</span><input name="ms_price" type="number" step="0.01" value="${esc(fieldValue(values, "ms_price", ""))}" required></label>
      <label class="field"><span>HSD price</span><input name="hsd_price" type="number" step="0.01" value="${esc(fieldValue(values, "hsd_price", ""))}" required></label>
      <div class="form-section"><strong>Pump opening meter readings</strong><small>Previous closing readings for this business date.</small></div>
      ${pumps.map((p) => {
        const pumpMeters = nozzles
          .filter((n) => Number(n.pump_id) === Number(p.id))
          .map((n) => {
            const name = `meter_${n.id}_opening`;
            const suggested = n.suggested_opening;
            return `<label class="field"><span>${esc(n.product)}</span><input name="${name}" type="number" step="0.001" value="${esc(fieldValue(values, name, suggested))}" required></label>`;
          })
          .join("");
        return `<div class="form-section"><strong>${esc(p.name)}</strong><small>Opening meter readings</small></div>${pumpMeters}`;
      }).join("") || '<div class="form-error span-2">Add active pumps before starting the day.</div>'}
      <div class="form-section"><strong>Pump testing values</strong><small>Enter testing quantity for each configured pump.</small></div>
      ${pumps.map((p) => `
        <label class="field"><span>${esc(p.name)} MS testing qty</span><input name="testing_${p.id}_MS" type="number" step="0.001" value="${esc(fieldValue(values, `testing_${p.id}_MS`, 0))}"></label>
        <label class="field"><span>${esc(p.name)} HSD testing qty</span><input name="testing_${p.id}_HSD" type="number" step="0.001" value="${esc(fieldValue(values, `testing_${p.id}_HSD`, 0))}"></label>
      `).join("")}
      <label class="field span-2"><span>Notes</span><textarea name="notes">${esc(fieldValue(values, "notes", ""))}</textarea></label>
      <div class="action-row"><button class="primary" ${nozzles.length ? "" : "disabled"}>Start Day</button></div>
    </form></section>
    ${currentDay ? `<section class="table-card"><div class="table-card-head"><div><h2>Open Day Readings</h2><p>${esc(currentDay.business_date)} is open. These are the pump readings captured at start.</p></div><span class="badge">${esc(currentDay.status)}</span></div>${table(currentRows)}</section>` : ""}
    <section class="table-card"><div class="table-card-head"><div><h2>Recent Day Records</h2><p>Started days stay visible here with date, rates, cash and status.</p></div></div>${table(recentDays)}</section>`));
}

app.route("/day/start")
  .get(requireLogin, requireRoles("admin", "manager"), async (req, res) => {
    await renderDayStart(req, res);
  })
  .post(requireLogin, requireRoles("admin", "manager"), async (req, res) => {
    const b = req.body;
    if (await one("SELECT id FROM days WHERE business_date=?", [b.business_date])) {
      return await renderDayStart(req, res, b, "A day is already started for this date.");
    }
    const nozzles = await all(
      `SELECT n.*, p.name pump
       FROM nozzles n JOIN pumps p ON p.id=n.pump_id
       WHERE n.status='Active' AND p.status='Active'
       ORDER BY CASE WHEN p.name GLOB 'Pump [0-9]*' THEN CAST(SUBSTR(p.name, 6) AS INTEGER) ELSE 999999 END, p.name, n.product, n.name`
    );
    if (!nozzles.length) return await renderDayStart(req, res, b, "Add active pumps before starting the day.");
    for (const nozzle of nozzles) {
      const value = b[`meter_${nozzle.id}_opening`] ?? b[`nozzle_${nozzle.id}_opening`];
      if (value === "" || value == null || Number.isNaN(Number(value))) {
        return await renderDayStart(req, res, b, `Enter opening meter for ${nozzle.pump} ${nozzle.product}.`);
      }
    }
    const pumps = await all(
      `SELECT DISTINCT p.id, p.name
       FROM pumps p JOIN nozzles n ON n.pump_id=p.id
       WHERE p.status='Active' AND n.status='Active'
       ORDER BY CASE WHEN p.name GLOB 'Pump [0-9]*' THEN CAST(SUBSTR(p.name, 6) AS INTEGER) ELSE 999999 END, p.name`
    );
    const pumpTesting = pumps.map((p) => ({
      pump_id: p.id,
      ms_qty: litres(b[`testing_${p.id}_MS`] || 0),
      hsd_qty: litres(b[`testing_${p.id}_HSD`] || 0),
    }));
    const totalTestingMs = pumpTesting.reduce((a, p) => a + p.ms_qty, 0);
    const totalTestingHsd = pumpTesting.reduce((a, p) => a + p.hsd_qty, 0);
    const testingDone = totalTestingMs > 0 || totalTestingHsd > 0 ? 1 : 0;
    const openingMs = (await all("SELECT current_stock FROM tanks WHERE product='MS' AND status='Active'")).reduce((a, t) => a + Number(t.current_stock || 0), 0);
    const openingHsd = (await all("SELECT current_stock FROM tanks WHERE product='HSD' AND status='Active'")).reduce((a, t) => a + Number(t.current_stock || 0), 0);
    const result = await run(
      `INSERT INTO days(business_date, ms_price, hsd_price, opening_ms, opening_hsd, testing_done, testing_ms_qty, testing_hsd_qty, opening_cash, notes)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      [b.business_date, Number(b.ms_price), Number(b.hsd_price), openingMs, openingHsd, testingDone, totalTestingMs, totalTestingHsd, Number(b.opening_cash || 0), b.notes || ""]
    );
    for (const tank of await all("SELECT * FROM tanks WHERE status='Active'")) {
      const opening = Number(tank.current_stock || 0);
      await run("INSERT INTO tank_readings(day_id, tank_id, opening_dip) VALUES(?,?,?)", [result.lastInsertRowid, tank.id, opening]);
      await run("UPDATE tanks SET opening_dip=? WHERE id=?", [opening, tank.id]);
    }
    for (const nozzle of nozzles) {
      await run("INSERT INTO day_nozzle_readings(day_id, nozzle_id, opening_meter) VALUES(?,?,?)", [result.lastInsertRowid, nozzle.id, Number(b[`meter_${nozzle.id}_opening`] ?? b[`nozzle_${nozzle.id}_opening`])]);
    }
    for (const p of pumpTesting) {
      if (p.ms_qty || p.hsd_qty) await run("INSERT INTO day_pump_testing(day_id, pump_id, ms_qty, hsd_qty) VALUES(?,?,?,?)", [result.lastInsertRowid, p.pump_id, p.ms_qty, p.hsd_qty]);
    }
    if (testingDone && totalTestingMs > 0) await decrementLargestTank("MS", totalTestingMs);
    if (testingDone && totalTestingHsd > 0) await decrementLargestTank("HSD", totalTestingHsd);
    flash(req, "success", "Day started. Shift entries are now available.");
    res.redirect("/day/start");
  });

async function renderShiftStart(req, res, values = {}, error = "") {
  await ensureConfiguredPumpProducts();
  const day = await activeDay();
  if (!day) {
    flash(req, "error", "Start a business day before opening shifts.");
    return res.redirect("/day/start");
  }
  const pumps = await all("SELECT * FROM pumps WHERE status='Active' ORDER BY CASE WHEN name GLOB 'Pump [0-9]*' THEN CAST(SUBSTR(name, 6) AS INTEGER) ELSE 999999 END, name");
  const users = await all("SELECT * FROM users WHERE status='Active' AND role IN ('manager','pump_boy') ORDER BY name");
  const shifts = await all("SELECT * FROM shift_defs WHERE status='Active' ORDER BY start_time");
  const activePumpRows = await all(
    `SELECT DISTINCT p.id
     FROM shift_entries se JOIN nozzles n ON n.id=se.nozzle_id JOIN pumps p ON p.id=n.pump_id
     WHERE se.status='Open'`
  );
  const activePumpIds = new Set(activePumpRows.map((r) => Number(r.id)));
  const activeUserIds = new Set((await all("SELECT DISTINCT user_id id FROM shift_entries WHERE status='Open'")).map((r) => Number(r.id)));
  const firstAvailablePump = pumps.find((p) => !activePumpIds.has(Number(p.id))) || pumps[0];
  const firstAvailableUser = users.find((u) => !activeUserIds.has(Number(u.id))) || users[0];
  const hasAvailablePump = pumps.some((p) => !activePumpIds.has(Number(p.id)));
  const hasAvailableUser = users.some((u) => !activeUserIds.has(Number(u.id)));
  const selectedPumpId = Number(fieldValue(values, "pump_id", req.query.pump_id || firstAvailablePump?.id || ""));
  const selectedUserId = Number(fieldValue(values, "user_id", firstAvailableUser?.id || req.user.id || ""));
  const nozzles = await all(
    `SELECT n.*, p.name pump
     FROM nozzles n JOIN pumps p ON p.id=n.pump_id
     WHERE n.status='Active' AND p.status='Active' AND p.id=?
     ORDER BY n.product, n.name`,
    [selectedPumpId]
  );
  for (const nozzle of nozzles) {
    nozzle.suggested_opening = (await dayOpeningMeter(day.id, nozzle.id)) ?? (await lastMeter(nozzle.id)) ?? 0;
  }
  const openEntries = (await activePumpGroups(req)).filter((r) => r.business_date === day.business_date);
  res.send(layout(req, "Start Shift", `${pageHead("Start Shift", "Operations > Start Shift")}
    <section class="form-card"><form method="post" class="grid-form">
      ${inlineError(error)}
      <label class="field"><span>Pump</span><select name="pump_id" onchange="if(!this.selectedOptions[0].disabled) window.location='/shift/start?pump_id='+this.value">${pumps.map((p) => optionDisabled(p.id, activePumpIds.has(Number(p.id)) ? `${p.name} - active` : p.name, selectedPumpId, activePumpIds.has(Number(p.id)))).join("")}</select></label>
      <label class="field"><span>Team member</span><select name="user_id">${users.map((u) => optionDisabled(u.id, activeUserIds.has(Number(u.id)) ? `${u.name} - assigned` : u.name, selectedUserId, activeUserIds.has(Number(u.id)))).join("")}</select></label>
      <label class="field"><span>Time in</span><input name="time_in" type="time" value="${esc(fieldValue(values, "time_in", new Date().toTimeString().slice(0, 5)))}"></label>
      <label class="field"><span>Detected shift</span><select name="shift_def_id"><option value="">Auto by time</option>${shifts.map((s) => option(s.id, `${s.name} (${s.start_time}-${s.end_time})`, fieldValue(values, "shift_def_id", ""))).join("")}</select></label>
      <div class="form-section"><strong>Opening meters</strong><small>Defaults come from the day-start pump readings</small></div>
      <div class="form-section"><strong>${esc(pumps.find((p) => Number(p.id) === selectedPumpId)?.name || "Pump")}</strong><small>MS and HSD readings</small></div>
      ${nozzles.map((n) => {
        const name = `opening_meter_${n.id}`;
        const suggested = n.suggested_opening;
        return `<label class="field"><span>${esc(n.product)}</span><input name="${name}" type="number" step="0.001" value="${esc(fieldValue(values, name, suggested))}"></label>`;
      }).join("") || '<div class="form-error span-2">Selected pump is not configured for MS/HSD.</div>'}
      <div class="action-row"><button class="primary" ${pumps.length && users.length && shifts.length && nozzles.length && hasAvailablePump && hasAvailableUser ? "" : "disabled"}>Start Shift</button></div>
    </form></section>
    <section class="table-card"><div class="table-card-head"><div><h2>Open Shift Records</h2><p>${esc(day.business_date)} active shift records.</p></div></div>${table(openEntries)}</section>`));
}

app.route("/shift/start")
  .get(requireLogin, async (req, res) => {
    await renderShiftStart(req, res);
  })
  .post(requireLogin, async (req, res) => {
    const day = await activeDay();
    if (!day) return res.redirect("/day/start");
    const pumpId = Number(req.body.pump_id);
    const userId = req.user.role === "pump_boy" ? req.user.id : Number(req.body.user_id || req.user.id);
    const shift = req.body.shift_def_id ? await one("SELECT * FROM shift_defs WHERE id=? AND status='Active'", [Number(req.body.shift_def_id)]) : await detectShift(req.body.time_in);
    if (!pumpId || !await one("SELECT id FROM pumps WHERE id=? AND status='Active'", [pumpId])) {
      return await renderShiftStart(req, res, req.body, "Select an active pump.");
    }
    if (!userId || !await one("SELECT id FROM users WHERE id=? AND status='Active'", [userId])) {
      return await renderShiftStart(req, res, req.body, "Select an active team member.");
    }
    if (!shift) {
      return await renderShiftStart(req, res, req.body, "Add at least one active shift definition before starting a shift.");
    }
    const openPump = await one(
      `SELECT p.name pump, u.name user_name
       FROM shift_entries se
       JOIN nozzles n ON n.id=se.nozzle_id
       JOIN pumps p ON p.id=n.pump_id
       JOIN users u ON u.id=se.user_id
       WHERE p.id=? AND se.status='Open'
       LIMIT 1`,
      [pumpId]
    );
    if (openPump) return await renderShiftStart(req, res, req.body, `${openPump.pump} is already active with ${openPump.user_name}. Edit the active pump instead of starting it again.`);
    const openUser = await one(
      `SELECT u.name user_name, p.name pump
       FROM shift_entries se
       JOIN users u ON u.id=se.user_id
       JOIN nozzles n ON n.id=se.nozzle_id
       JOIN pumps p ON p.id=n.pump_id
       WHERE u.id=? AND se.status='Open'
       LIMIT 1`,
      [userId]
    );
    if (openUser) return await renderShiftStart(req, res, req.body, `${openUser.user_name} is already assigned to ${openUser.pump}. Close or edit that active pump first.`);
    const nozzles = await all("SELECT * FROM nozzles WHERE pump_id=? AND status='Active' ORDER BY product, name", [pumpId]);
    if (!nozzles.length) {
      return await renderShiftStart(req, res, req.body, "Selected pump is not configured for MS/HSD.");
    }
    let created = 0;
    for (const nozzle of nozzles) {
      let opening = req.body[`opening_meter_${nozzle.id}`];
      if (opening === "" || opening == null) opening = await dayOpeningMeter(day.id, nozzle.id);
      if (opening === "" || opening == null) opening = await lastMeter(nozzle.id);
      if (opening == null) {
        return await renderShiftStart(req, res, req.body, `Enter opening meter for ${nozzle.product}.`);
      }
      if (await one("SELECT id FROM shift_entries WHERE nozzle_id=? AND status='Open'", [nozzle.id])) continue;
      await run(
        `INSERT INTO shift_entries(day_id, business_date, shift_def_id, user_id, nozzle_id, tank_id, product, opening_meter, rate)
         VALUES(?,?,?,?,?,?,?,?,?)`,
        [day.id, day.business_date, shift.id, userId, nozzle.id, nozzle.tank_id, nozzle.product, Number(opening), productPrice(day, nozzle.product)]
      );
      created += 1;
    }
    if (!created) return await renderShiftStart(req, res, req.body, "No shift created. The selected pump may already be active.");
    flash(req, "success", `Shift started for selected pump.`);
    res.redirect("/shifts/active");
  });

app.get("/shifts/active", requireLogin, async (req, res) => {
  let entries = await activePumpGroups(req);
  entries = entries.map((r) => ({
    ...r,
    actions: `<a class="link-button secondary" href="/shift/pump/${esc(r.pump_id)}/payment">Payments</a> <a class="link-button secondary" href="/shift/pump/${esc(r.pump_id)}/edit">Edit</a>`,
  }));
  res.send(layout(req, "Active Shifts", `${pageHead("Active Shifts", "Operations > Active Shifts", '<a class="primary link-button" href="/shift/close">Close Shift</a>')}${table(entries)}`));
});

async function renderPumpPayments(req, res, pump, entries, values = {}, error = "") {
  const customers = await all("SELECT * FROM customers WHERE status='Active' ORDER BY name");
  const paymentRows = await getPumpPaymentRows(pump.id, req);
  const totals = await getPumpPaymentTotals(pump.id, req);
  res.send(layout(req, "Shift Payments", `${pageHead(`${pump.name} Payments`, "Operations > Active Pump")}
    <section class="form-card"><form method="post" class="grid-form">
      ${inlineError(error)}
      <label class="field"><span>Product</span><select name="product">${entries.map((e) => option(e.product, e.product, fieldValue(values, "product", ""))).join("")}</select></label>
      <label class="field"><span>Payment type</span><select name="payment_type">${PAYMENT_TYPES.map((p) => option(p, p, fieldValue(values, "payment_type", ""))).join("")}</select></label>
      <label class="field"><span>Amount</span><input name="amount" type="number" step="0.01" value="${esc(fieldValue(values, "amount", ""))}" required></label>
      <label class="field"><span>Time</span><input name="recorded_at" type="time" value="${esc(fieldValue(values, "recorded_at", new Date().toTimeString().slice(0, 5)))}"></label>
      <label class="field"><span>Credit customer</span><select name="customer_id"><option value="">None</option>${customers.map((c) => option(c.id, c.name, fieldValue(values, "customer_id", ""))).join("")}</select><small>Needed only for Credit.</small></label>
      <label class="field"><span>Note</span><input name="note" value="${esc(fieldValue(values, "note", ""))}"></label>
      <div class="action-row"><a class="secondary link-button" href="/shifts/active">Back</a><button class="primary">Add Payment</button></div>
    </form></section>
    <section class="stat-grid">
      <div class="stat"><span>Cash</span><strong>${rs(totals.cash)}</strong></div>
      <div class="stat"><span>Phone Pay</span><strong>${rs(totals.phone_pay)}</strong></div>
      <div class="stat"><span>Card</span><strong>${rs(totals.card)}</strong></div>
      <div class="stat"><span>Credit</span><strong>${rs(totals.credit)}</strong></div>
      <div class="stat"><span>Personal / Others</span><strong>${rs(Number(totals.personal) + Number(totals.others))}</strong></div>
      <div class="stat hero"><span>Total logged</span><strong>${rs(totals.total)}</strong></div>
    </section>
    <section class="table-card"><div class="table-card-head"><div><h2>Payment Log</h2><p>Each payment is timestamped and linked to MS or HSD for this active pump.</p></div></div>${table(paymentRows)}</section>`));
}

app.get("/shift/pump/:pumpId/payment", requireLogin, async (req, res) => {
  const pump = await one("SELECT * FROM pumps WHERE id=?", [Number(req.params.pumpId)]);
  if (!pump) return res.redirect("/shifts/active");
  const where = req.user.role === "pump_boy" ? "AND se.user_id=?" : "";
  const params = req.user.role === "pump_boy" ? [pump.id, req.user.id] : [pump.id];
  const entries = await all(
    `SELECT se.id, se.product, se.business_date
     FROM shift_entries se JOIN nozzles n ON n.id=se.nozzle_id
     WHERE n.pump_id=? AND se.status='Open' ${where}
     ORDER BY se.product`,
    params
  );
  if (!entries.length) return res.redirect("/shifts/active");
  await renderPumpPayments(req, res, pump, entries);
});

app.post("/shift/pump/:pumpId/payment", requireLogin, async (req, res) => {
  const pump = await one("SELECT * FROM pumps WHERE id=?", [Number(req.params.pumpId)]);
  if (!pump) return res.redirect("/shifts/active");
  const where = req.user.role === "pump_boy" ? "AND se.user_id=?" : "";
  const params = req.user.role === "pump_boy" ? [pump.id, req.user.id] : [pump.id];
  const entries = await all(
    `SELECT se.id, se.product, se.business_date
     FROM shift_entries se JOIN nozzles n ON n.id=se.nozzle_id
     WHERE n.pump_id=? AND se.status='Open' ${where}
     ORDER BY se.product`,
    params
  );
  if (!entries.length) return res.redirect("/shifts/active");
  const product = String(req.body.product || "").trim();
  const paymentType = String(req.body.payment_type || "").trim();
  const amount = money(req.body.amount);
  const entry = entries.find((e) => e.product === product);
  if (!entry) return await renderPumpPayments(req, res, pump, entries, req.body, "Select MS or HSD for this payment.");
  if (!PAYMENT_TYPES.includes(paymentType)) return await renderPumpPayments(req, res, pump, entries, req.body, "Select a valid payment type.");
  if (!amount || amount <= 0) return await renderPumpPayments(req, res, pump, entries, req.body, "Enter payment amount.");
  if (paymentType === "Credit" && !req.body.customer_id) return await renderPumpPayments(req, res, pump, entries, req.body, "Select credit customer for Credit payment.");
  const column = paymentColumn(paymentType);
  const values = { cash: 0, upi: 0, card: 0, credit: 0 };
  if (column) values[column] = amount;
  const businessDate = entry.business_date || todayIso();
  const recordedAt = req.body.recorded_at ? `${businessDate} ${req.body.recorded_at}:00` : undefined;
  await run(
    `INSERT INTO shift_payments(shift_entry_id, product, payment_type, amount, cash, upi, card, credit, customer_id, note${recordedAt ? ", recorded_at" : ""})
     VALUES(?,?,?,?,?,?,?,?,?,?${recordedAt ? ", ?" : ""})`,
    [
      entry.id,
      product,
      paymentType,
      amount,
      values.cash,
      values.upi,
      values.card,
      values.credit,
      req.body.customer_id || null,
      req.body.note || "",
      ...(recordedAt ? [recordedAt] : []),
    ]
  );
  if (paymentType === "Credit") {
    await run("UPDATE customers SET balance=balance+? WHERE id=?", [amount, Number(req.body.customer_id)]);
    await run(
      "INSERT INTO credit_ledger(customer_id, business_date, entry_type, product, amount, pump_nozzle, shift_entry_id, notes) VALUES(?,?,?,?,?,?,?,?)",
      [Number(req.body.customer_id), businessDate, "credit", product, amount, pump.name, entry.id, req.body.note || "Shift credit logged"]
    );
  }
  flash(req, "success", `${paymentType} payment added for ${product}.`);
  res.redirect(`/shift/pump/${pump.id}/payment`);
});

async function renderPumpShiftEdit(req, res, pump, entries, values = {}, error = "") {
  const users = await all("SELECT * FROM users WHERE status='Active' AND role IN ('manager','pump_boy') ORDER BY name");
  const selectedUser = fieldValue(values, "user_id", entries[0]?.user_id || "");
  res.send(layout(req, "Edit Active Pump", `${pageHead(`Edit ${pump.name}`, "Operations > Active Pump")}
    <section class="form-card"><form method="post" class="grid-form">
      ${inlineError(error)}
      <label class="field span-2"><span>Team member</span><select name="user_id">${users.map((u) => option(u.id, u.name, selectedUser)).join("")}</select></label>
      ${entries.map((e) => `<label class="field"><span>${esc(pump.name)} ${esc(e.product)} opening meter</span><input name="opening_meter_${e.id}" type="number" step="0.001" value="${esc(fieldValue(values, `opening_meter_${e.id}`, e.opening_meter))}"></label>`).join("")}
      <div class="action-row"><a class="secondary link-button" href="/shifts/active">Cancel</a><button class="primary">Save Changes</button></div>
    </form></section>`));
}

app.get("/shift/pump/:pumpId/edit", requireLogin, async (req, res) => {
  const pump = await one("SELECT * FROM pumps WHERE id=?", [Number(req.params.pumpId)]);
  if (!pump) return res.redirect("/shifts/active");
  const where = req.user.role === "pump_boy" ? "AND se.user_id=?" : "";
  const params = req.user.role === "pump_boy" ? [pump.id, req.user.id] : [pump.id];
  const entries = await all(
    `SELECT se.id, se.user_id, se.product, se.opening_meter
     FROM shift_entries se JOIN nozzles n ON n.id=se.nozzle_id
     WHERE n.pump_id=? AND se.status='Open' ${where}
     ORDER BY se.product`,
    params
  );
  if (!entries.length) return res.redirect("/shifts/active");
  await renderPumpShiftEdit(req, res, pump, entries);
});

app.post("/shift/pump/:pumpId/edit", requireLogin, async (req, res) => {
  const pump = await one("SELECT * FROM pumps WHERE id=?", [Number(req.params.pumpId)]);
  if (!pump) return res.redirect("/shifts/active");
  const entries = await all(
    `SELECT se.id, se.user_id, se.product, se.opening_meter
     FROM shift_entries se JOIN nozzles n ON n.id=se.nozzle_id
     WHERE n.pump_id=? AND se.status='Open'
     ORDER BY se.product`,
    [pump.id]
  );
  if (!entries.length) return res.redirect("/shifts/active");
  if (req.user.role === "pump_boy") return res.status(403).send("Forbidden");
  const userId = Number(req.body.user_id);
  const user = await one("SELECT id, name FROM users WHERE id=? AND status='Active'", [userId]);
  if (!user) return await renderPumpShiftEdit(req, res, pump, entries, req.body, "Select an active team member.");
  const openUser = await one(
    `SELECT p.name pump
     FROM shift_entries se JOIN nozzles n ON n.id=se.nozzle_id JOIN pumps p ON p.id=n.pump_id
     WHERE se.user_id=? AND se.status='Open' AND p.id<>?
     LIMIT 1`,
    [userId, pump.id]
  );
  if (openUser) return await renderPumpShiftEdit(req, res, pump, entries, req.body, `${user.name} is already assigned to ${openUser.pump}.`);
  for (const e of entries) {
    const opening = Number(req.body[`opening_meter_${e.id}`]);
    if (Number.isNaN(opening)) return await renderPumpShiftEdit(req, res, pump, entries, req.body, `Enter opening meter for ${e.product}.`);
    await run("UPDATE shift_entries SET user_id=?, opening_meter=? WHERE id=? AND status='Open'", [userId, opening, e.id]);
  }
  flash(req, "success", `${pump.name} active shift updated.`);
  res.redirect("/shifts/active");
});

async function renderShiftClose(req, res, values = {}, error = "") {
  const openPumps = await activePumpGroups(req);
  const customers = await all("SELECT * FROM customers WHERE status='Active' ORDER BY name");
  const selectedPumpId = Number(fieldValue(values, "pump_id", req.query.pump_id || openPumps[0]?.pump_id || ""));
  const selectedPump = openPumps.find((p) => Number(p.pump_id) === selectedPumpId);
  const loggedTotals = selectedPump ? await getPumpPaymentTotals(selectedPumpId, req) : { cash: 0, phone_pay: 0, card: 0, credit: 0, personal: 0, others: 0, total: 0 };
  res.send(layout(req, "Close Shift", `${pageHead("Close Shift", "Operations > Close Shift")}
    <section class="stat-grid">
      <div class="stat"><span>Logged cash</span><strong>${rs(loggedTotals.cash)}</strong></div>
      <div class="stat"><span>Logged phone pay</span><strong>${rs(loggedTotals.phone_pay)}</strong></div>
      <div class="stat"><span>Logged card</span><strong>${rs(loggedTotals.card)}</strong></div>
      <div class="stat"><span>Logged credit</span><strong>${rs(loggedTotals.credit)}</strong></div>
      <div class="stat"><span>Personal / Others</span><strong>${rs(Number(loggedTotals.personal) + Number(loggedTotals.others))}</strong></div>
      <div class="stat hero"><span>Total logged</span><strong>${rs(loggedTotals.total)}</strong></div>
    </section>
    <section class="form-card"><form method="post" class="grid-form">
      ${inlineError(error)}
      <label class="field span-2"><span>Active pump</span><select name="pump_id" onchange="window.location='/shift/close?pump_id='+this.value">${openPumps.map((p) => option(p.pump_id, `${p.business_date} - ${p.pump} - ${p.user_name}`, selectedPumpId)).join("")}</select></label>
      <div class="form-section"><strong>${esc(selectedPump?.pump || "Pump")} closing meters</strong><small>Close MS and HSD together for this pump.</small></div>
      <label class="field"><span>MS closing meter</span><input name="closing_MS" type="number" step="0.001" value="${esc(fieldValue(values, "closing_MS", selectedPump?.ms_closing || ""))}" required></label>
      <label class="field"><span>HSD closing meter</span><input name="closing_HSD" type="number" step="0.001" value="${esc(fieldValue(values, "closing_HSD", selectedPump?.hsd_closing || ""))}" required></label>
      <label class="field"><span>MS testing qty</span><input name="testing_MS" type="number" step="0.001" value="${esc(fieldValue(values, "testing_MS", 0))}"></label>
      <label class="field"><span>HSD testing qty</span><input name="testing_HSD" type="number" step="0.001" value="${esc(fieldValue(values, "testing_HSD", 0))}"></label>
      <div class="form-section"><strong>Additional collections</strong><small>Use only for last-minute payments not logged during the shift.</small></div>
      <label class="field"><span>Extra cash</span><input name="cash" type="number" step="0.01" value="${esc(fieldValue(values, "cash", 0))}"></label>
      <label class="field"><span>Extra phone pay</span><input name="upi" type="number" step="0.01" value="${esc(fieldValue(values, "upi", 0))}"></label>
      <label class="field"><span>Extra card</span><input name="card" type="number" step="0.01" value="${esc(fieldValue(values, "card", 0))}"></label>
      <label class="field"><span>Extra credit</span><input name="credit" type="number" step="0.01" value="${esc(fieldValue(values, "credit", 0))}"></label>
      <label class="field"><span>Credit customer</span><select name="customer_id"><option value="">None</option>${customers.map((c) => option(c.id, c.name, fieldValue(values, "customer_id", ""))).join("")}</select></label>
      <label class="field"><span>Expenses</span><input name="expenses" type="number" step="0.01" value="${esc(fieldValue(values, "expenses", 0))}"></label>
      <label class="field"><span>Expense category</span><select name="expense_category">${DEFAULT_EXPENSE_CATEGORIES.map((c) => option(c, c, fieldValue(values, "expense_category", "Miscellaneous"))).join("")}</select></label>
      <label class="field"><span>Beta</span><input name="beta" type="number" step="0.01" value="${esc(fieldValue(values, "beta", 0))}"></label>
      <label class="field"><span>Miscellaneous</span><input name="miscellaneous" type="number" step="0.01" value="${esc(fieldValue(values, "miscellaneous", 0))}"></label>
      <label class="field span-2"><span>Remarks</span><textarea name="remarks">${esc(fieldValue(values, "remarks", ""))}</textarea></label>
      <div class="action-row"><button class="primary" ${openPumps.length ? "" : "disabled"}>Close Pump</button></div>
    </form></section><section class="table-card">${table(openPumps)}</section>`));
}

app.route("/shift/close")
  .get(requireLogin, async (req, res) => {
    await renderShiftClose(req, res);
  })
  .post(requireLogin, async (req, res) => {
    const pumpId = Number(req.body.pump_id);
    const where = req.user.role === "pump_boy" ? "AND se.user_id=?" : "";
    const params = req.user.role === "pump_boy" ? [pumpId, req.user.id] : [pumpId];
    const entries = await all(
      `SELECT se.*, p.name pump, u.name user_name
       FROM shift_entries se
       JOIN users u ON u.id=se.user_id
       JOIN nozzles n ON n.id=se.nozzle_id
       JOIN pumps p ON p.id=n.pump_id
       WHERE p.id=? AND se.status='Open' ${where}
       ORDER BY se.product`,
      params
    );
    if (!entries.length) return await renderShiftClose(req, res, req.body, "Active pump not found.");
    const calculated = [];
    for (const entry of entries) {
      const closing = Number(req.body[`closing_${entry.product}`]);
      if (Number.isNaN(closing)) return await renderShiftClose(req, res, req.body, `Enter ${entry.product} closing meter.`);
      if (closing < Number(entry.opening_meter)) return await renderShiftClose(req, res, req.body, `${entry.product} closing cannot be less than opening.`);
      const testingQty = litres(req.body[`testing_${entry.product}`] || 0);
      const sold = Math.max(0, litres(closing - Number(entry.opening_meter) - testingQty));
      const amount = money(sold * Number(entry.rate));
      calculated.push({ entry, closing, testingQty, sold, amount });
    }
    const currentPayments = { cash: 0, upi: 0, card: 0, credit: 0, personal: 0, others: 0 };
    for (const item of calculated) {
      const p = await getShiftPaymentsTotal(item.entry.id);
      currentPayments.cash += Number(p.cash || 0);
      currentPayments.upi += Number(p.upi || 0);
      currentPayments.card += Number(p.card || 0);
      currentPayments.credit += Number(p.credit || 0);
      currentPayments.personal += Number(p.personal || 0);
      currentPayments.others += Number(p.others || 0);
    }
    const totalAmount = money(calculated.reduce((a, item) => a + item.amount, 0));
    const cash = money(currentPayments.cash + money(req.body.cash));
    const upi = money(currentPayments.upi + money(req.body.upi));
    const card = money(currentPayments.card + money(req.body.card));
    const extraCredit = money(req.body.credit);
    const credit = money(currentPayments.credit + extraCredit);
    const expenses = money(req.body.expenses);
    const beta = money(req.body.beta);
    const misc = money(Number(req.body.miscellaneous || 0) + currentPayments.personal + currentPayments.others);
    const shortage = money(cash + upi + card + credit + expenses + beta + misc - totalAmount);
    const customerId = req.body.customer_id || null;
    if (extraCredit > 0 && !customerId) {
      return await renderShiftClose(req, res, req.body, "Select a credit customer for extra credit sale.");
    }
    const share = (value, amount) => (totalAmount > 0 ? money(value * (amount / totalAmount)) : 0);
    for (let i = 0; i < calculated.length; i += 1) {
      const item = calculated[i];
      const isLast = i === calculated.length - 1;
      const allocatedCash = isLast ? money(cash - calculated.slice(0, i).reduce((a, x) => a + share(cash, x.amount), 0)) : share(cash, item.amount);
      const allocatedUpi = isLast ? money(upi - calculated.slice(0, i).reduce((a, x) => a + share(upi, x.amount), 0)) : share(upi, item.amount);
      const allocatedCard = isLast ? money(card - calculated.slice(0, i).reduce((a, x) => a + share(card, x.amount), 0)) : share(card, item.amount);
      const allocatedCredit = isLast ? money(credit - calculated.slice(0, i).reduce((a, x) => a + share(credit, x.amount), 0)) : share(credit, item.amount);
      const allocatedExpenses = isLast ? money(expenses - calculated.slice(0, i).reduce((a, x) => a + share(expenses, x.amount), 0)) : share(expenses, item.amount);
      const allocatedBeta = isLast ? money(beta - calculated.slice(0, i).reduce((a, x) => a + share(beta, x.amount), 0)) : share(beta, item.amount);
      const allocatedMisc = isLast ? money(misc - calculated.slice(0, i).reduce((a, x) => a + share(misc, x.amount), 0)) : share(misc, item.amount);
      const allocatedShortage = isLast ? money(shortage - calculated.slice(0, i).reduce((a, x) => a + share(shortage, x.amount), 0)) : share(shortage, item.amount);
      await run(
        `UPDATE shift_entries SET closing_meter=?, litres_sold=?, sales_amount=?, cash=?, upi=?, card=?, credit=?,
         customer_id=?, expenses=?, beta=?, miscellaneous=?, remarks=?, shortage_excess=?, testing_qty=?, status='Closed',
         closed_at=CURRENT_TIMESTAMP WHERE id=?`,
        [
          item.closing,
          item.sold,
          item.amount,
          allocatedCash,
          allocatedUpi,
          allocatedCard,
          allocatedCredit,
          customerId,
          allocatedExpenses,
          allocatedBeta,
          allocatedMisc,
          req.body.remarks || "",
          allocatedShortage,
          item.testingQty,
          item.entry.id,
        ]
      );
      await run("UPDATE tanks SET current_stock=current_stock-? WHERE id=?", [item.sold, item.entry.tank_id]);
    }
    if (expenses) await run("INSERT INTO expenses(business_date, shift_entry_id, paid_by, category, amount, note, payment_mode) VALUES(?,?,?,?,?,?,?)", [entries[0].business_date, entries[0].id, entries[0].user_id, req.body.expense_category || "Miscellaneous", expenses, req.body.expense_note || "", "Cash"]);
    if (customerId && extraCredit > 0) {
      await run("UPDATE customers SET balance=balance+? WHERE id=?", [extraCredit, customerId]);
      for (const item of calculated) {
        const allocatedCredit = share(extraCredit, item.amount);
        if (allocatedCredit > 0) await run("INSERT INTO credit_ledger(customer_id, business_date, entry_type, product, litres, amount, pump_nozzle, team_member, shift_entry_id, notes) VALUES(?,?,?,?,?,?,?,?,?,?)", [customerId, item.entry.business_date, "credit", item.entry.product, item.sold, allocatedCredit, item.entry.pump, item.entry.user_name, item.entry.id, req.body.remarks || ""]);
      }
    }
    flash(req, Math.abs(shortage) <= 0.01 ? "success" : "warning", `Pump closed. Sales ${rs(totalAmount)} | Shortage/Excess ${rs(shortage)}`);
    res.redirect(`/reports?start=${encodeURIComponent(entries[0].business_date)}&end=${encodeURIComponent(entries[0].business_date)}`);
  });

app.get("/shift/summary/:id", requireLogin, async (req, res) => {
  const se = await one(
    `SELECT se.*, u.name user_name, sd.name shift_name, p.name pump
     FROM shift_entries se JOIN users u ON u.id=se.user_id JOIN shift_defs sd ON sd.id=se.shift_def_id
     JOIN nozzles n ON n.id=se.nozzle_id JOIN pumps p ON p.id=n.pump_id WHERE se.id=?`,
    [Number(req.params.id)]
  );
  if (!se) return res.redirect("/");
  res.send(layout(req, "Closing Summary", `${pageHead("Closing Summary", "Operations > Shift Summary")}
    <section class="panel"><div class="mini-grid">
      <article><strong>Product</strong><span>${esc(se.product)}</span></article>
      <article><strong>Litres sold</strong><span>${ltr(se.litres_sold)}</span></article>
      <article><strong>Sales</strong><span>${rs(se.sales_amount)}</span></article>
      <article><strong>Shortage/Excess</strong><span>${rs(se.shortage_excess)}</span></article>
    </div></section>${table([se])}`));
});

app.route("/purchase")
  .get(requireLogin, requireRoles("admin", "manager"), async (req, res) => {
    const tanks = await all("SELECT * FROM tanks WHERE status='Active'");
    const purchases = await all("SELECT p.*, t.name tank FROM purchases p JOIN tanks t ON t.id=p.tank_id ORDER BY p.business_date DESC, p.id DESC");
    res.send(layout(req, "Fuel Inward", `${pageHead("Fuel Inward", "Operations > Purchase")}
      <section class="form-card"><form method="post" class="grid-form">
        <label class="field"><span>Business date</span><input name="business_date" type="date" value="${todayIso()}" required></label>
        <label class="field"><span>Tank</span><select name="tank_id">${tanks.map((t) => option(t.id, `${t.name} - ${t.product}`)).join("")}</select></label>
        <label class="field"><span>Quantity litres</span><input name="quantity" type="number" step="0.001" required></label>
        <label class="field"><span>Rate</span><input name="rate" type="number" step="0.01"></label>
        <label class="field"><span>Supplier</span><input name="supplier"></label>
        <label class="field"><span>Invoice number</span><input name="invoice_number"></label>
        <label class="field span-2"><span>Notes</span><textarea name="notes"></textarea></label>
        <div class="action-row"><button class="primary">Add Purchase</button></div>
      </form></section>${table(purchases)}`));
  })
  .post(requireLogin, requireRoles("admin", "manager"), async (req, res) => {
    const tank = await one("SELECT * FROM tanks WHERE id=?", [Number(req.body.tank_id)]);
    const qty = litres(req.body.quantity);
    const rate = money(req.body.rate);
    const before = litres(tank.current_stock);
    const after = litres(before + qty);
    await run("INSERT INTO purchases(business_date, product, quantity, supplier, invoice_number, rate, total_amount, tank_id, before_stock, after_stock, notes) VALUES(?,?,?,?,?,?,?,?,?,?,?)", [req.body.business_date, tank.product, qty, req.body.supplier || "", req.body.invoice_number || "", rate, money(qty * rate), tank.id, before, after, req.body.notes || ""]);
    await run("UPDATE tanks SET current_stock=? WHERE id=?", [after, tank.id]);
    flash(req, "success", "Fuel purchase added and tank stock increased.");
    res.redirect("/purchase");
  });

app.route("/credit/payment")
  .get(requireLogin, requireRoles("admin", "manager"), async (req, res) => {
    const customers = await all("SELECT * FROM customers WHERE status='Active' ORDER BY name");
    const ledger = await all("SELECT cl.*, c.name customer FROM credit_ledger cl JOIN customers c ON c.id=cl.customer_id ORDER BY cl.business_date DESC, cl.id DESC LIMIT 100");
    res.send(layout(req, "Credit Payments", `${pageHead("Credit Payments", "Operations > Credit")}
      <section class="form-card"><form method="post" class="grid-form">
        <label class="field"><span>Business date</span><input name="business_date" type="date" value="${todayIso()}" required></label>
        <label class="field"><span>Customer</span><select name="customer_id">${customers.map((c) => option(c.id, `${c.name} (${rs(c.balance)})`)).join("")}</select></label>
        <label class="field"><span>Amount</span><input name="amount" type="number" step="0.01" required></label>
        <label class="field"><span>Payment mode</span><select name="payment_mode">${["Cash", "UPI", "Card"].map((m) => option(m)).join("")}</select></label>
        <label class="field span-2"><span>Notes</span><textarea name="notes"></textarea></label>
        <div class="action-row"><button class="primary">Record Payment</button></div>
      </form></section>${table(ledger)}`));
  })
  .post(requireLogin, requireRoles("admin", "manager"), async (req, res) => {
    const amount = money(req.body.amount);
    await run("UPDATE customers SET balance=balance-? WHERE id=?", [amount, Number(req.body.customer_id)]);
    await run("INSERT INTO credit_ledger(customer_id, business_date, entry_type, amount, payment_mode, notes) VALUES(?,?,?,?,?,?)", [Number(req.body.customer_id), req.body.business_date, "payment", amount, req.body.payment_mode || "Cash", req.body.notes || ""]);
    flash(req, "success", "Credit payment recorded.");
    res.redirect("/credit/payment");
  });

app.route("/day/close")
  .get(requireLogin, requireRoles("admin", "manager"), async (req, res) => {
    const day = await activeDay();
    if (!day) {
      flash(req, "error", "No open day to close.");
      return res.redirect("/");
    }
    const openCount = (await one("SELECT COUNT(*) c FROM shift_entries WHERE day_id=? AND status='Open'", [day.id])).c;
    const metrics = await dashboardMetrics();
    res.send(layout(req, "Day Closing", `${pageHead("Day Closing", "Operations > Day Closing")}
      <section class="stat-grid"><div class="stat"><span>Open shifts</span><strong>${esc(openCount)}</strong></div><div class="stat"><span>Sales</span><strong>${rs(metrics.totals.sales)}</strong></div><div class="stat"><span>Cash</span><strong>${rs(metrics.totals.cash)}</strong></div><div class="stat"><span>Credit</span><strong>${rs(metrics.totals.credit)}</strong></div></section>
      <section class="form-card"><form method="post" class="grid-form">
        <label class="field"><span>Actual MS stock</span><input name="actual_ms" type="number" step="0.001" required></label>
        <label class="field"><span>Actual HSD stock</span><input name="actual_hsd" type="number" step="0.001" required></label>
        <label class="field"><span>Actual cash</span><input name="actual_cash" type="number" step="0.01"></label>
        <div class="action-row"><button class="primary">Close Day</button></div>
      </form></section>`));
  })
  .post(requireLogin, requireRoles("admin", "manager"), async (req, res) => {
    const day = await activeDay();
    const openCount = (await one("SELECT COUNT(*) c FROM shift_entries WHERE day_id=? AND status='Open'", [day.id])).c;
    if (openCount) {
      flash(req, "error", "Close all open shifts before day closing.");
      return res.redirect("/day/close");
    }
    const actualMs = litres(req.body.actual_ms);
    const actualHsd = litres(req.body.actual_hsd);
    await run("UPDATE days SET actual_ms=?, actual_hsd=?, actual_cash=?, status='Closed', closed_at=CURRENT_TIMESTAMP WHERE id=?", [actualMs, actualHsd, money(req.body.actual_cash), day.id]);
    for (const [product, actual] of [["MS", actualMs], ["HSD", actualHsd]]) {
      const tanks = await all("SELECT * FROM tanks WHERE product=? AND status='Active'", [product]);
      const total = tanks.reduce((a, t) => a + Number(t.current_stock || 0), 0) || 1;
      for (const tank of tanks) await run("UPDATE tanks SET current_stock=? WHERE id=?", [actual * (Number(tank.current_stock || 0) / total), tank.id]);
    }
    flash(req, "success", "Day closed and entries locked.");
    res.redirect("/reports");
  });

app.post("/day/reopen/:id", requireLogin, requireRoles("admin"), async (req, res) => {
  await run("UPDATE days SET status='Open', closed_at=NULL WHERE id=?", [Number(req.params.id)]);
  flash(req, "warning", "Day reopened for admin corrections.");
  res.redirect("/");
});

app.get("/reports", requireLogin, async (req, res) => {
  const start = req.query.start || todayIso();
  const end = req.query.end || start;
  const product = req.query.product || "";
  const userId = req.user.role === "pump_boy" ? String(req.user.id) : req.query.user_id || "";
  const params = [start, end];
  let extra = "";
  if (product) {
    extra += " AND se.product=?";
    params.push(product);
  }
  if (userId) {
    extra += " AND se.user_id=?";
    params.push(userId);
  }
  const shiftRows = await all(
    `SELECT se.business_date, p.id pump_id, p.name pump, u.name user_name, sd.name shift_name, se.product,
     se.litres_sold, se.sales_amount, se.cash, se.upi, se.card, se.credit, se.expenses, se.beta, se.shortage_excess, se.status
     FROM shift_entries se JOIN users u ON u.id=se.user_id JOIN shift_defs sd ON sd.id=se.shift_def_id
     JOIN nozzles n ON n.id=se.nozzle_id JOIN pumps p ON p.id=n.pump_id
     WHERE se.business_date BETWEEN ? AND ? ${extra}
     ORDER BY se.business_date DESC, ${pumpOrderSql("p")}, se.product`,
    params
  );
  const reportMap = new Map();
  for (const row of shiftRows) {
    const key = `${row.business_date}-${row.pump_id}-${row.user_name}-${row.shift_name}-${row.status}`;
    if (!reportMap.has(key)) {
      reportMap.set(key, {
        business_date: row.business_date,
        pump: row.pump,
        team_member: row.user_name,
        shift: row.shift_name,
        ms_litres: 0,
        hsd_litres: 0,
        total_litres: 0,
        sales: 0,
        cash: 0,
        upi: 0,
        card: 0,
        credit: 0,
        shortage_excess: 0,
        status: row.status,
      });
    }
    const item = reportMap.get(key);
    if (row.product === "MS") item.ms_litres = litres(Number(item.ms_litres) + Number(row.litres_sold || 0));
    if (row.product === "HSD") item.hsd_litres = litres(Number(item.hsd_litres) + Number(row.litres_sold || 0));
    item.total_litres = litres(Number(item.total_litres) + Number(row.litres_sold || 0));
    item.sales = money(Number(item.sales) + Number(row.sales_amount || 0));
    item.cash = money(Number(item.cash) + Number(row.cash || 0));
    item.upi = money(Number(item.upi) + Number(row.upi || 0));
    item.card = money(Number(item.card) + Number(row.card || 0));
    item.credit = money(Number(item.credit) + Number(row.credit || 0));
    item.shortage_excess = money(Number(item.shortage_excess) + Number(row.shortage_excess || 0));
  }
  const shifts = Array.from(reportMap.values());
  const summary = await one(
    `SELECT COALESCE(SUM(litres_sold),0) litres, COALESCE(SUM(sales_amount),0) sales,
     COALESCE(SUM(cash),0) cash, COALESCE(SUM(upi),0) upi, COALESCE(SUM(card),0) card,
     COALESCE(SUM(credit),0) credit, COALESCE(SUM(expenses),0) expenses,
     COALESCE(SUM(beta),0) beta, COALESCE(SUM(shortage_excess),0) shortage
     FROM shift_entries se WHERE se.business_date BETWEEN ? AND ? ${extra}`,
    params
  );
  const paymentRows = await all(
    `SELECT se.business_date, u.name team_member, p.name pump, sp.product, sp.payment_type,
     COALESCE(SUM(sp.amount),0) amount, COUNT(*) entries
     FROM shift_payments sp
     JOIN shift_entries se ON se.id=sp.shift_entry_id
     JOIN users u ON u.id=se.user_id
     JOIN nozzles n ON n.id=se.nozzle_id
     JOIN pumps p ON p.id=n.pump_id
     WHERE se.business_date BETWEEN ? AND ? ${extra}
     GROUP BY se.business_date, u.id, u.name, p.id, p.name, sp.product, sp.payment_type
     ORDER BY se.business_date DESC, u.name, ${pumpOrderSql("p")}, sp.product, sp.payment_type`,
    params
  );
  const salesmanRows = await all(
    `SELECT se.business_date, u.name team_member,
     COALESCE(SUM(CASE WHEN se.product='MS' THEN se.litres_sold ELSE 0 END),0) ms_litres,
     COALESCE(SUM(CASE WHEN se.product='HSD' THEN se.litres_sold ELSE 0 END),0) hsd_litres,
     COALESCE(SUM(se.sales_amount),0) sales,
     COALESCE(SUM(se.cash),0) cash,
     COALESCE(SUM(se.upi),0) phone_pay,
     COALESCE(SUM(se.card),0) card,
     COALESCE(SUM(se.credit),0) credit,
     COALESCE(SUM(se.miscellaneous),0) personal_others,
     COALESCE(SUM(se.shortage_excess),0) shortage_excess
     FROM shift_entries se
     JOIN users u ON u.id=se.user_id
     WHERE se.business_date BETWEEN ? AND ? ${extra}
     GROUP BY se.business_date, u.id, u.name
     ORDER BY se.business_date DESC, u.name`,
    params
  );
  res.send(layout(req, "Reports", `${pageHead("Reports", "Operations > Reports", '<a class="link-button" href="/export/shifts.csv">Export CSV</a>')}
    <section class="form-card"><form method="get" class="grid-form">
      <label class="field"><span>Start</span><input name="start" type="date" value="${esc(start)}"></label>
      <label class="field"><span>End</span><input name="end" type="date" value="${esc(end)}"></label>
      <label class="field"><span>Product</span><select name="product"><option value="">All</option>${PRODUCTS.map((p) => option(p, p, product)).join("")}</select></label>
      <div class="action-row"><button class="primary">Filter</button></div>
    </form></section>
    <section class="stat-grid"><div class="stat"><span>Litres</span><strong>${ltr(summary.litres)}</strong></div><div class="stat"><span>Sales</span><strong>${rs(summary.sales)}</strong></div><div class="stat"><span>Cash</span><strong>${rs(summary.cash)}</strong></div><div class="stat"><span>Phone Pay</span><strong>${rs(summary.upi)}</strong></div><div class="stat"><span>Credit</span><strong>${rs(summary.credit)}</strong></div><div class="stat"><span>Shortage</span><strong>${rs(summary.shortage)}</strong></div></section>
    <section class="table-card"><div class="table-card-head"><div><h2>Complete Sales Data</h2><p>Pump-wise MS/HSD sales grouped for the selected dates.</p></div></div>${table(shifts)}</section>
    <section class="table-card"><div class="table-card-head"><div><h2>Salesman Date Data</h2><p>Daily totals by team member.</p></div></div>${table(salesmanRows)}</section>
    <section class="table-card"><div class="table-card-head"><div><h2>Payment Log Summary</h2><p>Payments logged during active shifts by type and product.</p></div></div>${table(paymentRows)}</section>`));
});

app.get("/export/shifts.csv", requireLogin, requireRoles("admin", "manager"), async (_req, res) => {
  const rows = await all("SELECT business_date, product, litres_sold, sales_amount, cash, upi, card, credit, expenses, beta, shortage_excess, status FROM shift_entries ORDER BY business_date DESC");
  const lines = ["date,product,litres,sales,cash,upi,card,credit,expenses,beta,shortage_excess,status"];
  for (const row of rows) lines.push(Object.values(row).map((v) => `"${String(v ?? 0).replaceAll('"', '""')}"`).join(","));
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=shift-report.csv");
  res.send(lines.join("\n"));
});

app.get("/health", async (_req, res) => {
  await initDb();
  res.json({
    ok: true,
    runtime: "node",
    database: USING_MYSQL ? MYSQL_CONFIG.database : path.basename(DATABASE),
    database_dir: USING_MYSQL ? MYSQL_CONFIG.host : path.dirname(DATABASE),
    database_source: USING_MYSQL ? "mysql" : process.env.PETROL_DB ? "PETROL_DB" : process.env.PETROL_DATA_DIR ? "PETROL_DATA_DIR" : "default_persistent",
  });
});

async function start() {
  if (USING_MYSQL) {
    if (!MYSQL_CONFIG.database || !MYSQL_CONFIG.user || !MYSQL_CONFIG.password) {
      throw new Error("MySQL is enabled, but DB_NAME, DB_USER, or DB_PASSWORD is missing.");
    }
    mysqlPool = await mysql.createPool(MYSQL_CONFIG);
    db = mysqlPool;
  } else {
    const SQL = await initSqlJs();
    prepareDatabaseFile();
    const fileBuffer = fs.existsSync(DATABASE) ? fs.readFileSync(DATABASE) : null;
    db = fileBuffer ? new SQL.Database(fileBuffer) : new SQL.Database();
    db.exec("PRAGMA foreign_keys = ON");
  }
  await initDb();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Petrol Station Manager running on port ${PORT} using ${DB_DIALECT}`);
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
