const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
// ========== NEW: Import Prometheus client library ==========
// This library allows us to expose metrics that Prometheus can scrape
const promClient = require('prom-client');
require('dotenv').config();

const userRoutes = require('./routes/userRoutes');
const authRoutes = require('./routes/authRoutes');
const db = require('./models/db'); // MySQL pool connection

const app = express();
const PORT = process.env.PORT || 5000;

// ========== NEW: Prometheus Metrics Setup ==========

// Create a registry to store all our metrics
// The registry acts as a container for all metrics we want to expose
const register = new promClient.Registry();

// Collect default Node.js metrics automatically (CPU, memory, event loop, etc.)
// These give us insights into the health of our Node.js application
promClient.collectDefaultMetrics({ register });

// Create a custom histogram metric to track HTTP request duration
// Histograms are useful for measuring request latency and can be used to calculate percentiles
const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',           // Metric name in Prometheus
  help: 'Duration of HTTP requests in seconds',    // Description of what this metric tracks
  labelNames: ['method', 'route', 'status_code'],  // Labels to categorize requests (GET vs POST, different routes, etc.)
  registers: [register]                            // Associate this metric with our registry
});

// ========== NEW: Middleware to automatically track request duration ==========
// This middleware runs for EVERY incoming HTTP request and measures how long it takes
app.use((req, res, next) => {
  // Record the start time of the request
  const start = Date.now();
  
  // Listen for when the response is finished being sent
  res.on('finish', () => {
    // Calculate how long the request took (in seconds)
    const duration = (Date.now() - start) / 1000;
    
    // Get the route path (e.g., "/api/users" or "/api/auth/login")
    // If no route is matched, use the raw path
    const route = req.route ? req.route.path : req.path;
    
    // Record the observation in our histogram with labels
    // This allows Prometheus to track request duration by method, route, and status code
    httpRequestDuration
      .labels(req.method, route, res.statusCode.toString())
      .observe(duration);
  });
  
  // Continue to the next middleware/route handler
  next();
});

// Middleware
app.use(cors());
app.use(bodyParser.json());

// ========== NEW: Metrics Endpoint for Prometheus ==========
// Prometheus will scrape this endpoint to collect metrics
// This endpoint returns all metrics in Prometheus text format
app.get('/metrics', async (req, res) => {
  // Set the correct content type for Prometheus format
  res.set('Content-Type', register.contentType);
  // Return all collected metrics as text
  res.end(await register.metrics());
});

// ========== NEW: Health Check Endpoint ==========
// Useful for Kubernetes liveness/readiness probes and monitoring
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);

// Function to wait until MySQL is ready
const waitForDb = async (retries = 30, delay = 2000) => {
  while (retries > 0) {
    try {
      const [rows] = await db.promise().query("SHOW TABLES LIKE 'users'");
      if (rows.length > 0) {
        console.log('✅ MySQL `users` table found.');
        return;
      }
      console.log(`⏳ Waiting for MySQL (users table)... Retries left: ${retries}`);
    } catch (err) {
      console.error(`🔴 MySQL query failed: ${err.message}`);
    }

    retries--;
    await new Promise(res => setTimeout(res, delay));
  }
  throw new Error('❌ MySQL `users` table not available after multiple retries.');
};

// Function to seed admin user if not exists
const seedAdminUser = async () => {
  const name = process.env.ADMIN_NAME || 'Admin User';
  const email = process.env.ADMIN_EMAIL || 'admin@example.com';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  const role = process.env.ADMIN_ROLE || 'admin';

  try {
    const [existing] = await db.promise().query(
      'SELECT * FROM users WHERE email = ?',
      [email]
    );

    if (existing.length === 0) {
      const hashed = await bcrypt.hash(password, 10);
      await db.promise().query(
        'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
        [name, email, hashed, role]
      );
      console.log(`✅ Admin user created → ${email}`);
    } else {
      console.log(`ℹ️ Admin user already exists → ${email}`);
    }
  } catch (err) {
    console.error(`❌ Admin seeding failed: ${err.message}`);
  }
};

// Start server
(async () => {
  try {
    await waitForDb();
    await seedAdminUser();
    // Log all routes
    console.log("Registered routes:");
    app._router.stack
      .filter(r => r.route)
      .forEach(r => console.log(r.route.path));

    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
      // NEW: Log the metrics endpoint URL for easy access
      console.log(`📊 Metrics available at http://0.0.0.0:${PORT}/metrics`);
    });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
})();