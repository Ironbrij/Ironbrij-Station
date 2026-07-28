import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const InviteInput = z.object({
  employeeId: z.string().min(1),
  email: z.string().email(),
  name: z.string().min(1),
});

/**
 * Creates an invite token in Firestore (via REST) and sends the invite email via Resend.
 * We hit the Firestore REST API from the server so we can write with the service key or
 * (in this v1) simply use the same publishable web config — the security rules must allow
 * creation of `invites/{token}` documents; see FIRESTORE_RULES.md.
 */
export const sendInvite = createServerFn({ method: "POST" })
  .validator((data: unknown) => InviteInput.parse(data))
  .handler(async ({ data }) => {
    const RESEND_KEY = process.env.RESEND_API_KEY;
    const FROM = process.env.INVITE_FROM_EMAIL ?? "Time Station <onboarding@resend.dev>";
    const APP_URL = process.env.APP_URL ?? "";
    const PROJECT_ID = process.env.VITE_FIREBASE_PROJECT_ID;
    const API_KEY = process.env.VITE_FIREBASE_API_KEY;

    if (!RESEND_KEY) throw new Error("RESEND_API_KEY not configured");
    if (!PROJECT_ID || !API_KEY) throw new Error("Firebase env not configured on server");

    // Generate a random token
    const token = crypto.randomUUID().replace(/-/g, "");

    // Write invite doc via Firestore REST API
    const inviteUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/invites?documentId=${token}&key=${API_KEY}`;
    const inviteRes = await fetch(inviteUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fields: {
          employeeId: { stringValue: data.employeeId },
          email: { stringValue: data.email },
          createdAt: { timestampValue: new Date().toISOString() },
          used: { booleanValue: false },
        },
      }),
    });
    if (!inviteRes.ok) {
      const errText = await inviteRes.text();
      throw new Error(`Firestore invite write failed: ${errText}`);
    }

    const acceptUrl = `${APP_URL}/invite/${token}`;

    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${RESEND_KEY}`,
      },
      body: JSON.stringify({
        from: FROM,
        to: [data.email],
        subject: "You're invited to Time Station",
        html: `
          <div style="font-family: -apple-system, sans-serif; max-width: 540px; margin: 0 auto; padding: 32px; background: #ffffff;">
            <h1 style="color: #0b2545; margin: 0 0 8px;">Welcome to Time Station</h1>
            <p style="color: #334155;">Hi ${escapeHtml(data.name)},</p>
            <p style="color: #334155;">Your workspace admin invited you to join. Click below to create your account and start punching in.</p>
            <p style="text-align:center; margin: 32px 0;">
              <a href="${acceptUrl}" style="background:#0b2545;color:#ffffff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Accept invite</a>
            </p>
            <p style="color:#64748b;font-size:12px;">Or copy this link: ${acceptUrl}</p>
          </div>
        `,
      }),
    });
    if (!emailRes.ok) {
      const errText = await emailRes.text();
      throw new Error(`Resend failed [${emailRes.status}]: ${errText}`);
    }

    return { ok: true, token };
  });

function escapeHtml(s: string) {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
