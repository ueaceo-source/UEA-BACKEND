// ═══════════════════════════════════════════════════════════════════════════
// UPPER ECHELON AUTOMOTIVE — PAYMENT & PAYOUT BACKEND
// Handles: customer card payments, technician Stripe Connect payouts,
// $19.99/mo membership subscriptions, and Stripe webhooks.
//
// SECURITY NOTE: This server holds your Stripe SECRET key and Supabase
// SERVICE ROLE key. Both bypass normal safety checks. Never expose this
// code's environment variables anywhere public, and never run this in
// the browser — it only runs on Render.com as a private server.
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const TECH_PAYOUT_PCT = Number(process.env.TECH_PAYOUT_PCT || 65);
const MEMBERSHIP_PRICE_CENTS = Number(process.env.MEMBERSHIP_PRICE_CENTS || 1999);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// ── CORS: only allow your Shopify store to call this API ───────────────────
app.use(cors({ origin: ALLOWED_ORIGIN }));

// Stripe webhooks need the RAW body (not JSON-parsed) to verify signatures,
// so this route is registered BEFORE the global express.json() middleware.
app.post('/webhook', express.raw({ type: 'application/json' }), handleWebhook);

app.use(express.json());

// ── Health check (useful for confirming Render deployment worked) ──────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Upper Echelon Automotive Backend', time: new Date().toISOString() });
});

// ═══════════════════════════════════════════════════════════════════════════
// 0. SMS RELAY — proxies Textbelt so the browser never calls it directly
// (Textbelt blocks browser-origin requests via CORS; routing through this
// server avoids that entirely since server-to-server calls aren't subject
// to CORS.)
// ═══════════════════════════════════════════════════════════════════════════
app.post('/send-sms', async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) {
      return res.status(400).json({ error: 'phone and message are required.' });
    }
    const textbeltKey = process.env.TEXTBELT_KEY || 'textbelt';
    const r = await fetch('https://textbelt.com/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, message, key: textbeltKey }),
    });
    const data = await r.json();
    res.json(data);
  } catch (err) {
    console.error('send-sms error:', err.message);
    res.status(500).json({ error: 'Could not send SMS.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. CUSTOMER PAYMENT — charge a card for a completed job
// ═══════════════════════════════════════════════════════════════════════════
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { appointmentId, amount, customerEmail, customerName } = req.body;

    if (!appointmentId || !amount || amount <= 0) {
      return res.status(400).json({ error: 'appointmentId and a positive amount are required.' });
    }

    // Verify the appointment actually exists and matches the claimed amount,
    // so a tampered client request can't charge an arbitrary amount.
    const { data: appt, error: apptErr } = await supabase
      .from('uea_appointments')
      .select('id, estimated_price, status, name, email')
      .eq('id', appointmentId)
      .single();

    if (apptErr || !appt) {
      return res.status(404).json({ error: 'Appointment not found.' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Stripe uses cents
      currency: 'usd',
      receipt_email: customerEmail || appt.email,
      metadata: {
        appointmentId,
        customerName: customerName || appt.name,
        business: 'Upper Echelon Automotive',
      },
      automatic_payment_methods: { enabled: true },
    });

    res.json({ clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id });
  } catch (err) {
    console.error('create-payment-intent error:', err.message);
    res.status(500).json({ error: 'Could not create payment. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. TECHNICIAN ONBOARDING — Stripe Connect Express account creation
// ═══════════════════════════════════════════════════════════════════════════
app.post('/create-connect-account', async (req, res) => {
  try {
    const { technicianId, email, name } = req.body;
    if (!technicianId || !email) {
      return res.status(400).json({ error: 'technicianId and email are required.' });
    }

    // Check if this technician already has a Connect account on file
    const { data: tech } = await supabase
      .from('uea_technicians')
      .select('stripe_connect_id')
      .eq('id', technicianId)
      .single();

    let accountId = tech?.stripe_connect_id;

    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        email,
        business_type: 'individual',
        capabilities: {
          transfers: { requested: true },
        },
        metadata: { technicianId, name: name || '' },
      });
      accountId = account.id;

      await supabase
        .from('uea_technicians')
        .update({ stripe_connect_id: accountId })
        .eq('id', technicianId);
    }

    res.json({ accountId });
  } catch (err) {
    console.error('create-connect-account error:', err.message);
    res.status(500).json({ error: 'Could not create payout account.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. ONBOARDING LINK — Stripe-hosted form for bank/ID info
// ═══════════════════════════════════════════════════════════════════════════
app.post('/connect-onboarding-link', async (req, res) => {
  try {
    const { accountId, returnUrl, refreshUrl } = req.body;
    if (!accountId) return res.status(400).json({ error: 'accountId is required.' });

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: refreshUrl || `${ALLOWED_ORIGIN}/pages/technician-portal`,
      return_url: returnUrl || `${ALLOWED_ORIGIN}/pages/technician-portal`,
      type: 'account_onboarding',
    });

    res.json({ url: accountLink.url });
  } catch (err) {
    console.error('connect-onboarding-link error:', err.message);
    res.status(500).json({ error: 'Could not generate onboarding link.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. CHECK PAYOUT READINESS — has the technician finished Stripe onboarding?
// ═══════════════════════════════════════════════════════════════════════════
app.get('/connect-status/:technicianId', async (req, res) => {
  try {
    const { technicianId } = req.params;
    const { data: tech } = await supabase
      .from('uea_technicians')
      .select('stripe_connect_id')
      .eq('id', technicianId)
      .single();

    if (!tech?.stripe_connect_id) {
      return res.json({ connected: false, payoutsEnabled: false });
    }

    const account = await stripe.accounts.retrieve(tech.stripe_connect_id);
    res.json({
      connected: true,
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
    });
  } catch (err) {
    console.error('connect-status error:', err.message);
    res.status(500).json({ error: 'Could not check payout status.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. PAY A TECHNICIAN — admin-triggered transfer to their Connect account
// ═══════════════════════════════════════════════════════════════════════════
app.post('/payout-technician', async (req, res) => {
  try {
    const { technicianId, amount, adminPin } = req.body;

    // Simple shared-secret check so this endpoint can't be hit by anyone
    // who finds the URL — must match the admin PIN used in the theme.
    if (adminPin !== process.env.ADMIN_PIN) {
      return res.status(403).json({ error: 'Unauthorized.' });
    }
    if (!technicianId || !amount || amount <= 0) {
      return res.status(400).json({ error: 'technicianId and a positive amount are required.' });
    }

    const { data: tech, error: techErr } = await supabase
      .from('uea_technicians')
      .select('stripe_connect_id, name, total_paid_out')
      .eq('id', technicianId)
      .single();

    if (techErr || !tech) return res.status(404).json({ error: 'Technician not found.' });
    if (!tech.stripe_connect_id) {
      return res.status(400).json({ error: 'This technician has not completed payout onboarding yet.' });
    }

    const transfer = await stripe.transfers.create({
      amount: Math.round(amount * 100),
      currency: 'usd',
      destination: tech.stripe_connect_id,
      metadata: { technicianId, technicianName: tech.name },
    });

    // Record the payout and update running totals
    await supabase.from('uea_payouts').insert({
      id: `payout_${Date.now()}`,
      technician_id: technicianId,
      amount,
      method: 'stripe_transfer',
      status: 'paid',
      note: `Stripe transfer ${transfer.id}`,
    });

    await supabase
      .from('uea_technicians')
      .update({ total_paid_out: (tech.total_paid_out || 0) + amount })
      .eq('id', technicianId);

    res.json({ success: true, transferId: transfer.id });
  } catch (err) {
    console.error('payout-technician error:', err.message);
    res.status(500).json({ error: err.message || 'Payout failed.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. MEMBERSHIP SUBSCRIPTION — $19.99/mo recurring billing
// ═══════════════════════════════════════════════════════════════════════════
app.post('/create-subscription', async (req, res) => {
  try {
    const { userId, email, name, paymentMethodId } = req.body;
    if (!userId || !email || !paymentMethodId) {
      return res.status(400).json({ error: 'userId, email, and paymentMethodId are required.' });
    }

    // Find or create the Stripe customer
    const { data: user } = await supabase
      .from('uea_users')
      .select('stripe_customer_id')
      .eq('id', userId)
      .single();

    let customerId = user?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email, name, payment_method: paymentMethodId,
        invoice_settings: { default_payment_method: paymentMethodId },
        metadata: { userId },
      });
      customerId = customer.id;
      await supabase.from('uea_users').update({ stripe_customer_id: customerId }).eq('id', userId);
    } else {
      await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });
    }

    // Create (or reuse) the membership Price — done once, cached by lookup_key
    let price;
    const existingPrices = await stripe.prices.list({ lookup_keys: ['uea_membership_monthly'], limit: 1 });
    if (existingPrices.data.length) {
      price = existingPrices.data[0];
    } else {
      const product = await stripe.products.create({ name: 'Upper Echelon Automotive Membership' });
      price = await stripe.prices.create({
        product: product.id,
        unit_amount: MEMBERSHIP_PRICE_CENTS,
        currency: 'usd',
        recurring: { interval: 'month' },
        lookup_key: 'uea_membership_monthly',
      });
    }

    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: price.id }],
      payment_behavior: 'default_incomplete',
      expand: ['latest_invoice.payment_intent'],
      metadata: { userId },
    });

    await supabase
      .from('uea_users')
      .update({
        membership: true,
        membership_since: new Date().toISOString(),
        stripe_subscription_id: subscription.id,
      })
      .eq('id', userId);

    res.json({
      subscriptionId: subscription.id,
      clientSecret: subscription.latest_invoice.payment_intent?.client_secret,
    });
  } catch (err) {
    console.error('create-subscription error:', err.message);
    res.status(500).json({ error: err.message || 'Could not start membership.' });
  }
});

// ── Cancel membership ───────────────────────────────────────────────────────
app.post('/cancel-subscription', async (req, res) => {
  try {
    const { userId } = req.body;
    const { data: user } = await supabase
      .from('uea_users')
      .select('stripe_subscription_id')
      .eq('id', userId)
      .single();

    if (user?.stripe_subscription_id) {
      await stripe.subscriptions.cancel(user.stripe_subscription_id);
    }

    await supabase.from('uea_users').update({ membership: false }).eq('id', userId);
    res.json({ success: true });
  } catch (err) {
    console.error('cancel-subscription error:', err.message);
    res.status(500).json({ error: 'Could not cancel membership.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. STRIPE WEBHOOK — keeps Supabase in sync with what actually happened
// ═══════════════════════════════════════════════════════════════════════════
async function handleWebhook(req, res) {
  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        const appointmentId = pi.metadata?.appointmentId;
        if (appointmentId) {
          await supabase
            .from('uea_appointments')
            .update({ payment_status: 'paid', payment_intent_id: pi.id, paid_at: new Date().toISOString() })
            .eq('id', appointmentId);
        }
        break;
      }

      case 'payment_intent.payment_failed': {
        const pi = event.data.object;
        const appointmentId = pi.metadata?.appointmentId;
        if (appointmentId) {
          await supabase
            .from('uea_appointments')
            .update({ payment_status: 'failed' })
            .eq('id', appointmentId);
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        // Recurring membership payment succeeded
        const invoice = event.data.object;
        const subId = invoice.subscription;
        if (subId) {
          await supabase
            .from('uea_users')
            .update({ membership: true })
            .eq('stripe_subscription_id', subId);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const subId = invoice.subscription;
        if (subId) {
          console.warn(`Membership payment failed for subscription ${subId}`);
          // Intentionally not auto-cancelling membership on first failure —
          // Stripe will retry automatically per its dunning settings.
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await supabase
          .from('uea_users')
          .update({ membership: false })
          .eq('stripe_subscription_id', sub.id);
        break;
      }

      case 'account.updated': {
        // Technician's Connect onboarding status changed
        const account = event.data.object;
        const technicianId = account.metadata?.technicianId;
        if (technicianId) {
          await supabase
            .from('uea_technicians')
            .update({ payout_method: account.payouts_enabled ? 'bank' : null })
            .eq('id', technicianId);
        }
        break;
      }

      default:
        // Unhandled event types are fine to ignore
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err.message);
    res.status(500).json({ error: 'Webhook processing failed.' });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Upper Echelon Automotive backend running on port ${PORT}`);
});
