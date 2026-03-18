import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";

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

export async function OPTIONS(req: NextRequest) {
  const origin = req.headers.get("origin");
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  const headers = corsHeaders(origin);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers });
  }

  const { name, email, message, website, _honeypot, ...extras } = body as Record<string, string>;

  // Honeypot check — bots fill this field, humans don't see it
  if (_honeypot) {
    return NextResponse.json({ ok: true }, { status: 200, headers });
  }

  // Basic validation
  if (!name?.trim() || !email?.trim() || !message?.trim()) {
    return NextResponse.json(
      { error: "name, email, and message are required" },
      { status: 422, headers }
    );
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return NextResponse.json({ error: "Invalid email address" }, { status: 422, headers });
  }

  const source = website ? ` via ${website}` : "";
  const toEmail = process.env.TO_EMAIL;

  if (!toEmail) {
    console.error("TO_EMAIL env var is not set");
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500, headers });
  }

  const resend = new Resend(process.env.RESEND_API_KEY);

  const { error } = await resend.emails.send({
    from: process.env.FROM_EMAIL ?? "Contact Form <onboarding@resend.dev>",
    to: toEmail,
    replyTo: email,
    subject: `New message from ${name}${source}`,
    text: `Name: ${name}\nEmail: ${email}\nWebsite: ${website ?? "unknown"}\n\n${message}`,
    html: emailTemplate({ name, email, message, website, extras }),
  });

  if (error) {
    console.error("Resend error:", error);
    return NextResponse.json({ error: "Failed to send email" }, { status: 500, headers });
  }

  return NextResponse.json({ ok: true }, { status: 200, headers });
}

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
  return FIELD_LABELS[key] ?? key.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase());
}

function emailTemplate({
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
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>New message from ${escapeHtml(name)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">

          <!-- Header -->
          <tr>
            <td style="background-color:#18181b;border-radius:12px 12px 0 0;padding:32px 40px;text-align:center;">
              <p style="margin:0;font-size:13px;color:#a1a1aa;letter-spacing:0.08em;text-transform:uppercase;">New message via</p>
              <p style="margin:6px 0 0;font-size:20px;font-weight:700;color:#ffffff;">${escapeHtml(site)}</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background-color:#ffffff;padding:40px;">

              <!-- Sender info -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;background-color:#f9f9fb;border-radius:8px;padding:20px;border:1px solid #e4e4e7;">
                <tr>
                  <td>
                    <p style="margin:0 0 4px;font-size:12px;color:#71717a;text-transform:uppercase;letter-spacing:0.06em;">From</p>
                    <p style="margin:0;font-size:17px;font-weight:600;color:#18181b;">${escapeHtml(name)}</p>
                    <p style="margin:4px 0 0;font-size:14px;color:#3f3f46;">
                      <a href="mailto:${escapeHtml(email)}" style="color:#6366f1;text-decoration:none;">${escapeHtml(email)}</a>
                    </p>
                  </td>
                </tr>
              </table>

              ${
                extras && Object.keys(extras).length > 0
                  ? `<!-- Extra fields -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;border-radius:8px;overflow:hidden;border:1px solid #e4e4e7;">
                ${Object.entries(extras)
                  .filter(([, v]) => v?.trim())
                  .map(
                    ([k, v], i) => `<tr style="background-color:${i % 2 === 0 ? "#f9f9fb" : "#ffffff"};">
                  <td style="padding:10px 16px;font-size:12px;color:#71717a;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;width:40%;border-right:1px solid #e4e4e7;">${formatLabel(k)}</td>
                  <td style="padding:10px 16px;font-size:13px;color:#18181b;">${escapeHtml(v)}</td>
                </tr>`
                  )
                  .join("")}
              </table>`
                  : ""
              }

              <!-- Message -->
              <p style="margin:0 0 10px;font-size:12px;color:#71717a;text-transform:uppercase;letter-spacing:0.06em;">Message</p>
              <div style="background-color:#f9f9fb;border-left:3px solid #6366f1;border-radius:0 8px 8px 0;padding:20px 24px;margin-bottom:32px;">
                <p style="margin:0;font-size:15px;line-height:1.7;color:#27272a;white-space:pre-wrap;">${escapeHtml(message)}</p>
              </div>

              <!-- Reply button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center">
                    <a href="mailto:${escapeHtml(email)}?subject=Re: your message"
                      style="display:inline-block;background-color:#6366f1;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:14px 36px;border-radius:8px;">
                      Reply to ${escapeHtml(name)}
                    </a>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#f4f4f5;border-radius:0 0 12px 12px;padding:20px 40px;text-align:center;">
              <p style="margin:0;font-size:12px;color:#a1a1aa;">Received on ${date}</p>
              <p style="margin:6px 0 0;font-size:12px;color:#a1a1aa;">Sent via <strong>AffordaWeb</strong> contact form API</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
