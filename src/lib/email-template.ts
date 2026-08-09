import type { CompanyEmailBranding } from "@/lib/email-branding";

export function escapeEmailHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

function safeLogoUrl(value?: string) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? value : "";
  } catch {
    return "";
  }
}

export function renderEmailDetails(
  details: Array<{ label: string; value: string }>,
  accentColor = "#2459a9",
) {
  return details
    .filter((detail) => detail.value.trim())
    .map(
      (detail) => `<tr>
        <td style="padding: 0 0 12px; vertical-align: top; width: 132px; color: #718096; font-size: 12px; line-height: 18px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;">${escapeEmailHtml(detail.label)}</td>
        <td style="padding: 0 0 12px; vertical-align: top; color: #16283f; font-size: 14px; line-height: 20px; font-weight: 600; border-left: 3px solid ${accentColor}; padding-left: 12px;">${escapeEmailHtml(detail.value)}</td>
      </tr>`,
    )
    .join("");
}

export function renderCompanyEmail({
  company,
  preheader,
  label,
  title,
  introHtml,
  contentHtml,
  cta,
  accentColor = "#2459a9",
}: {
  company?: CompanyEmailBranding;
  preheader: string;
  label: string;
  title: string;
  introHtml: string;
  contentHtml: string;
  cta?: { label: string; url: string };
  accentColor?: string;
}) {
  const companyName = company?.name?.trim() || "SavyTimes";
  const logoUrl = safeLogoUrl(company?.logoUrl?.trim());
  const initial = companyName.charAt(0).toUpperCase() || "S";
  const safeCompanyName = escapeEmailHtml(companyName);
  const logoHtml = logoUrl
    ? `<img src="${escapeEmailHtml(logoUrl)}" width="48" height="48" alt="${safeCompanyName} logo" style="display: block; width: 48px; height: 48px; border: 0; border-radius: 10px; object-fit: contain; background: #ffffff;">`
    : `<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td width="48" height="48" align="center" valign="middle" style="width: 48px; height: 48px; border-radius: 10px; background-color: ${accentColor}; color: #ffffff; font-size: 22px; line-height: 48px; font-weight: 800;">${escapeEmailHtml(initial)}</td></tr></table>`;
  const ctaHtml = cta
    ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 28px 0 4px;"><tr><td bgcolor="${accentColor}" style="border-radius: 8px;"><a href="${escapeEmailHtml(cta.url)}" style="display: inline-block; padding: 13px 20px; color: #ffffff; font-size: 14px; line-height: 18px; font-weight: 700; text-decoration: none;">${escapeEmailHtml(cta.label)}</a></td></tr></table>`
    : "";

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin: 0; padding: 0; background-color: #f3f6fa; color: #16283f; font-family: Arial, Helvetica, sans-serif;">
  <div style="display: none; max-height: 0; overflow: hidden; opacity: 0; color: transparent;">${escapeEmailHtml(preheader)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width: 100%; background-color: #f3f6fa;">
    <tr><td align="center" style="padding: 28px 12px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width: 100%; max-width: 640px; background-color: #ffffff; border: 1px solid #dfe7f0; border-radius: 14px; overflow: hidden; box-shadow: 0 10px 30px rgba(22, 40, 63, 0.08);">
        <tr><td style="padding: 20px 24px; border-bottom: 1px solid #e7edf4;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
            <td width="60" valign="middle">${logoHtml}</td>
            <td valign="middle"><div style="font-size: 17px; line-height: 22px; font-weight: 800; color: #16283f;">${safeCompanyName}</div><div style="margin-top: 2px; font-size: 11px; line-height: 16px; color: #718096;">Powered by SavyTimes</div></td>
            <td align="right" valign="middle"><span style="display: inline-block; padding: 6px 10px; border-radius: 999px; background-color: #edf4ff; color: ${accentColor}; font-size: 10px; line-height: 14px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;">${escapeEmailHtml(label)}</span></td>
          </tr></table>
        </td></tr>
        <tr><td style="padding: 30px 28px 26px; background-color: #16283f;">
          <h1 style="margin: 0; color: #ffffff; font-size: 26px; line-height: 34px; font-weight: 750; letter-spacing: -0.02em;">${escapeEmailHtml(title)}</h1>
          <div style="margin-top: 12px; color: #c7d8ec; font-size: 14px; line-height: 22px;">${introHtml}</div>
        </td></tr>
        <tr><td style="padding: 28px;">${contentHtml}${ctaHtml}</td></tr>
        <tr><td style="padding: 18px 28px; background-color: #f8fafc; border-top: 1px solid #e7edf4; color: #718096; font-size: 11px; line-height: 17px;">
          This automated email was sent for <strong style="color: #526477;">${safeCompanyName}</strong> through SavyTimes. Please do not reply to this message unless your organisation has configured a reply address.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
