require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Resend } = require("resend");

const app = express();
const resend = new Resend(process.env.RESEND_API_KEY);

app.use(cors());
app.use(express.json());

async function verifyTurnstile(token) {
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      secret: process.env.TURNSTILE_SECRET_KEY,
      response: token,
    }),
  });
  const data = await res.json();
  return data.success === true;
}

app.post("/api/contact", async function (req, res) {
  try {
    const name = req.body.name;
    const email = req.body.email;
    const message = req.body.message;
    const site = req.body.site;
    const turnstileToken = req.body.turnstileToken;

    if (!name || !email || !message) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const validToken = await verifyTurnstile(turnstileToken);
    if (!validToken) {
      return res.status(403).json({ error: "Turnstile verification failed" });
    }

    resend.emails.send({
      from: "Website <hello@affordawebsolutions.com>",
      to: "affordawebsolutions@gmail.com",
      subject: "New message from " + name + " (" + (site || "Unknown") + ")",
      html:
        "<h3>New Contact Form</h3>" +
        "<p><strong>Site:</strong> " + (site || "N/A") + "</p>" +
        "<p><strong>Name:</strong> " + name + "</p>" +
        "<p><strong>Email:</strong> " + email + "</p>" +
        "<p><strong>Message:</strong><br/>" + message + "</p>"
    });

    return res.json({ success: true });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to send" });
  }
});

app.listen(3000, function () {
  console.log("Server running on port 3000");
});