# 🚀 RecoverAI Separate Frontend & Backend Deployment Guide

RecoverAI is architected as two independent services:
- **`recoverai-backend`**: Dedicated Node/Express API service handling Prisma ORM, SQLite/PostgreSQL, Google Gemini 2.5 advisory engine, Policy Engine, and Razorpay webhooks.
- **`recoverai-frontend`**: Next.js App Router UI (`/dashboard`, `/dashboard/ledger`, `/dashboard/compliance`, `/dashboard/analytics`) that proxies API requests to the backend.

---

## Architecture Overview

```
                          ┌─────────────────────────────┐
                          │   Client Browser / Auditor  │
                          └──────────────┬──────────────┘
                                         │
                 ┌───────────────────────┴───────────────────────┐
                 │                                               │
                 ▼ (Static / SSR)                                ▼ (API Calls)
    ┌───────────────────────────┐                   ┌───────────────────────────┐
    │     Frontend Service      │                   │      Backend Service      │
    │     (Vercel / Port 3000)  │                   │ (Render/Docker/Port 4000) │
    │                           │                   │                           │
    │  - Next.js Cockpit UI     │                   │  - Express /server.ts     │
    │  - 3D Ambient Canvas      │                   │  - /api/audit, /webhook   │
    │  - Rewrites: /api/* ──────┼─── HTTP Proxy ───►│  - Gemini 2.5 AI Advisor  │
    │                           │                   │  - Policy Engine Kernel   │
    └───────────────────────────┘                   │  - Persistent SQLite/PG   │
                                                    └───────────────────────────┘
```

---

## Option 1: Vercel (Frontend) + Render / Railway (Backend) — *Recommended*

### Step 1: Deploy Backend to Render (or Railway)
1. Push your repository to GitHub.
2. Log in to [Render.com](https://render.com) and click **New > Blueprint**.
3. Select your repository. Render will automatically detect [`render.yaml`](./render.yaml).
4. Or manually create a **Web Service**:
   - **Build Command**: `npm ci && npx prisma generate && if [ ! -f dev.db ]; then cp dev.db.locked-baseline dev.db; fi`
   - **Start Command**: `npm run start:backend`
   - **Environment Variables**:
     - `PORT`: `4000`
     - `NODE_ENV`: `production`
     - `DATABASE_URL`: `file:./dev.db`
     - `DEMO_TRIGGER_SECRET`: *(A secure random string, e.g. `secret_live_demo_2026`)*
     - `GEMINI_API_KEY`: *(Your Google Gemini API Key)*
     - `RAZORPAY_KEY_ID`: *(Your Razorpay Key ID)*
     - `RAZORPAY_KEY_SECRET`: *(Your Razorpay Key Secret)*
     - `RAZORPAY_WEBHOOK_SECRET`: *(Your Razorpay Webhook Secret)*
   - **Disk (Persistence)**:
     - Mount path: `/app/prisma` (1GB disk)
5. Copy your backend's public URL (e.g. `https://recoverai-backend.onrender.com`).
6. Verify health check: `curl https://recoverai-backend.onrender.com/api/health`

### Step 2: Deploy Frontend to Vercel
1. Log in to [Vercel.com](https://vercel.com) and click **Add New > Project**.
2. Import your GitHub repository.
3. In **Environment Variables**, add:
   - `BACKEND_API_URL`: `https://recoverai-backend.onrender.com` *(your deployed backend URL)*
   - `DEMO_TRIGGER_SECRET`: *(same secret as backend)*
4. Click **Deploy**.
5. Once deployed, visit `https://your-app.vercel.app/dashboard`. The frontend automatically proxies all `/api/*` requests to your Render backend with zero CORS issues!

---

## Option 2: 1-Click Docker Compose (Any Cloud VPS / AWS / GCP / DigitalOcean)

You can run both services independently on any virtual machine or local Docker daemon using [`docker-compose.yml`](./docker-compose.yml):

```bash
# 1. Set environment variables in .env
cat <<EOF > .env
PORT=4000
GEMINI_API_KEY=your_gemini_key
RAZORPAY_KEY_ID=your_key_id
RAZORPAY_KEY_SECRET=your_key_secret
RAZORPAY_WEBHOOK_SECRET=your_webhook_secret
DEMO_TRIGGER_SECRET=demo-secret-recoverai-2026
EOF

# 2. Build and start both containers in detached mode
docker compose up --build -d

# 3. Check running status
docker compose ps
```

- **Frontend UI**: [http://localhost:3000/dashboard](http://localhost:3000/dashboard)
- **Backend API**: [http://localhost:4000/api/health](http://localhost:4000/api/health)

To view logs:
```bash
docker compose logs -f backend
docker compose logs -f frontend
```

---

## Option 3: Local Multi-Process Development

Run frontend and backend in separate terminal tabs locally:

### Terminal 1: Backend Service
```bash
npm run dev:backend
# Started on http://localhost:4000
```

### Terminal 2: Frontend Service
```bash
BACKEND_API_URL=http://localhost:4000 npm run dev:frontend
# Started on http://localhost:3000, proxying all /api/* calls to port 4000
```

---

## Razorpay Webhook Configuration

When configuring webhooks in your Razorpay Dashboard:
- **Webhook URL**: `https://<YOUR_BACKEND_URL>/api/webhook`
- **Secret**: Set this to match `RAZORPAY_WEBHOOK_SECRET`
- **Active Events**:
  - `payment.captured`
  - `payment.failed`
  - `payment_link.paid`
  - `order.paid`
  - `refund.processed`
