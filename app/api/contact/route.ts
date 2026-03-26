import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";

// ── Rate limiting ─────────────────────────────────────────────────────────────
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }
  if (entry.count >= RATE_LIMIT_MAX) return true;
  entry.count++;
  return false;
}

// ── CORS ──────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

function corsHeaders(origin: string | null) {
  const allowed =
    origin && ALLOWED_ORIGINS.length > 0 && ALLOWED_ORIGINS.includes(origin)
      ? origin
      : ALLOWED_ORIGINS[0] ?? "*";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

// ── Slack notification ────────────────────────────────────────────────────────
async function notifySlack(data: {
  name: string;
  email: string;
  website: string;
  message: string;
  extras: Record<string, string>;
}) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;

  const extraLines = Object.entries(data.extras)
    .filter(([, v]) => v?.trim())
    .map(([k, v]) => `*${formatLabel(k)}:* ${v}`)
    .join("\n");

  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: `New message via ${data.website}`,
          },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Name:*\n${data.name}` },
            { type: "mrkdwn", text: `*Email:*\n${data.email}` },
          ],
        },
        ...(extraLines
          ? [
              {
                type: "section",
                text: { type: "mrkdwn", text: extraLines },
              },
            ]
          : []),
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Message:*\n${data.message}`,
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Reply" },
              url: `mailto:${data.email}`,
              style: "primary",
            },
          ],
        },
      ],
    }),
  }).catch((err) => console.error("Slack notification failed:", err));
}

// ── KV submission log ─────────────────────────────────────────────────────────
// Logs to Vercel KV if KV_REST_API_URL + KV_REST_API_TOKEN are set.
// Submissions are kept for 90 days.
async function logSubmission(data: {
  name: string;
  email: string;
  message: string;
  website: string;
  extras: Record<string, string>;
  ip: string;
}) {
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return;

  const key = `submission:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const payload = { ...data, submittedAt: new Date().toISOString() };
  const ttl = 60 * 60 * 24 * 90; // 90 days

  await fetch(`${kvUrl}/set/${key}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${kvToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([JSON.stringify(payload), "EX", ttl]),
  }).catch((err) => console.error("KV log failed:", err));
}

// ── Routes ────────────────────────────────────────────────────────────────────
export async function OPTIONS(req: NextRequest) {
  const origin = req.headers.get("origin");
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  const headers = corsHeaders(origin);

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  if (isRateLimited(ip)) {
    return NextResponse.json(
      { error: "Too many requests. Please wait before submitting again." },
      { status: 429, headers }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers });
  }

  const { name, email, message, website, _honeypot, ...extras } =
    body as Record<string, string>;

  if (_honeypot) {
    return NextResponse.json({ ok: true }, { status: 200, headers });
  }

  if (!name?.trim() || !email?.trim() || !message?.trim()) {
    return NextResponse.json(
      { error: "name, email, and message are required" },
      { status: 422, headers }
    );
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return NextResponse.json(
      { error: "Invalid email address" },
      { status: 422, headers }
    );
  }

  // Per-site email routing — stored as JSON in SITE_EMAILS env var
  // e.g. {"ascend":{"to":"info@ascend.org","cc":"cc@ascend.org"}}
  let toEmail: string | undefined;
  let ccEmail: string | undefined;

  const siteEmailsRaw = process.env.SITE_EMAILS;
  if (siteEmailsRaw && website) {
    try {
      const siteEmails = JSON.parse(siteEmailsRaw) as Record<string, { to?: string; cc?: string }>;
      const siteEntry = siteEmails[website];
      if (siteEntry) {
        toEmail = siteEntry.to;
        ccEmail = siteEntry.cc;
      }
    } catch {
      console.error("Invalid SITE_EMAILS JSON");
    }
  }

  // Fall back to global TO_EMAIL / CC_EMAIL
  if (!toEmail) toEmail = process.env.TO_EMAIL;
  if (!ccEmail) ccEmail = process.env.CC_EMAIL;

  if (!toEmail) {
    console.error("No TO email resolved for website:", website);
    return NextResponse.json(
      { error: "Server misconfiguration" },
      { status: 500, headers }
    );
  }
  const resend = new Resend(process.env.RESEND_API_KEY);
  const source = website ? ` via ${website}` : "";
  const from = process.env.FROM_EMAIL ?? "Contact Form <onboarding@resend.dev>";

  // Send all three in parallel — admin email, confirmation, Slack + KV log
  const [{ error }] = await Promise.all([
    // Admin notification email
    resend.emails.send({
      from,
      to: toEmail,
      ...(ccEmail ? { cc: ccEmail } : {}),
      replyTo: email,
      subject: `New message from ${name}${source}`,
      text: `Name: ${name}\nEmail: ${email}\nWebsite: ${website ?? "unknown"}\n\n${message}`,
      html: adminEmailTemplate({ name, email, message, website, extras }),
    }),
    // Confirmation email to submitter
    resend.emails.send({
      from,
      to: email,
      subject: `We received your message`,
      html: confirmationTemplate({ name, website }),
    }),
    // Slack notification (no-op if SLACK_WEBHOOK_URL not set)
    notifySlack({ name, email, website: website ?? "unknown", message, extras }),
    // KV log (no-op if KV env vars not set)
    logSubmission({ name, email, message, website: website ?? "unknown", extras, ip }),
  ]);

  if (error) {
    console.error("Resend error:", error);
    return NextResponse.json(
      { error: "Failed to send email" },
      { status: 500, headers }
    );
  }

  return NextResponse.json({ ok: true }, { status: 200, headers });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function escapeHtml(str: string) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const FIELD_LABELS: Record<string, string> = {
  clientWebsite: "Client Website",
  service: "Service",
  budget: "Budget",
  phone: "Phone",
  company: "Company",
};

function formatLabel(key: string) {
  return (
    FIELD_LABELS[key] ??
    key.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase())
  );
}

// ── Email templates ───────────────────────────────────────────────────────────
function adminEmailTemplate({
  name,
  email,
  message,
  website,
  extras,
}: {
  name: string;
  email: string;
  message: string;
  website?: string;
  extras?: Record<string, string>;
}) {
  const site = website ?? "your website";
  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background-color:#f0edf8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0edf8;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;">

        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,#7C3AED 0%,#EC4899 100%);border-radius:16px 16px 0 0;padding:36px 40px;text-align:center;">
          <p style="margin:0 0 6px;font-size:11px;color:rgba(255,255,255,0.7);letter-spacing:0.12em;text-transform:uppercase;">New message via</p>
          <p style="margin:0 0 4px;font-size:22px;font-weight:700;color:#fff;">${escapeHtml(site)}</p>
          <p style="margin:8px 0 0;display:inline-block;background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.25);color:rgba(255,255,255,0.9);font-size:11px;padding:4px 14px;border-radius:100px;">New Contact Form Submission</p>
        </td></tr>

        <!-- Body -->
        <tr><td style="background-color:#fff;padding:40px;">

          <!-- From block -->
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;background:linear-gradient(135deg,#faf5ff,#fff0f9);border-radius:12px;padding:20px 24px;border:1px solid #e9d5ff;">
            <tr><td>
              <p style="margin:0 0 6px;font-size:11px;color:#9d74cf;text-transform:uppercase;letter-spacing:0.08em;font-weight:600;">Message from</p>
              <p style="margin:0;font-size:18px;font-weight:700;color:#3A3C51;">${escapeHtml(name)}</p>
              <p style="margin:4px 0 0;font-size:14px;"><a href="mailto:${escapeHtml(email)}" style="color:#7C3AED;text-decoration:none;font-weight:500;">${escapeHtml(email)}</a></p>
            </td></tr>
          </table>

          ${
            extras && Object.entries(extras).filter(([, v]) => v?.trim()).length > 0
              ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;border-radius:10px;overflow:hidden;border:1px solid #e9d5ff;">
              ${Object.entries(extras)
                .filter(([, v]) => v?.trim())
                .map(
                  ([k, v], i) =>
                    `<tr style="background-color:${i % 2 === 0 ? "#faf5ff" : "#fff"};">
                  <td style="padding:10px 16px;font-size:11px;color:#9d74cf;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;width:38%;border-right:1px solid #e9d5ff;">${formatLabel(k)}</td>
                  <td style="padding:10px 16px;font-size:13px;color:#3A3C51;">${escapeHtml(v)}</td>
                </tr>`
                )
                .join("")}
            </table>`
              : ""
          }

          <!-- Message -->
          <p style="margin:0 0 10px;font-size:11px;color:#9d74cf;text-transform:uppercase;letter-spacing:0.08em;font-weight:600;">Message</p>
          <div style="background-color:#faf5ff;border-left:4px solid #7C3AED;border-radius:0 10px 10px 0;padding:20px 24px;margin-bottom:32px;">
            <p style="margin:0;font-size:15px;line-height:1.75;color:#3A3C51;white-space:pre-wrap;">${escapeHtml(message)}</p>
          </div>

          <!-- CTA -->
          <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
            <a href="mailto:${escapeHtml(email)}?subject=Re: your message to ${escapeHtml(site)}"
              style="display:inline-block;background:linear-gradient(135deg,#7C3AED,#EC4899);color:#fff;text-decoration:none;font-size:15px;font-weight:600;padding:14px 40px;border-radius:100px;letter-spacing:0.01em;">
              Reply to ${escapeHtml(name)}
            </a>
          </td></tr></table>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background-color:#292733;border-radius:0 0 16px 16px;padding:24px 40px;text-align:center;">
          <p style="margin:0 0 4px;font-size:13px;color:#fff;font-weight:600;">${escapeHtml(site)}</p>
          <p style="margin:0;font-size:11px;color:#555;">Received on ${date} · Powered by AffordaWeb</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function confirmationTemplate({
  name,
  website,
}: {
  name: string;
  website?: string;
}) {
  const site = website ?? "us";
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background-color:#f0edf8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0edf8;padding:40px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;">

        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,#7C3AED 0%,#EC4899 100%);border-radius:16px 16px 0 0;padding:40px;text-align:center;">
          <div style="width:60px;height:60px;background:rgba(255,255,255,0.2);border:2px solid rgba(255,255,255,0.4);border-radius:50%;display:inline-block;line-height:60px;margin-bottom:16px;">
            <span style="color:#fff;font-size:26px;line-height:60px;">✓</span>
          </div>
          <h1 style="margin:0 0 6px;font-size:24px;font-weight:700;color:#fff;">Message Received!</h1>
          <p style="margin:0;font-size:14px;color:rgba(255,255,255,0.8);">Thank you for reaching out via ${escapeHtml(site)}</p>
        </td></tr>

        <!-- Body -->
        <tr><td style="background-color:#fff;padding:40px;">
          <p style="margin:0 0 16px;font-size:16px;line-height:1.7;color:#3A3C51;font-weight:600;">
            Hi ${escapeHtml(name)},
          </p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.75;color:#474747;">
            We&rsquo;ve received your message and our team will get back to you within <strong style="color:#7C3AED;">24–48 hours</strong>.
          </p>
          <p style="margin:0;font-size:13px;color:#9A9A9A;line-height:1.6;">
            If your matter is urgent, you can reply directly to this email.
          </p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background-color:#292733;border-radius:0 0 16px 16px;padding:24px 40px;text-align:center;">
          <p style="margin:0 0 4px;font-size:13px;color:#fff;font-weight:600;">${escapeHtml(site)}</p>
          <p style="margin:0;font-size:11px;color:#555;">Powered by AffordaWeb Solutions</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
