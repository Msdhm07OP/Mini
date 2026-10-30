import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';

import logger from './utils/logger/index.js';
import { checkHealth, closePool } from './database/config.js';

// Routes
import bookingRoutes from './routes/v1/bookings.js';
import venueRoutes from './routes/v1/venues.js';
import clientRoutes from './routes/v1/clients.js';
import analyticsRoutes from './routes/v1/analytics.js';
import simulationRoutes from './routes/v1/simulations.js';
import eventOrderRoutes from './routes/v1/eventOrders.js';
import authRoutes from './routes/v1/auth.js';
import userRoutes from './routes/v1/users.js';
import portalRoutes from './routes/v1/portal.js';
import { authenticateSupabase, requireOperationsRole, requireManagementRole, requireAdminRole, validateAuthConfiguration } from './middleware/supabaseAuth.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// =============================================================================
// SECURITY & MIDDLEWARE
// =============================================================================

// Security headers
app.use(helmet());

// CORS
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'),
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100'),
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// HTTP request logging
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined', {
    stream: {
      write: (message) => logger.info(message.trim())
    }
  }));
}

// Correlation ID middleware
app.use((req, res, next) => {
  const supplied = req.headers['x-correlation-id'];
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  // correlation_id is stored as UUID in PostgreSQL; never let an arbitrary
  // caller header break an otherwise valid booking transaction.
  req.correlationId = typeof supplied === 'string' && uuidPattern.test(supplied) ? supplied : uuidv4();
  res.setHeader('X-Correlation-ID', req.correlationId);
  next();
});

// Request logging
app.use((req, res, next) => {
  logger.debug('Incoming request', {
    method: req.method,
    path: req.path,
    correlationId: req.correlationId,
    ip: req.ip
  });
  next();
});

// =============================================================================
// ROUTES
// =============================================================================

// Health check
app.get('/health', async (req, res) => {
  try {
    const dbHealth = await checkHealth();
    const isHealthy = dbHealth.healthy;

    res.status(isHealthy ? 200 : 503).json({
      status: isHealthy ? 'ok' : 'error',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: dbHealth,
      version: '3.0.0'
    });
  } catch (error) {
    logger.error('Health check failed', { error: error.message });
    res.status(503).json({
      status: 'error',
      message: 'Health check failed',
      timestamp: new Date().toISOString()
    });
  }
});

// API info
app.get('/', (req, res) => {
  res.json({
    name: 'EventSync API',
    version: '3.0.0',
    description: 'Production Event Scheduling and Resource Management System',
    endpoints: {
      health: '/health',
      bookings: '/api/v1/bookings',
      venues: '/api/v1/venues',
      clients: '/api/v1/clients'
    },
    features: [
      'Database-level concurrency safety',
      'Advisory locks for resource allocation',
      'Idempotency support',
      'Comprehensive audit trail',
      'Automatic retry on serialization failures'
    ]
  });
});

// Authenticated API routes. In local development without Supabase configured, the
// middleware explicitly enters local-demo mode. Production refuses to start without Auth.
app.use('/api/v1/auth', authenticateSupabase, authRoutes);
app.use('/api/v1/users', authenticateSupabase, requireAdminRole, userRoutes);
app.use('/api/v1/portal', authenticateSupabase, portalRoutes);
app.use('/api/v1/bookings', authenticateSupabase, requireOperationsRole, bookingRoutes);
app.use('/api/v1/venues', authenticateSupabase, requireOperationsRole, venueRoutes);
app.use('/api/v1/clients', authenticateSupabase, requireManagementRole, clientRoutes);
app.use('/api/v1/analytics', authenticateSupabase, requireManagementRole, analyticsRoutes);
app.use('/api/v1/simulations', authenticateSupabase, requireManagementRole, simulationRoutes);
app.use('/api/v1/event-orders', authenticateSupabase, requireOperationsRole, eventOrderRoutes);

// Backward-compatible endpoints receive exactly the same auth and role checks.
app.use('/api/auth', authenticateSupabase, authRoutes);
app.use('/api/users', authenticateSupabase, requireAdminRole, userRoutes);
app.use('/api/portal', authenticateSupabase, portalRoutes);
app.use('/api/bookings', authenticateSupabase, requireOperationsRole, bookingRoutes);
app.use('/api/venues', authenticateSupabase, requireOperationsRole, venueRoutes);
app.use('/api/clients', authenticateSupabase, requireManagementRole, clientRoutes);
app.use('/api/analytics', authenticateSupabase, requireManagementRole, analyticsRoutes);
app.use('/api/simulations', authenticateSupabase, requireManagementRole, simulationRoutes);
app.use('/api/event-orders', authenticateSupabase, requireOperationsRole, eventOrderRoutes);

// =============================================================================
// ERROR HANDLING
// =============================================================================

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`,
    correlationId: req.correlationId
  });
});

// Global error handler
app.use((err, req, res, next) => {
  // Log error
  logger.error('Error occurred', {
    error: err.message,
    stack: err.stack,
    correlationId: req.correlationId,
    path: req.path,
    method: req.method
  });

  // Handle specific error types
  if (err.code === '23505') { // PostgreSQL unique violation
    return res.status(409).json({
      success: false,
      error: 'Conflict',
      message: 'A booking with these details already exists',
      correlationId: req.correlationId
    });
  }

  if (err.code === '23P01') { // PostgreSQL exclusion violation
    return res.status(409).json({
      success: false,
      error: 'Booking Conflict',
      message: 'This time slot is no longer available due to a conflicting booking',
      correlationId: req.correlationId
    });
  }

  if (err.code === '42501') { // Supabase RPC authorization failure
    return res.status(403).json({
      success: false,
      error: 'Forbidden',
      message: 'Your EventSync role does not permit this operation.',
      correlationId: req.correlationId
    });
  }

  if (err.code === 'P0002') { // Requested record not found (RPC)
    return res.status(404).json({
      success: false,
      error: 'Not Found',
      message: 'The requested booking was not found or is no longer available.',
      correlationId: req.correlationId
    });
  }

  if (err.code === '22023' || err.code === '22P02') { // Invalid input value
    return res.status(400).json({
      success: false,
      error: 'Invalid Input',
      message: 'The request contains an invalid value. Please review the booking details.',
      correlationId: req.correlationId
    });
  }

  if (err.code === '40001') { // Serialization failure
    return res.status(503).json({
      success: false,
      error: 'Service Temporarily Unavailable',
      message: 'High concurrency detected. Please retry your request.',
      correlationId: req.correlationId,
      retryable: true
    });
  }

  if (err.code === '40P01') { // Deadlock
    return res.status(503).json({
      success: false,
      error: 'Service Temporarily Unavailable',
      message: 'Database contention detected. Please retry your request.',
      correlationId: req.correlationId,
      retryable: true
    });
  }

  // Default error response
  const statusCode = err.status || err.statusCode || 500;
  const message = process.env.NODE_ENV === 'production' && statusCode === 500
    ? 'An unexpected error occurred'
    : err.message;

  res.status(statusCode).json({
    success: false,
    error: err.name || 'Internal Server Error',
    message,
    correlationId: req.correlationId,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
});

// =============================================================================
// SERVER LIFECYCLE
// =============================================================================

let server;

// Start server
function startServer() {
  validateAuthConfiguration();
  server = app.listen(PORT, () => {
    logger.info(`EventSync 3.0 server started`, {
      port: PORT,
      environment: process.env.NODE_ENV || 'development',
      nodeVersion: process.version
    });
    console.log(`\n✓ EventSync 3.0 Server running on port ${PORT}`);
    console.log(`✓ Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`✓ Health check: http://localhost:${PORT}/health`);
    console.log(`✓ API endpoint: http://localhost:${PORT}/api/v1\n`);
  });
}

// Graceful shutdown
async function gracefulShutdown(signal) {
  logger.info(`${signal} received, starting graceful shutdown`);
  console.log(`\n${signal} received. Shutting down gracefully...`);

  // Stop accepting new connections
  if (server) {
    server.close(async () => {
      logger.info('HTTP server closed');

      // Close database pool
      try {
        await closePool();
        logger.info('Database connections closed');
      } catch (error) {
        logger.error('Error closing database pool', { error: error.message });
      }

      console.log('✓ Server shut down complete');
      process.exit(0);
    });

    // Force shutdown after 30 seconds
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      console.error('Could not close connections in time, forcefully shutting down');
      process.exit(1);
    }, 30000);
  } else {
    process.exit(0);
  }
}

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', {
    error: error.message,
    stack: error.stack
  });
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled promise rejection', {
    reason: reason instanceof Error ? reason.message : reason,
    stack: reason instanceof Error ? reason.stack : undefined
  });
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start the server (unless in test mode)
if (process.env.NODE_ENV !== 'test') {
  startServer();
}

export default app;
