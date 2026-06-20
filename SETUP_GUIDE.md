# Upper Echelon Automotive — Phase 2 Backend Setup Guide

This backend handles real money: customer card payments, technician payouts,
and the $19.99/mo membership subscription. Follow these steps in order.

---

## ⚠️ You are in LIVE mode

Every step below uses real Stripe keys and will process real charges. There
is no test/sandbox layer in this setup — be careful when testing.

---

## Step 1 — Run the database migration

1. Go to Supabase → **SQL Editor**
2. Open `phase2_migration.sql` (included alongside this guide)
3. Paste the entire thing, click **Run**
4. Confirm "Success. No rows returned."

This adds the columns the backend needs: `stripe_connect_id` (technicians),
`stripe_customer_id` / `stripe_subscription_id` (users), and
`payment_status` / `payment_intent_id` / `paid_at` (appointments).

---

## Step 2 — Get your Stripe Secret Key

1. Stripe Dashboard → **Developers → API keys**
2. Confirm you're in **Live mode** (toggle top-right)
3. Copy the **Secret key** (starts with `sk_live_...`)
4. Keep this safe — you'll paste it into Render's environment variables in
   Step 5, never into Shopify or anywhere public.

---

## Step 3 — Get your Supabase Service Role Key

1. Supabase → **Settings → API**
2. Scroll to **Project API keys**
3. Copy the **`service_role`** key (NOT the `anon` key — this one is
   different and much more powerful, starts with `eyJ...`)

This key lets the backend write data even where Row Level Security would
normally block it. Never put this key in theme.liquid or any browser code.

---

## Step 4 — Deploy the backend to Render.com

1. Go to **[render.com](https://render.com)** → sign up free
2. Click **New → Web Service**
3. You'll need this code in a GitHub repo first:
   - Create a new repo on GitHub (e.g. `uea-backend`)
   - Upload all the files from this backend folder (`package.json`,
     `src/server.js`, this guide) — drag and drop works fine on GitHub's
     web UI, no command line needed
4. Back in Render, connect that GitHub repo
5. Configure the service:
   - **Name**: `uea-backend` (or anything)
   - **Region**: closest to Austin, TX (e.g. US East)
   - **Branch**: `main`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
6. Under **Environment Variables**, add each of these (click "Add Environment Variable" for each):

   | Key | Value |
   |---|---|
   | `STRIPE_SECRET_KEY` | Your `sk_live_...` key from Step 2 |
   | `SUPABASE_URL` | `https://vdhcnrnubcdbzpxwthro.supabase.co` |
   | `SUPABASE_SERVICE_KEY` | Your service_role key from Step 3 |
   | `ALLOWED_ORIGIN` | `https://upperechelonautomotive.com` (your actual Shopify domain) |
   | `ADMIN_PIN` | `UEA2025` (same PIN used in your theme) |
   | `TECH_PAYOUT_PCT` | `65` |
   | `MEMBERSHIP_PRICE_CENTS` | `1999` |
   | `STRIPE_WEBHOOK_SECRET` | Leave blank for now — you'll add this in Step 6 |

7. Click **Create Web Service**
8. Wait for it to deploy (a few minutes). Once live, you'll get a URL like:
   `https://uea-backend.onrender.com`
9. Visit that URL in your browser — you should see:
   ```json
   {"status":"ok","service":"Upper Echelon Automotive Backend","time":"..."}
   ```
   If you see that, the backend is live and working.

**Note on Render's free tier:** free services "sleep" after 15 minutes of no
traffic and take ~30 seconds to wake up on the next request. This means the
very first payment attempt after idle time might feel slow. If this becomes
a problem, Render's $7/mo tier removes the sleep behavior.

---

## Step 5 — Set up the Stripe Webhook

This is what tells your database "the payment actually succeeded" — without
it, charges happen in Stripe but your site never finds out.

1. Stripe Dashboard → **Developers → Webhooks**
2. Click **Add endpoint**
3. **Endpoint URL**: `https://uea-backend.onrender.com/webhook` (use your
   actual Render URL from Step 4)
4. **Events to send** — click "Select events" and check:
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
   - `invoice.payment_succeeded`
   - `invoice.payment_failed`
   - `customer.subscription.deleted`
   - `account.updated`
5. Click **Add endpoint**
6. On the endpoint's detail page, click **Reveal** next to "Signing secret"
7. Copy that value (starts with `whsec_...`)
8. Go back to Render → your service → **Environment** → edit
   `STRIPE_WEBHOOK_SECRET` → paste this value → save (Render will
   auto-redeploy)

---

## Step 6 — Confirm everything is connected

Once Steps 1–5 are done, you have a live backend ready to accept requests.
The next message will cover wiring the actual theme.liquid frontend to call
these new endpoints — that's a separate, final step so we can test each
piece in isolation first.

**Before moving on, confirm:**
- [ ] Database migration ran successfully
- [ ] Backend URL responds with the health check JSON
- [ ] Webhook shows "Success" status in Stripe's webhook log (you can send
      a test event from the webhook's detail page in Stripe to confirm)

Let me know once these are checked off, and I'll build the frontend
integration next — the actual "Pay Now" button, the Stripe card form, the
technician "Set Up Payouts" button, and the membership checkout flow.
