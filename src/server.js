'use strict';
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const multer = require('multer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Stripe ──────────────────────────────────────────────────────────────────
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ── Supabase ─────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY   // service key for storage uploads
);

// ── Nodemailer (Gmail / Google Workspace) ────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_FROM,          // ueaceo@ueauto.store
    pass: process.env.GMAIL_APP_PASSWORD,  // 16-char app password
  },
});

async function sendEmail({ to, subject, html, text }) {
  try {
    await transporter.sendMail({
      from: `"Upper Echelon Automotive" <${process.env.EMAIL_FROM}>`,
      to,
      subject,
      html,
      text,
    });
    console.log(`[Email] Sent to ${to}: ${subject}`);
  } catch (err) {
    console.error('[Email] Failed:', err.message);
  }
}

// ── Email Templates ──────────────────────────────────────────────────────────
const EMAIL = {
  // Shared header/footer
  wrap(body) {
    return `
    <div style="font-family:Inter,sans-serif;background:#0A0A0F;color:#F5F0E8;max-width:600px;margin:0 auto;padding:32px 24px;border-radius:12px;">
      <div style="text-align:center;margin-bottom:28px;">
        <p style="font-family:serif;font-size:22px;color:#C9A84C;font-weight:700;margin:0;">UPPER ECHELON AUTOMOTIVE</p>
        <p style="font-size:11px;color:rgba(245,240,232,0.5);letter-spacing:0.15em;text-transform:uppercase;margin:4px 0 0;">Austin's Mobile Diagnostic Specialist</p>
      </div>
      ${body}
      <div style="border-top:1px solid rgba(201,168,76,0.2);margin-top:32px;padding-top:20px;text-align:center;">
        <p style="font-size:12px;color:rgba(245,240,232,0.4);margin:0;">Upper Echelon Automotive · Austin, TX · (251) 289-0740</p>
        <p style="font-size:12px;color:rgba(245,240,232,0.4);margin:4px 0 0;">ueauto.store</p>
      </div>
    </div>`;
  },

  bookingCustomer({ name, vehicle, service, date, time, location, rush }) {
    return this.wrap(`
      <h2 style="color:#C9A84C;font-size:20px;margin:0 0 16px;">Booking Request Received ✓</h2>
      <p style="color:rgba(245,240,232,0.8);margin:0 0 20px;">Hi ${name}, we received your booking request. We'll review and confirm shortly — you'll get another email once it's approved.</p>
      <div style="background:rgba(201,168,76,0.08);border:1px solid rgba(201,168,76,0.25);border-radius:8px;padding:20px;margin-bottom:20px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;width:40%;">Vehicle</td><td style="padding:6px 0;color:#F5F0E8;font-size:13px;">${vehicle}</td></tr>
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;">Service</td><td style="padding:6px 0;color:#F5F0E8;font-size:13px;">${service}</td></tr>
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;">Date</td><td style="padding:6px 0;color:#F5F0E8;font-size:13px;">${date}</td></tr>
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;">Time</td><td style="padding:6px 0;color:#F5F0E8;font-size:13px;">${time}</td></tr>
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;">Location</td><td style="padding:6px 0;color:#F5F0E8;font-size:13px;">${location}</td></tr>
          ${rush ? `<tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;">Rush</td><td style="padding:6px 0;color:#fbbf24;font-size:13px;">Yes (+$100 rush fee)</td></tr>` : ''}
        </table>
      </div>
      <p style="color:rgba(245,240,232,0.6);font-size:13px;">Questions? Call or text us at (251) 289-0740.</p>
    `);
  },

  bookingAdmin({ name, email, phone, vehicle, service, date, time, location, rush, estimatedPrice }) {
    return this.wrap(`
      <h2 style="color:#C9A84C;font-size:20px;margin:0 0 16px;">🔔 New Booking — Action Required</h2>
      <div style="background:rgba(201,168,76,0.08);border:1px solid rgba(201,168,76,0.25);border-radius:8px;padding:20px;margin-bottom:20px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;width:40%;">Customer</td><td style="padding:6px 0;color:#F5F0E8;font-size:13px;">${name}</td></tr>
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;">Email</td><td style="padding:6px 0;color:#F5F0E8;font-size:13px;">${email}</td></tr>
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;">Phone</td><td style="padding:6px 0;color:#F5F0E8;font-size:13px;">${phone}</td></tr>
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;">Vehicle</td><td style="padding:6px 0;color:#F5F0E8;font-size:13px;">${vehicle}</td></tr>
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;">Service</td><td style="padding:6px 0;color:#F5F0E8;font-size:13px;">${service}</td></tr>
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;">Date</td><td style="padding:6px 0;color:#F5F0E8;font-size:13px;">${date}</td></tr>
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;">Time</td><td style="padding:6px 0;color:#F5F0E8;font-size:13px;">${time}</td></tr>
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;">Location</td><td style="padding:6px 0;color:#F5F0E8;font-size:13px;">${location}</td></tr>
          ${rush ? `<tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;">Rush</td><td style="padding:6px 0;color:#fbbf24;font-size:13px;">RUSH JOB</td></tr>` : ''}
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;">Estimate</td><td style="padding:6px 0;color:#4ade80;font-size:13px;font-weight:700;">$${(estimatedPrice||0).toFixed(2)}</td></tr>
        </table>
      </div>
      <p style="color:rgba(245,240,232,0.7);font-size:13px;"><strong style="color:#C9A84C;">⚠ Payment has been collected upfront.</strong> Log in to your admin portal at ueauto.store to approve and assign this job.</p>
    `);
  },

  accountWelcome({ name }) {
    return this.wrap(`
      <h2 style="color:#C9A84C;font-size:20px;margin:0 0 16px;">Welcome to Upper Echelon Automotive 👑</h2>
      <p style="color:rgba(245,240,232,0.8);margin:0 0 16px;">Hi ${name}, your account has been created and you've earned <strong style="color:#C9A84C;">100 welcome points!</strong></p>
      <p style="color:rgba(245,240,232,0.8);margin:0 0 20px;">Log in at <a href="https://ueauto.store" style="color:#C9A84C;">ueauto.store</a> to book service, track your appointments, and redeem your rewards.</p>
    `);
  },

  appointmentApproved({ name, vehicle, service, date, time, location, adminNote }) {
    return this.wrap(`
      <h2 style="color:#4ade80;font-size:20px;margin:0 0 16px;">Your Appointment is Confirmed ✓</h2>
      <p style="color:rgba(245,240,232,0.8);margin:0 0 20px;">Hi ${name}, great news — your appointment has been confirmed!</p>
      <div style="background:rgba(74,222,128,0.08);border:1px solid rgba(74,222,128,0.25);border-radius:8px;padding:20px;margin-bottom:20px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;width:40%;">Vehicle</td><td style="padding:6px 0;color:#F5F0E8;font-size:13px;">${vehicle}</td></tr>
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;">Service</td><td style="padding:6px 0;color:#F5F0E8;font-size:13px;">${service}</td></tr>
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;">Date</td><td style="padding:6px 0;color:#F5F0E8;font-size:13px;">${date}</td></tr>
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;">Time</td><td style="padding:6px 0;color:#F5F0E8;font-size:13px;">${time}</td></tr>
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;">Location</td><td style="padding:6px 0;color:#F5F0E8;font-size:13px;">${location}</td></tr>
        </table>
      </div>
      ${adminNote ? `<div style="background:rgba(201,168,76,0.08);border-left:3px solid #C9A84C;padding:12px 16px;border-radius:0 8px 8px 0;margin-bottom:20px;"><p style="color:#C9A84C;font-size:13px;margin:0;"><strong>Note from Robert:</strong> ${adminNote}</p></div>` : ''}
      <p style="color:rgba(245,240,232,0.6);font-size:13px;">Questions? Call or text (251) 289-0740.</p>
    `);
  },

  appointmentComplete({ name, vehicle, service, pointsEarned, reviewLink }) {
    return this.wrap(`
      <h2 style="color:#C9A84C;font-size:20px;margin:0 0 16px;">Service Complete — Thank You! 🎉</h2>
      <p style="color:rgba(245,240,232,0.8);margin:0 0 16px;">Hi ${name}, your service has been completed. Thank you for choosing Upper Echelon Automotive!</p>
      <div style="background:rgba(201,168,76,0.08);border:1px solid rgba(201,168,76,0.25);border-radius:8px;padding:20px;margin-bottom:20px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;width:40%;">Vehicle</td><td style="padding:6px 0;color:#F5F0E8;font-size:13px;">${vehicle}</td></tr>
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;">Service</td><td style="padding:6px 0;color:#F5F0E8;font-size:13px;">${service}</td></tr>
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;">Points Earned</td><td style="padding:6px 0;color:#4ade80;font-size:13px;font-weight:700;">+${pointsEarned} pts</td></tr>
        </table>
      </div>
      <div style="text-align:center;margin-top:24px;">
        <a href="${reviewLink}" style="display:inline-block;background:#C9A84C;color:#0A0A0F;padding:12px 28px;border-radius:6px;font-weight:700;text-decoration:none;font-size:14px;">⭐ Leave a Review</a>
      </div>
    `);
  },

  techWelcome({ name, pin }) {
    return this.wrap(`
      <h2 style="color:#C9A84C;font-size:20px;margin:0 0 16px;">Welcome to the UEA Technician Network 🔧</h2>
      <p style="color:rgba(245,240,232,0.8);margin:0 0 16px;">Hi ${name}, you've been added to the Upper Echelon Automotive technician network!</p>
      <div style="background:rgba(201,168,76,0.08);border:1px solid rgba(201,168,76,0.25);border-radius:8px;padding:20px;margin-bottom:20px;">
        <p style="color:rgba(245,240,232,0.5);font-size:13px;margin:0 0 4px;">Your Login</p>
        <p style="color:#F5F0E8;font-size:15px;margin:0;"><strong>Name:</strong> ${name}</p>
        <p style="color:#F5F0E8;font-size:15px;margin:4px 0 0;"><strong>PIN:</strong> <span style="color:#C9A84C;font-family:monospace;font-size:18px;">${pin}</span></p>
      </div>
      <p style="color:rgba(245,240,232,0.7);font-size:13px;">Log in at <a href="https://ueauto.store" style="color:#C9A84C;">ueauto.store</a> and complete your verification documents (ID, selfie, insurance, equipment photos) before you can start accepting jobs.</p>
    `);
  },

  techVerificationUpdate({ name, status }) {
    const approved = status === 'verified';
    return this.wrap(`
      <h2 style="color:${approved ? '#4ade80' : '#f87171'};font-size:20px;margin:0 0 16px;">
        ${approved ? '✓ Verification Approved!' : '✗ Verification Update'}
      </h2>
      <p style="color:rgba(245,240,232,0.8);margin:0 0 16px;">Hi ${name},</p>
      ${approved
        ? `<p style="color:rgba(245,240,232,0.8);margin:0 0 16px;">Your verification has been <strong style="color:#4ade80;">approved</strong>! You can now log in and start accepting jobs.</p>`
        : `<p style="color:rgba(245,240,232,0.8);margin:0 0 16px;">Your verification documents need attention. Please log in and resubmit your documents, then contact Robert at (251) 289-0740 for next steps.</p>`
      }
      <div style="text-align:center;margin-top:24px;">
        <a href="https://ueauto.store" style="display:inline-block;background:#C9A84C;color:#0A0A0F;padding:12px 28px;border-radius:6px;font-weight:700;text-decoration:none;font-size:14px;">Log In to Portal</a>
      </div>
    `);
  },

  newJobAlert({ techName, service, vehicle, date, time, location, emergency }) {
    return this.wrap(`
      <h2 style="color:#C9A84C;font-size:20px;margin:0 0 16px;">🔧 New Job Available!</h2>
      ${emergency ? `<div style="background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.4);border-radius:6px;padding:10px 14px;margin-bottom:16px;"><p style="color:#f87171;font-weight:700;margin:0;">⚠ EMERGENCY JOB</p></div>` : ''}
      <p style="color:rgba(245,240,232,0.8);margin:0 0 20px;">Hi ${techName}, a new job is available. Claim it before another technician does!</p>
      <div style="background:rgba(201,168,76,0.08);border:1px solid rgba(201,168,76,0.25);border-radius:8px;padding:20px;margin-bottom:20px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;width:40%;">Service</td><td style="padding:6px 0;color:#F5F0E8;font-size:13px;">${service}</td></tr>
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;">Vehicle</td><td style="padding:6px 0;color:#F5F0E8;font-size:13px;">${vehicle}</td></tr>
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;">Date</td><td style="padding:6px 0;color:#F5F0E8;font-size:13px;">${date}</td></tr>
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;">Time</td><td style="padding:6px 0;color:#F5F0E8;font-size:13px;">${time}</td></tr>
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;">Location</td><td style="padding:6px 0;color:#F5F0E8;font-size:13px;">${location}</td></tr>
        </table>
      </div>
      <div style="text-align:center;">
        <a href="https://ueauto.store" style="display:inline-block;background:#C9A84C;color:#0A0A0F;padding:12px 28px;border-radius:6px;font-weight:700;text-decoration:none;font-size:14px;">Claim This Job →</a>
      </div>
    `);
  },

  techJobAssigned({ techName, customerName, vehicle, service, date, time, location }) {
    return this.wrap(`
      <h2 style="color:#4ade80;font-size:20px;margin:0 0 16px;">✓ Job Assigned to You</h2>
      <p style="color:rgba(245,240,232,0.8);margin:0 0 20px;">Hi ${techName}, you've been assigned the following job:</p>
      <div style="background:rgba(74,222,128,0.08);border:1px solid rgba(74,222,128,0.25);border-radius:8px;padding:20px;margin-bottom:20px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;width:40%;">Customer</td><td style="padding:6px 0;color:#F5F0E8;font-size:13px;">${customerName}</td></tr>
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;">Vehicle</td><td style="padding:6px 0;color:#F5F0E8;font-size:13px;">${vehicle}</td></tr>
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;">Service</td><td style="padding:6px 0;color:#F5F0E8;font-size:13px;">${service}</td></tr>
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;">Date</td><td style="padding:6px 0;color:#F5F0E8;font-size:13px;">${date}</td></tr>
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;">Time</td><td style="padding:6px 0;color:#F5F0E8;font-size:13px;">${time}</td></tr>
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;">Location</td><td style="padding:6px 0;color:#F5F0E8;font-size:13px;">${location}</td></tr>
        </table>
      </div>
    `);
  },

  techPaid({ techName, amount, jobService }) {
    return this.wrap(`
      <h2 style="color:#4ade80;font-size:20px;margin:0 0 16px;">💰 Payment Sent!</h2>
      <p style="color:rgba(245,240,232,0.8);margin:0 0 16px;">Hi ${techName}, your payment has been sent for the following job:</p>
      <div style="background:rgba(74,222,128,0.08);border:1px solid rgba(74,222,128,0.25);border-radius:8px;padding:20px;margin-bottom:20px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;width:40%;">Service</td><td style="padding:6px 0;color:#F5F0E8;font-size:13px;">${jobService}</td></tr>
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;">Amount</td><td style="padding:6px 0;color:#4ade80;font-size:18px;font-weight:700;">$${Number(amount).toFixed(2)}</td></tr>
        </table>
      </div>
      <p style="color:rgba(245,240,232,0.6);font-size:13px;">Funds will appear in your Stripe account within 2–7 business days depending on your bank.</p>
    `);
  },

  fleetWelcome({ contactName, companyName }) {
    return this.wrap(`
      <h2 style="color:#C9A84C;font-size:20px;margin:0 0 16px;">Fleet Account Created</h2>
      <p style="color:rgba(245,240,232,0.8);margin:0 0 16px;">Hi ${contactName}, your fleet account for <strong>${companyName}</strong> has been set up!</p>
      <p style="color:rgba(245,240,232,0.7);font-size:13px;">Log in at <a href="https://ueauto.store" style="color:#C9A84C;">ueauto.store</a> to manage your vehicles and request service.</p>
    `);
  },

  towWelcome({ contactName, companyName, pin }) {
    return this.wrap(`
      <h2 style="color:#C9A84C;font-size:20px;margin:0 0 16px;">Welcome to the UEA Tow Network</h2>
      <p style="color:rgba(245,240,232,0.8);margin:0 0 16px;">Hi ${contactName}, <strong>${companyName}</strong> has been added as a tow partner!</p>
      <div style="background:rgba(201,168,76,0.08);border:1px solid rgba(201,168,76,0.25);border-radius:8px;padding:20px;margin-bottom:20px;">
        <p style="color:rgba(245,240,232,0.5);font-size:13px;margin:0 0 4px;">Your Login PIN</p>
        <p style="color:#C9A84C;font-family:monospace;font-size:24px;font-weight:700;margin:0;">${pin}</p>
      </div>
      <p style="color:rgba(245,240,232,0.7);font-size:13px;">Log in at <a href="https://ueauto.store" style="color:#C9A84C;">ueauto.store</a> to start accepting tow requests.</p>
    `);
  },

  newTowAlert({ contactName, customerName, pickupLocation, vehicle }) {
    return this.wrap(`
      <h2 style="color:#C9A84C;font-size:20px;margin:0 0 16px;">🚨 New Tow Request</h2>
      <p style="color:rgba(245,240,232,0.8);margin:0 0 20px;">Hi ${contactName}, a new tow request is available to claim!</p>
      <div style="background:rgba(201,168,76,0.08);border:1px solid rgba(201,168,76,0.25);border-radius:8px;padding:20px;margin-bottom:20px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;width:40%;">Customer</td><td style="padding:6px 0;color:#F5F0E8;font-size:13px;">${customerName}</td></tr>
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;">Vehicle</td><td style="padding:6px 0;color:#F5F0E8;font-size:13px;">${vehicle || 'N/A'}</td></tr>
          <tr><td style="padding:6px 0;color:rgba(245,240,232,0.5);font-size:13px;">Pickup</td><td style="padding:6px 0;color:#F5F0E8;font-size:13px;">${pickupLocation}</td></tr>
        </table>
      </div>
      <div style="text-align:center;">
        <a href="https://ueauto.store" style="display:inline-block;background:#C9A84C;color:#0A0A0F;padding:12px 28px;border-radius:6px;font-weight:700;text-decoration:none;font-size:14px;">Claim Tow Request →</a>
      </div>
    `);
  },

  adminVerificationAlert({ techName, techId }) {
    return this.wrap(`
      <h2 style="color:#C9A84C;font-size:20px;margin:0 0 16px;">📋 New Technician Verification Submitted</h2>
      <p style="color:rgba(245,240,232,0.8);margin:0 0 16px;"><strong>${techName}</strong> has submitted their verification documents for review.</p>
      <div style="text-align:center;margin-top:24px;">
        <a href="https://ueauto.store" style="display:inline-block;background:#C9A84C;color:#0A0A0F;padding:12px 28px;border-radius:6px;font-weight:700;text-decoration:none;font-size:14px;">Review in Admin Portal →</a>
      </div>
    `);
  },
};

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Multer (in-memory for Supabase upload) ────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB max
  fileFilter(req, file, cb) {
    const allowed = /jpg|jpeg|png|gif|webp|mp4|mov|pdf/;
    const ext = path.extname(file.originalname).toLowerCase().slice(1);
    cb(null, allowed.test(ext));
  },
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));

// ════════════════════════════════════════════════════════════════════════════════
// EMAIL ROUTES
// ════════════════════════════════════════════════════════════════════════════════

// Send booking confirmation (customer + admin)
app.post('/send-email/booking', async (req, res) => {
  try {
    const a = req.body;
    const adminEmail = process.env.ADMIN_EMAIL || 'ueaceo@ueauto.store';

    if (a.email) {
      await sendEmail({
        to: a.email,
        subject: 'Booking Request Received — Upper Echelon Automotive',
        html: EMAIL.bookingCustomer(a),
      });
    }
    await sendEmail({
      to: adminEmail,
      subject: `🔔 New Booking — ${a.name} | ${a.service}`,
      html: EMAIL.bookingAdmin(a),
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Send appointment approved email
app.post('/send-email/approved', async (req, res) => {
  try {
    const a = req.body;
    if (a.email) {
      await sendEmail({
        to: a.email,
        subject: 'Your Appointment is Confirmed ✓ — Upper Echelon Automotive',
        html: EMAIL.appointmentApproved(a),
      });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Send job completed email
app.post('/send-email/completed', async (req, res) => {
  try {
    const a = req.body;
    if (a.email) {
      await sendEmail({
        to: a.email,
        subject: 'Service Complete — Thank You! — Upper Echelon Automotive',
        html: EMAIL.appointmentComplete(a),
      });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// New job alert to all eligible technicians
app.post('/send-email/new-job-alert', async (req, res) => {
  try {
    const { appt, technicians } = req.body;
    const eligible = (technicians || []).filter(t => t.email && t.active !== false && t.jobEligible !== false);
    for (const tech of eligible) {
      await sendEmail({
        to: tech.email,
        subject: `🔧 New Job Available — ${appt.service}`,
        html: EMAIL.newJobAlert({ techName: tech.name, ...appt }),
      });
    }
    res.json({ ok: true, sent: eligible.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Job assigned to specific technician
app.post('/send-email/job-assigned', async (req, res) => {
  try {
    const { tech, appt } = req.body;
    if (tech?.email) {
      await sendEmail({
        to: tech.email,
        subject: `✓ Job Assigned — ${appt.service} on ${appt.date}`,
        html: EMAIL.techJobAssigned({ techName: tech.name, ...appt }),
      });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Technician paid notification
app.post('/send-email/tech-paid', async (req, res) => {
  try {
    const { tech, amount, jobService } = req.body;
    if (tech?.email) {
      await sendEmail({
        to: tech.email,
        subject: `💰 Payment Sent — $${Number(amount).toFixed(2)}`,
        html: EMAIL.techPaid({ techName: tech.name, amount, jobService }),
      });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Technician welcome
app.post('/send-email/tech-welcome', async (req, res) => {
  try {
    const { name, email, pin } = req.body;
    if (email) {
      await sendEmail({
        to: email,
        subject: 'Welcome to the UEA Technician Network',
        html: EMAIL.techWelcome({ name, pin }),
      });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Technician verification status update
app.post('/send-email/tech-verification', async (req, res) => {
  try {
    const { name, email, status } = req.body;
    const adminEmail = process.env.ADMIN_EMAIL || 'ueaceo@ueauto.store';
    if (status === 'pending') {
      // Docs submitted — notify admin
      await sendEmail({
        to: adminEmail,
        subject: `📋 Verification Submitted — ${name}`,
        html: EMAIL.adminVerificationAlert({ techName: name }),
      });
    } else {
      // Approved or rejected — notify tech
      if (email) {
        await sendEmail({
          to: email,
          subject: status === 'verified' ? '✓ Verification Approved — You Can Now Accept Jobs!' : 'Verification Update — Upper Echelon Automotive',
          html: EMAIL.techVerificationUpdate({ name, status }),
        });
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Fleet account approved by admin
app.post('/send-email/fleet-approved', async (req, res) => {
  try {
    const { contactName, companyName, email, planName } = req.body;
    if (email) {
      await sendEmail({
        to: email,
        subject: `✓ Fleet Account Approved — Upper Echelon Automotive`,
        html: EMAIL.wrap(`
          <h2 style="color:#4ade80;font-size:20px;margin:0 0 16px;">Fleet Account Approved ✓</h2>
          <p style="color:rgba(245,240,232,.8);margin:0 0 16px;">Hi ${contactName}, great news — <strong>${companyName}</strong> has been approved for a fleet account with Upper Echelon Automotive!</p>
          <div style="background:rgba(74,222,128,.08);border:1px solid rgba(74,222,128,.25);border-radius:8px;padding:16px;margin-bottom:16px;">
            <p style="color:rgba(245,240,232,.8);margin:0 0 8px;font-size:14px;"><strong style="color:#4ade80;">Plan:</strong> ${planName}</p>
            <p style="color:rgba(245,240,232,.6);margin:0;font-size:13px;">Log in at ueauto.store to set up your vehicles and subscribe to your FleetCare plan.</p>
          </div>
          <p style="color:rgba(245,240,232,.6);font-size:13px;">Questions? Call or text Robert at (251) 289-0740.</p>
        `),
      });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Fleet welcome
app.post('/send-email/fleet-welcome', async (req, res) => {
  try {
    const { contactName, companyName, email } = req.body;
    if (email) {
      await sendEmail({
        to: email,
        subject: 'Fleet Account Created — Upper Echelon Automotive',
        html: EMAIL.fleetWelcome({ contactName, companyName }),
      });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Tow welcome
app.post('/send-email/tow-welcome', async (req, res) => {
  try {
    const { contactName, companyName, email, pin } = req.body;
    if (email) {
      await sendEmail({
        to: email,
        subject: 'Welcome to the UEA Tow Network',
        html: EMAIL.towWelcome({ contactName, companyName, pin }),
      });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Tow alert to all tow companies
app.post('/send-email/new-tow-alert', async (req, res) => {
  try {
    const { req: towReq, towCompanies } = req.body;
    const eligible = (towCompanies || []).filter(c => c.email && c.active !== false);
    for (const co of eligible) {
      await sendEmail({
        to: co.email,
        subject: '🚨 New Tow Request — Upper Echelon Automotive',
        html: EMAIL.newTowAlert({ contactName: co.contactName, ...towReq }),
      });
    }
    res.json({ ok: true, sent: eligible.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Account welcome
app.post('/send-email/account-welcome', async (req, res) => {
  try {
    const { name, email } = req.body;
    if (email) {
      await sendEmail({
        to: email,
        subject: 'Welcome to Upper Echelon Automotive 👑',
        html: EMAIL.accountWelcome({ name }),
      });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════════
// FILE UPLOAD ROUTES (Supabase Storage)
// ════════════════════════════════════════════════════════════════════════════════

app.post('/upload-tech-doc', upload.single('file'), async (req, res) => {
  try {
    const { techId, docType } = req.body;
    if (!req.file || !techId || !docType) {
      return res.status(400).json({ error: 'Missing file, techId, or docType.' });
    }
    const ext = path.extname(req.file.originalname).toLowerCase();
    const filename = `${techId}/${docType}_${Date.now()}${ext}`;
    const bucket = 'tech-verification';

    const { error } = await supabase.storage
      .from(bucket)
      .upload(filename, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true,
      });

    if (error) throw error;

    const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(filename);
    res.json({ ok: true, url: urlData.publicUrl, filename });
  } catch (e) {
    console.error('[Upload]', e);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════════
// STRIPE — PAYMENT ROUTES
// ════════════════════════════════════════════════════════════════════════════════

// Create payment intent (upfront booking payment)
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { appointmentId, amount, customerEmail, customerName } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount.' });

    const intent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: 'usd',
      metadata: { appointmentId, customerEmail, customerName },
      receipt_email: customerEmail,
    });
    res.json({ clientSecret: intent.client_secret });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create subscription (membership)
app.post('/create-subscription', async (req, res) => {
  try {
    const { userId, email, name, paymentMethodId } = req.body;
    let customer;
    const existing = await stripe.customers.list({ email, limit: 1 });
    if (existing.data.length > 0) {
      customer = existing.data[0];
    } else {
      customer = await stripe.customers.create({ email, name, metadata: { userId } });
    }
    await stripe.paymentMethods.attach(paymentMethodId, { customer: customer.id });
    await stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: process.env.STRIPE_MEMBERSHIP_PRICE_ID }],
      payment_behavior: 'default_incomplete',
      expand: ['latest_invoice.payment_intent'],
    });
    res.json({
      subscriptionId: subscription.id,
      clientSecret: subscription.latest_invoice?.payment_intent?.client_secret,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cancel subscription
app.post('/cancel-subscription', async (req, res) => {
  try {
    const { userId } = req.body;
    const customers = await stripe.customers.search({ query: `metadata['userId']:'${userId}'` });
    if (!customers.data.length) return res.status(404).json({ error: 'Customer not found.' });
    const subs = await stripe.subscriptions.list({ customer: customers.data[0].id, status: 'active' });
    for (const sub of subs.data) {
      await stripe.subscriptions.cancel(sub.id);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create Stripe Connect account for technician
app.post('/create-connect-account', async (req, res) => {
  try {
    const { technicianId, email, name } = req.body;
    const account = await stripe.accounts.create({
      type: 'express',
      email,
      metadata: { technicianId },
      capabilities: { transfers: { requested: true } },
    });
    // Save accountId to Supabase
    await supabase.from('uea_technicians').update({ stripe_connect_id: account.id }).eq('id', technicianId);
    res.json({ accountId: account.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Generate Connect onboarding link
app.post('/connect-onboarding-link', async (req, res) => {
  try {
    const { accountId, returnUrl, refreshUrl } = req.body;
    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: 'account_onboarding',
    });
    res.json({ url: link.url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Check Connect account status
app.get('/connect-status/:technicianId', async (req, res) => {
  try {
    const { technicianId } = req.params;
    const { data } = await supabase.from('uea_technicians').select('stripe_connect_id').eq('id', technicianId).single();
    if (!data?.stripe_connect_id) return res.json({ connected: false, payoutsEnabled: false });
    const account = await stripe.accounts.retrieve(data.stripe_connect_id);
    res.json({ connected: true, payoutsEnabled: account.payouts_enabled, accountId: account.id });
  } catch (e) { res.json({ connected: false, payoutsEnabled: false }); }
});

// Payout technician via Stripe Connect transfer
app.post('/payout-technician', async (req, res) => {
  try {
    const { technicianId, amount, adminPin } = req.body;
    if (adminPin !== process.env.ADMIN_PIN) return res.status(403).json({ error: 'Unauthorized.' });
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount.' });

    const { data: tech } = await supabase.from('uea_technicians').select('stripe_connect_id, name, email').eq('id', technicianId).single();
    if (!tech?.stripe_connect_id) return res.status(400).json({ error: 'Technician has not completed Stripe payout setup.' });

    const transfer = await stripe.transfers.create({
      amount: Math.round(amount * 100),
      currency: 'usd',
      destination: tech.stripe_connect_id,
      metadata: { technicianId },
    });

    // Log payout in Supabase
    await supabase.from('uea_payouts').insert({
      id: transfer.id,
      technician_id: technicianId,
      amount,
      method: 'stripe_connect',
      status: 'paid',
      note: `Transfer ${transfer.id}`,
    });

    res.json({ ok: true, transferId: transfer.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════════
// SMS (Textbelt relay)
// ════════════════════════════════════════════════════════════════════════════════
app.post('/send-sms', async (req, res) => {
  try {
    const { phone, message } = req.body;
    const r = await fetch('https://textbelt.com/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, message, key: process.env.TEXTBELT_KEY || 'textbelt' }),
    });
    const data = await r.json();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════════
// START
// ════════════════════════════════════════════════════════════════════════════════
// FLEETCARE SUBSCRIPTIONS
// ════════════════════════════════════════════════════════════════════════════════

app.post('/fleetcare/subscribe', async (req, res) => {
  try {
    const { fleetCompanyId, planId, paymentMethodId, email, companyName } = req.body;
    const { data: plan, error: planErr } = await supabase.from('uea_fleet_plans').select('*').eq('id', planId).single();
    if (planErr || !plan) return res.status(404).json({ error: 'Plan not found.' });
    if (!plan.stripe_price_id) return res.status(400).json({ error: 'Plan not yet configured in Stripe. Contact admin.' });
    let customer;
    const existing = await stripe.customers.list({ email, limit: 1 });
    if (existing.data.length > 0) { customer = existing.data[0]; }
    else { customer = await stripe.customers.create({ email, name: companyName, metadata: { fleetCompanyId, planId } }); }
    await stripe.paymentMethods.attach(paymentMethodId, { customer: customer.id });
    await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: paymentMethodId } });
    const subscription = await stripe.subscriptions.create({
      customer: customer.id, items: [{ price: plan.stripe_price_id }],
      payment_behavior: 'default_incomplete', expand: ['latest_invoice.payment_intent'],
      metadata: { fleetCompanyId, planId },
    });
    const subId = `fsub_${Date.now()}`;
    const now = new Date(); const periodEnd = new Date(now); periodEnd.setMonth(periodEnd.getMonth() + 1);
    await supabase.from('uea_fleet_subscriptions').insert({
      id: subId, fleet_company_id: fleetCompanyId, plan_id: planId, plan_name: plan.name,
      stripe_subscription_id: subscription.id, stripe_customer_id: customer.id,
      status: 'active', vehicle_limit: plan.vehicle_max || 999,
      labor_hours_cap_per_vehicle: plan.labor_hours_cap_per_vehicle || 3,
      parts_discount_pct: plan.parts_discount_pct, monthly_price: plan.monthly_price,
      hours_used_this_period: 0, current_period_start: now.toISOString(), current_period_end: periodEnd.toISOString(),
    });
    await supabase.from('uea_fleet_companies').update({
      active_subscription_id: subId, plan_id: planId, stripe_customer_id: customer.id,
    }).eq('id', fleetCompanyId);
    res.json({ ok: true, subscriptionId: subscription.id, clientSecret: subscription.latest_invoice?.payment_intent?.client_secret, subId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/fleetcare/cancel', async (req, res) => {
  try {
    const { subId, fleetCompanyId } = req.body;
    const { data: sub } = await supabase.from('uea_fleet_subscriptions').select('stripe_subscription_id').eq('id', subId).single();
    if (sub?.stripe_subscription_id) await stripe.subscriptions.cancel(sub.stripe_subscription_id);
    await supabase.from('uea_fleet_subscriptions').update({ status: 'cancelled', cancelled_at: new Date().toISOString() }).eq('id', subId);
    await supabase.from('uea_fleet_companies').update({ active_subscription_id: null, plan_id: null }).eq('id', fleetCompanyId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/fleetcare/subscription/:fleetCompanyId', async (req, res) => {
  try {
    const { fleetCompanyId } = req.params;
    const { data } = await supabase.from('uea_fleet_subscriptions').select('*').eq('fleet_company_id', fleetCompanyId).eq('status', 'active').order('created_at', { ascending: false }).limit(1);
    res.json({ subscription: data?.[0] || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/fleetcare/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || ''); }
  catch (e) { return res.status(400).json({ error: `Webhook error: ${e.message}` }); }
  if (event.type === 'invoice.paid') {
    const sub = event.data.object.subscription;
    if (sub) await supabase.from('uea_fleet_subscriptions').update({ hours_used_this_period: 0, current_period_start: new Date().toISOString() }).eq('stripe_subscription_id', sub);
  }
  res.json({ received: true });
});

// ════════════════════════════════════════════════════════════════════════════════
// PARTSTECH — Parts Search & Ordering
// ════════════════════════════════════════════════════════════════════════════════
// Requires PARTSTECH_USERNAME and PARTSTECH_ACCESS_CODE env vars (from partstech.com account)
app.post('/partstech/search', async (req, res) => {
  try {
    const { year, make, model, query } = req.body;
    if (!process.env.PARTSTECH_USERNAME || !process.env.PARTSTECH_ACCESS_CODE) {
      return res.status(400).json({ error: 'PartsTech not configured yet. Add PARTSTECH_USERNAME and PARTSTECH_ACCESS_CODE to environment variables.' });
    }
    // PartsTech's actual API endpoint and auth scheme should be confirmed against
    // their developer docs at api-docs.partstech.com once you have credentials —
    // this is a placeholder structure matching their documented request format.
    const r = await fetch('https://api.partstech.com/v1/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${Buffer.from(`${process.env.PARTSTECH_USERNAME}:${process.env.PARTSTECH_ACCESS_CODE}`).toString('base64')}`,
      },
      body: JSON.stringify({ year, make, model, query }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error || 'PartsTech search failed.' });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════════
// TECHNICIAN TIME CLOCK
// ════════════════════════════════════════════════════════════════════════════════
app.post('/time-clock/start', async (req, res) => {
  try {
    const { appointmentId, technicianId } = req.body;
    const id = `tl_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    const { data, error } = await supabase.from('uea_time_logs').insert({
      id, appointment_id: appointmentId, technician_id: technicianId,
      clock_in_at: new Date().toISOString(),
    }).select().single();
    if (error) throw error;
    res.json({ ok: true, logId: data.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/time-clock/stop', async (req, res) => {
  try {
    const { logId } = req.body;
    const { data: existing } = await supabase.from('uea_time_logs').select('clock_in_at').eq('id', logId).single();
    if (!existing) return res.status(404).json({ error: 'Time log not found.' });
    const clockOut = new Date();
    const clockIn = new Date(existing.clock_in_at);
    const totalSeconds = Math.round((clockOut - clockIn) / 1000);
    const { error } = await supabase.from('uea_time_logs').update({
      clock_out_at: clockOut.toISOString(),
      total_seconds: totalSeconds,
    }).eq('id', logId);
    if (error) throw error;
    res.json({ ok: true, totalSeconds });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/time-clock/active/:technicianId', async (req, res) => {
  try {
    const { technicianId } = req.params;
    const { data, error } = await supabase.from('uea_time_logs')
      .select('*').eq('technician_id', technicianId).is('clock_out_at', null)
      .order('clock_in_at', { ascending: false }).limit(1);
    if (error) throw error;
    res.json({ active: data && data.length > 0 ? data[0] : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/time-clock/job/:appointmentId', async (req, res) => {
  try {
    const { appointmentId } = req.params;
    const { data, error } = await supabase.from('uea_time_logs')
      .select('*').eq('appointment_id', appointmentId).order('clock_in_at', { ascending: true });
    if (error) throw error;
    const totalSeconds = (data || []).reduce((sum, log) => sum + (log.total_seconds || 0), 0);
    res.json({ logs: data || [], totalSeconds });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`UEA Backend running on port ${PORT}`));
