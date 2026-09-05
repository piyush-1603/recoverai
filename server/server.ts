/**
 * server/server.ts
 *
 * Dedicated RecoverAI Backend API Service
 *
 * Runs as a standalone HTTP/Express service on PORT (default: 4000).
 * Decoupled from the Next.js frontend, providing:
 *  - CORS support for frontend origins (Vercel, localhost, custom domains)
 *  - REST endpoints: /api/audit, /api/demo-trigger, /api/test-webhook-simulator,
 *    /api/webhook, and /api/p2p/*
 *  - System Health Telemetry: /api/health
 *  - Zero-friction integration with existing Prisma, Policy Engine, and Gemini models
 */

import 'dotenv/config';
import express, { Request as ExpRequest, Response as ExpResponse, NextFunction } from 'express';
import cors from 'cors';
import { NextRequest } from 'next/server';
import { prisma } from '../lib/prisma';

// Route Handlers
import { GET as getAudit } from '../app/api/audit/route';
import { POST as postDemoTrigger } from '../app/api/demo-trigger/route';
import { POST as postWebhookSimulator } from '../app/api/test-webhook-simulator/route';
import { POST as postWebhook } from '../app/api/webhook/route';
import { GET as getP2P, POST as postP2P } from '../app/api/p2p/route';
import { POST as postP2PProcess } from '../app/api/p2p/process/route';
import { GET as getP2PById } from '../app/api/p2p/[id]/route';

const app = express();
const PORT = process.env.PORT || process.env.BACKEND_PORT || 4000;

// ── 1. CORS Configuration ──
const allowedOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:4000',
  process.env.FRONTEND_URL,
  process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined,
  process.env.NEXT_PUBLIC_APP_URL,
].filter(Boolean) as string[];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, server-to-server)
      if (!origin) return callback(null, true);
      // Allow localhost or explicitly listed frontend URLs
      if (
        allowedOrigins.includes(origin) ||
        origin.endsWith('.vercel.app') ||
        origin.includes('localhost')
      ) {
        return callback(null, true);
      }
      return callback(null, true); // Permissive in hackathon/demo mode
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-demo-secret',
      'x-razorpay-signature',
      'x-razorpay-event-id',
      'x-requested-with',
    ],
  })
);

// ── 2. Body Parsing ──
// Razorpay webhook requires raw unparsed string body for HMAC-SHA256 signature verification
app.use('/api/webhook', express.text({ type: '*/*', limit: '10mb' }));

// All other endpoints use JSON / URL-encoded bodies
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── 3. Next.js Handler Adapter ──
/**
 * Bridges Express request/response to web-standard NextRequest/Response
 */
function adaptRoute(handler: (req: NextRequest, ctx?: any) => Promise<Response>) {
  return async (req: ExpRequest, res: ExpResponse, next: NextFunction) => {
    try {
      const protocol = req.protocol || 'http';
      const host = req.get('host') || `localhost:${PORT}`;
      const url = `${protocol}://${host}${req.originalUrl}`;

      const headers = new Headers();
      for (const [key, val] of Object.entries(req.headers)) {
        if (val !== undefined) {
          if (Array.isArray(val)) {
            val.forEach((v) => headers.append(key, v));
          } else {
            headers.set(key, val);
          }
        }
      }

      const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
        ? typeof req.body === 'string'
          ? req.body
          : Buffer.isBuffer(req.body)
          ? req.body.toString('utf-8')
          : JSON.stringify(req.body)
        : undefined;

      const nextReq = new NextRequest(url, {
        method: req.method,
        headers,
        body,
      });

      const response = await handler(nextReq, { params: req.params });

      res.status(response.status);
      response.headers.forEach((v, k) => {
        if (k.toLowerCase() !== 'transfer-encoding') {
          res.setHeader(k, v);
        }
      });

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const json = await response.json();
        res.json(json);
      } else {
        const text = await response.text();
        res.send(text);
      }
    } catch (err: any) {
      console.error(`[Backend API Error] ${req.method} ${req.path}:`, err);
      res.status(500).json({ error: err?.message || 'Internal Server Error' });
    }
  };
}

// ── 4. Health & System Telemetry Endpoint ──
app.get('/api/health', async (_req: ExpRequest, res: ExpResponse) => {
  try {
    const startPing = Date.now();
    const txCount = await prisma.transaction.count();
    const auditCount = await prisma.auditLog.count();
    const dbLatencyMs = Date.now() - startPing;

    // TRAI Window Calculation
    const istTimeStr = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata',
      hour: 'numeric',
      hour12: false,
    }).format(new Date());
    const istHour = parseInt(istTimeStr, 10);
    const isTraiOpen = istHour >= 10 && istHour < 21;

    res.json({
      status: 'healthy',
      service: 'recoverai-backend',
      version: '0.1.0',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      database: {
        connected: true,
        latencyMs: dbLatencyMs,
        benchmarkTransactions: txCount,
        auditLogsRecorded: auditCount,
      },
      telemetry: {
        istHour,
        traiNocturnalWindowActive: !isTraiOpen,
        policyEngineKernel: 'enforcing',
        aiAdvisor: process.env.GEMINI_API_KEY ? 'gemini-2.5-flash (connected)' : 'heuristic-fallback',
      },
    });
  } catch (error: any) {
    res.status(500).json({
      status: 'unhealthy',
      service: 'recoverai-backend',
      error: error?.message || 'Database connection error',
    });
  }
});

// ── 5. Mount REST Endpoints ──
// Audit & Telemetry
app.get('/api/audit', adaptRoute(getAudit as any));

// Live Demo & Compliance Triggers
app.post('/api/demo-trigger', adaptRoute(postDemoTrigger as any));

// Webhook Simulator (1-Click HMAC-Signed Verification)
app.post('/api/test-webhook-simulator', adaptRoute(postWebhookSimulator as any));

// Razorpay Webhook Ingestion (Direct / External Gateway)
app.post('/api/webhook', adaptRoute(postWebhook as any));

// P2P (Promise-to-Pay Watchdog)
app.get('/api/p2p', adaptRoute(getP2P as any));
app.post('/api/p2p', adaptRoute(postP2P as any));
app.post('/api/p2p/process', adaptRoute(postP2PProcess as any));
app.get('/api/p2p/:id', adaptRoute(getP2PById as any));

// ── 6. Root Info Route ──
app.get('/', (_req: ExpRequest, res: ExpResponse) => {
  res.json({
    service: 'RecoverAI Autonomous Recovery Backend Engine',
    status: 'online',
    endpoints: [
      '/api/health',
      '/api/audit',
      '/api/demo-trigger',
      '/api/test-webhook-simulator',
      '/api/webhook',
      '/api/p2p',
      '/api/p2p/process',
    ],
    documentation: 'https://github.com/piyush-1603/recoverai',
  });
});

// ── 7. Start Server ──
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`\n══════════════════════════════════════════════════════════`);
    console.log(`  🚀 RECOVERAI DEDICATED BACKEND ENGINE`);
    console.log(`══════════════════════════════════════════════════════════`);
    console.log(`  Port        : ${PORT}`);
    console.log(`  Health Check: http://localhost:${PORT}/api/health`);
    console.log(`  Audit API   : http://localhost:${PORT}/api/audit`);
    console.log(`  Webhooks    : http://localhost:${PORT}/api/webhook`);
    console.log(`  Environment : ${process.env.NODE_ENV || 'development'}`);
    console.log(`══════════════════════════════════════════════════════════\n`);
  });
}

export default app;
