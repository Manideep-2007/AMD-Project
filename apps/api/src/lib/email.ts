/**
 * Email Service
 *
 * Supports SMTP (via nodemailer) and SendGrid transports,
 * controlled by the EMAIL_PROVIDER env var.
 */

import { createLogger } from '@nexusops/logger';

const logger = createLogger('email');

const EMAIL_PROVIDER = process.env.EMAIL_PROVIDER || 'smtp';
const FROM_EMAIL = process.env.FROM_EMAIL || 'no-reply@nexusops.io';
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:3000';

interface EmailPayload {
  to: string;
  subject: string;
  html: string;
}

async function sendViaSMTP(payload: EmailPayload): Promise<void> {
  // Dynamic import so the module doesn't fail if nodemailer isn't installed
  const nodemailer = await import('nodemailer');
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: parseInt(process.env.SMTP_PORT || '587', 10) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  await transport.sendMail({
    from: FROM_EMAIL,
    to: payload.to,
    subject: payload.subject,
    html: payload.html,
  });
}

async function sendViaSendGrid(payload: EmailPayload): Promise<void> {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) throw new Error('SENDGRID_API_KEY is not set');

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: payload.to }] }],
      from: { email: FROM_EMAIL },
      subject: payload.subject,
      content: [{ type: 'text/html', value: payload.html }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SendGrid error ${res.status}: ${text}`);
  }
}

export async function sendEmail(payload: EmailPayload): Promise<void> {
  try {
    if (EMAIL_PROVIDER === 'sendgrid') {
      await sendViaSendGrid(payload);
    } else {
      await sendViaSMTP(payload);
    }
    logger.info({ to: payload.to, subject: payload.subject }, 'Email sent');
  } catch (err) {
    logger.error({ err, to: payload.to }, 'Failed to send email');
    throw err;
  }
}

export function buildInvitationEmail(params: {
  inviterName: string;
  workspaceName: string;
  token: string;
  role: string;
}): EmailPayload {
  const acceptUrl = `${DASHBOARD_URL}/invite/accept?token=${encodeURIComponent(params.token)}`;

  return {
    to: '', // caller sets this
    subject: `You've been invited to ${params.workspaceName} on NexusOps`,
    html: `
      <div style="font-family: sans-serif; max-width: 560px; margin: 0 auto;">
        <h2>You're invited to <strong>${escapeHtml(params.workspaceName)}</strong></h2>
        <p><strong>${escapeHtml(params.inviterName)}</strong> has invited you to join as <strong>${escapeHtml(params.role)}</strong>.</p>
        <p style="margin: 24px 0;">
          <a href="${escapeHtml(acceptUrl)}"
             style="background: #2563eb; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; display: inline-block;">
            Accept Invitation
          </a>
        </p>
        <p style="color: #6b7280; font-size: 13px;">This invitation expires in 7 days. If you weren't expecting this, you can safely ignore it.</p>
      </div>
    `,
  };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
