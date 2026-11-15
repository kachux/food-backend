const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 5000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123"; // change this!
const DB_FILE = path.join(__dirname, "db.json");
const STATUSES = ["pending", "preparing", "out for delivery", "delivered", "cancelled"];

// ---------- tiny JSON-file database ----------
const defaultData = {
  nextOrderNo: 1001,
  menu: [
    { id: 1, name: "Chicken Biryani", price: 220, category: "Rice", emoji: "🍛", available: true },
    { id: 2, name: "Fish Curry Meals", price: 180, category: "Rice", emoji: "🐟", available: true },
    { id: 3, name: "Appam & Veg Stew", price: 140, category: "Breakfast", emoji: "🥣", available: true },
    { id: 4, name: "Masala Dosa", price: 90, category: "Breakfast", emoji: "🥞", available: true },
    { id: 5, name: "Beef Fry & Parotta", price: 200, category: "Mains", emoji: "🥩", available: true },
    { id: 6, name: "Chicken Roll", price: 110, category: "Snacks", emoji: "🌯", available: true },
    { id: 7, name: "Filter Coffee", price: 40, category: "Drinks", emoji: "☕", available: true },
    { id: 8, name: "Fresh Lime Soda", price: 50, category: "Drinks", emoji: "🍋", available: true },
  ],
  orders: [],
};

function load() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    fs.writeFileSync(DB_FILE, JSON.stringify(defaultData, null, 2));
    return JSON.parse(JSON.stringify(defaultData));
  }
}
const db = load();
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

// ---------- app ----------
const app = express();
app.use(cors());
app.use(express.json());

// ---------- admin auth (in-memory tokens) ----------
const tokens = new Set();

function requireAdmin(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!tokens.has(token)) return res.status(401).json({ error: "Please log in as admin" });
  next();
}

app.post("/api/admin/login", (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Wrong password" });
  }
  const token = crypto.randomBytes(24).toString("hex");
  tokens.add(token);
  res.json({ token });
});

app.post("/api/admin/logout", requireAdmin, (req, res) => {
  tokens.delete((req.headers.authorization || "").replace("Bearer ", ""));
  res.json({ ok: true });
});

// ---------- public: menu ----------
app.get("/api/menu", (req, res) => {
  res.json(db.menu.filter((m) => m.available));
});

// ---------- public: place and track orders ----------
app.post("/api/orders", (req, res) => {
  const { customer, items } = req.body;
  if (!customer?.name?.trim() || !customer?.phone?.trim() || !customer?.address?.trim()) {
    return res.status(400).json({ error: "Name, phone and address are required" });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Your cart is empty" });
  }

  // Prices are always calculated on the server, never trusted from the browser
  const lines = [];
  for (const { id, qty } of items) {
    const dish = db.menu.find((m) => m.id === id && m.available);
    const count = Math.floor(Number(qty));
    if (!dish || !(count > 0)) {
      return res.status(400).json({ error: "An item in your cart is no longer available" });
    }
    lines.push({ id: dish.id, name: dish.name, price: dish.price, qty: count });
  }

  const order = {
    id: db.nextOrderNo++,
    customer: {
      name: customer.name.trim(),
      phone: customer.phone.trim(),
      address: customer.address.trim(),
    },
    items: lines,
    total: lines.reduce((sum, l) => sum + l.price * l.qty, 0),
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  db.orders.push(order);
  save();
  res.status(201).json(order);
});

app.get("/api/orders/:id", (req, res) => {
  const order = db.orders.find((o) => o.id === Number(req.params.id));
  if (!order) return res.status(404).json({ error: "Order not found" });
  // Only share what a customer needs to see
  res.json({
    id: order.id,
    status: order.status,
    total: order.total,
    items: order.items,
    createdAt: order.createdAt,
  });
});

// ---------- admin: orders ----------
app.get("/api/admin/orders", requireAdmin, (req, res) => {
  res.json([...db.orders].reverse());
});

app.patch("/api/admin/orders/:id", requireAdmin, (req, res) => {
  const order = db.orders.find((o) => o.id === Number(req.params.id));
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (!STATUSES.includes(req.body.status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  order.status = req.body.status;
  save();
  res.json(order);
});

app.delete("/api/admin/orders/:id", requireAdmin, (req, res) => {
  db.orders = db.orders.filter((o) => o.id !== Number(req.params.id));
  save();
  res.json({ ok: true });
});

// ---------- admin: menu ----------
app.get("/api/admin/menu", requireAdmin, (req, res) => {
  res.json(db.menu);
});

app.post("/api/admin/menu", requireAdmin, (req, res) => {
  const { name, price, category, emoji } = req.body;
  if (!name?.trim() || !(Number(price) > 0)) {
    return res.status(400).json({ error: "A name and a price above 0 are required" });
  }
  const dish = {
    id: Date.now(),
    name: name.trim(),
    price: Number(price),
    category: (category || "Mains").trim(),
    emoji: (emoji || "🍽️").trim(),
    available: true,
  };
  db.menu.push(dish);
  save();
  res.status(201).json(dish);
});

app.put("/api/admin/menu/:id", requireAdmin, (req, res) => {
  const dish = db.menu.find((m) => m.id === Number(req.params.id));
  if (!dish) return res.status(404).json({ error: "Dish not found" });
  const { name, price, category, emoji, available } = req.body;
  if (name !== undefined) dish.name = String(name).trim();
  if (price !== undefined && Number(price) > 0) dish.price = Number(price);
  if (category !== undefined) dish.category = String(category).trim();
  if (emoji !== undefined) dish.emoji = String(emoji).trim();
  if (available !== undefined) dish.available = Boolean(available);
  save();
  res.json(dish);
});

app.delete("/api/admin/menu/:id", requireAdmin, (req, res) => {
  db.menu = db.menu.filter((m) => m.id !== Number(req.params.id));
  save();
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
  console.log(`Admin password: ${ADMIN_PASSWORD}`);
});
