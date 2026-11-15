const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const mongoose = require("mongoose");

const PORT = process.env.PORT || 5000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123"; // change this!
const MONGODB_URI = process.env.MONGODB_URI;
const STATUSES = ["pending", "preparing", "out for delivery", "delivered", "cancelled"];

if (!MONGODB_URI) {
  console.error("MONGODB_URI is missing. Set it as an environment variable.");
  process.exit(1);
}

// ---------- MongoDB models ----------
// We keep a numeric "id" on every document so the React frontend works unchanged.
const Menu = mongoose.model(
  "Menu",
  new mongoose.Schema(
    {
      id: { type: Number, unique: true, required: true },
      name: String,
      price: Number,
      category: String,
      emoji: String,
      available: { type: Boolean, default: true },
    },
    { versionKey: false }
  )
);

const Order = mongoose.model(
  "Order",
  new mongoose.Schema(
    {
      id: { type: Number, unique: true, required: true },
      customer: { name: String, phone: String, address: String },
      items: [{ _id: false, id: Number, name: String, price: Number, qty: Number }],
      total: Number,
      status: { type: String, default: "pending" },
      createdAt: String,
    },
    { versionKey: false }
  )
);

const Counter = mongoose.model(
  "Counter",
  new mongoose.Schema({ _id: String, seq: Number }, { versionKey: false })
);

async function nextOrderNo() {
  const c = await Counter.findOneAndUpdate(
    { _id: "order" },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return 1000 + c.seq; // first order is #1001
}

const defaultMenu = [
  { id: 1, name: "Chicken Biryani", price: 220, category: "Rice", emoji: "🍛" },
  { id: 2, name: "Fish Curry Meals", price: 180, category: "Rice", emoji: "🐟" },
  { id: 3, name: "Appam & Veg Stew", price: 140, category: "Breakfast", emoji: "🥣" },
  { id: 4, name: "Masala Dosa", price: 90, category: "Breakfast", emoji: "🥞" },
  { id: 5, name: "Beef Fry & Parotta", price: 200, category: "Mains", emoji: "🥩" },
  { id: 6, name: "Chicken Roll", price: 110, category: "Snacks", emoji: "🌯" },
  { id: 7, name: "Filter Coffee", price: 40, category: "Drinks", emoji: "☕" },
  { id: 8, name: "Fresh Lime Soda", price: 50, category: "Drinks", emoji: "🍋" },
];

// ---------- app ----------
const app = express();
app.use(cors());
app.use(express.json());

// catches errors from async routes so the server never crashes
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

app.get("/", (req, res) => res.send("Food order backend is running"));

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
app.get(
  "/api/menu",
  wrap(async (req, res) => {
    res.json(await Menu.find({ available: true }).select("-_id").sort({ id: 1 }).lean());
  })
);

// ---------- public: place and track orders ----------
app.post(
  "/api/orders",
  wrap(async (req, res) => {
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
      const dish = await Menu.findOne({ id: Number(id), available: true }).lean();
      const count = Math.floor(Number(qty));
      if (!dish || !(count > 0)) {
        return res.status(400).json({ error: "An item in your cart is no longer available" });
      }
      lines.push({ id: dish.id, name: dish.name, price: dish.price, qty: count });
    }

    const order = {
      id: await nextOrderNo(),
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
    await Order.create(order);
    res.status(201).json(order);
  })
);

app.get(
  "/api/orders/:id",
  wrap(async (req, res) => {
    const order = await Order.findOne({ id: Number(req.params.id) }).lean();
    if (!order) return res.status(404).json({ error: "Order not found" });
    // Only share what a customer needs to see
    res.json({
      id: order.id,
      status: order.status,
      total: order.total,
      items: order.items,
      createdAt: order.createdAt,
    });
  })
);

// ---------- admin: orders ----------
app.get(
  "/api/admin/orders",
  requireAdmin,
  wrap(async (req, res) => {
    res.json(await Order.find().select("-_id").sort({ id: -1 }).lean());
  })
);

app.patch(
  "/api/admin/orders/:id",
  requireAdmin,
  wrap(async (req, res) => {
    if (!STATUSES.includes(req.body.status)) {
      return res.status(400).json({ error: "Invalid status" });
    }
    const order = await Order.findOneAndUpdate(
      { id: Number(req.params.id) },
      { $set: { status: req.body.status } },
      { new: true }
    )
      .select("-_id")
      .lean();
    if (!order) return res.status(404).json({ error: "Order not found" });
    res.json(order);
  })
);

app.delete(
  "/api/admin/orders/:id",
  requireAdmin,
  wrap(async (req, res) => {
    await Order.deleteOne({ id: Number(req.params.id) });
    res.json({ ok: true });
  })
);

// ---------- admin: menu ----------
app.get(
  "/api/admin/menu",
  requireAdmin,
  wrap(async (req, res) => {
    res.json(await Menu.find().select("-_id").sort({ id: 1 }).lean());
  })
);

app.post(
  "/api/admin/menu",
  requireAdmin,
  wrap(async (req, res) => {
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
    await Menu.create(dish);
    res.status(201).json(dish);
  })
);

app.put(
  "/api/admin/menu/:id",
  requireAdmin,
  wrap(async (req, res) => {
    const { name, price, category, emoji, available } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = String(name).trim();
    if (price !== undefined && Number(price) > 0) updates.price = Number(price);
    if (category !== undefined) updates.category = String(category).trim();
    if (emoji !== undefined) updates.emoji = String(emoji).trim();
    if (available !== undefined) updates.available = Boolean(available);

    const dish = await Menu.findOneAndUpdate(
      { id: Number(req.params.id) },
      { $set: updates },
      { new: true }
    )
      .select("-_id")
      .lean();
    if (!dish) return res.status(404).json({ error: "Dish not found" });
    res.json(dish);
  })
);

app.delete(
  "/api/admin/menu/:id",
  requireAdmin,
  wrap(async (req, res) => {
    await Menu.deleteOne({ id: Number(req.params.id) });
    res.json({ ok: true });
  })
);

// ---------- error handler ----------
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Server error. Please try again." });
});

// ---------- start: connect to MongoDB first ----------
mongoose
  .connect(MONGODB_URI)
  .then(async () => {
    console.log("MongoDB connected");
    if ((await Menu.countDocuments()) === 0) {
      await Menu.insertMany(defaultMenu); // first run: add the sample menu
      console.log("Sample menu added");
    }
    app.listen(PORT, () => {
      console.log(`Backend running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Could not connect to MongoDB:", err.message);
    process.exit(1);
  });
