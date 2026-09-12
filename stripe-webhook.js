// Handles POST /api/stripe-webhook
//
// Stripe calls this URL directly (server to server) whenever something
// happens on an order — we only care about `payment_intent.succeeded`.
// On that event we build a Mandostan-branded HTML receipt from the
// PaymentIntent's metadata (stashed there by create-payment-intent.js /
// the shipping update step) and send it via Resend.
//
// Two secrets are required, both set only in the Cloudflare dashboard
// (Settings -> Variables and Secrets) — never in site code or chat:
//   STRIPE_WEBHOOK_SECRET  — the "Signing secret" Stripe shows you when
//                            you create the webhook endpoint in its
//                            dashboard. Used to verify a request genuinely
//                            came from Stripe (anyone could otherwise POST
//                            a fake "payment succeeded" here).
//   RESEND_API_KEY         — API key from your Resend account, used to
//                            actually send the email.

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sigBuf)).map(function (b) {
    return b.toString(16).padStart(2, '0');
  }).join('');
}

// Verifies the `Stripe-Signature` header per Stripe's documented scheme:
// header looks like "t=<timestamp>,v1=<hex signature>[,v1=<hex signature>...]"
// and the signed payload is "<timestamp>.<raw body>".
async function verifyStripeSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const parts = signatureHeader.split(',').reduce(function (acc, part) {
    const [k, v] = part.split('=');
    if (k === 't') acc.t = v;
    if (k === 'v1') { acc.v1 = acc.v1 || []; acc.v1.push(v); }
    return acc;
  }, {});
  if (!parts.t || !parts.v1 || !parts.v1.length) return false;

  // Reject signatures older than 5 minutes to guard against replay.
  const age = Math.abs(Date.now() / 1000 - Number(parts.t));
  if (!Number.isFinite(age) || age > 300) return false;

  const expected = await hmacSha256Hex(secret, parts.t + '.' + rawBody);
  return parts.v1.some(function (sig) {
    return sig.length === expected.length && timingSafeEqual(sig, expected);
  });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function formatEur(cents) {
  return '€' + (Number(cents || 0) / 100).toFixed(2);
}

function buildReceiptHtml(pi) {
  const md = pi.metadata || {};
  const items = esc(md.items || '');
  const subtotal = md.subtotal ? Number(md.subtotal) : pi.amount;
  const shipping = md.shipping ? Number(md.shipping) : 0;
  const total = pi.amount;
  const orderId = pi.id;

  const shippingAddr = pi.shipping && pi.shipping.address ? pi.shipping.address : null;
  const addressBlock = shippingAddr ? [
    esc(pi.shipping.name || ''),
    esc(shippingAddr.line1 || ''),
    shippingAddr.line2 ? esc(shippingAddr.line2) : '',
    esc([shippingAddr.postal_code, shippingAddr.city].filter(Boolean).join(' ')),
    esc([shippingAddr.state, shippingAddr.country].filter(Boolean).join(', '))
  ].filter(Boolean).join('<br>') : '';

  return (
    '<div style="background:#000000;padding:40px 20px;font-family:-apple-system,BlinkMacSystemFont,\'Helvetica Neue\',Helvetica,Arial,sans-serif;">' +
      '<div style="max-width:480px;margin:0 auto;">' +
        '<div style="text-align:center;margin-bottom:36px;">' +
          '<img src="https://mandostan.net/mandostan-wordmark.png" alt="Mandostan" width="180" style="display:inline-block;height:auto;max-width:180px;">' +
        '</div>' +
        '<div style="color:#f0e6c8;font-size:18px;font-weight:700;margin-bottom:6px;">Thank you for your order</div>' +
        '<div style="color:rgba(240,230,200,0.5);font-size:12px;margin-bottom:30px;">Order ' + esc(orderId) + '</div>' +
        '<div style="border-top:0.5px solid rgba(240,230,200,0.2);border-bottom:0.5px solid rgba(240,230,200,0.2);padding:18px 0;margin-bottom:20px;color:rgba(240,230,200,0.85);font-size:13px;line-height:1.7;">' +
          items +
        '</div>' +
        '<table style="width:100%;font-size:13px;color:rgba(240,230,200,0.75);border-collapse:collapse;">' +
          '<tr><td style="padding:4px 0;">Subtotal</td><td style="padding:4px 0;text-align:right;">' + formatEur(subtotal) + '</td></tr>' +
          '<tr><td style="padding:4px 0;">Shipping</td><td style="padding:4px 0;text-align:right;">' + (shipping === 0 ? 'Free' : formatEur(shipping)) + '</td></tr>' +
          '<tr><td style="padding:10px 0 0;color:#d4af37;font-weight:700;font-size:15px;">Total</td><td style="padding:10px 0 0;text-align:right;color:#d4af37;font-weight:700;font-size:15px;">' + formatEur(total) + '</td></tr>' +
        '</table>' +
        (addressBlock ? (
          '<div style="margin-top:30px;padding-top:20px;border-top:0.5px solid rgba(240,230,200,0.2);color:rgba(240,230,200,0.55);font-size:12px;line-height:1.7;">' +
            '<div style="text-transform:uppercase;letter-spacing:0.08em;font-size:10px;color:rgba(240,230,200,0.4);margin-bottom:8px;">Shipping to</div>' +
            addressBlock +
          '</div>'
        ) : '') +
        '<div style="margin-top:40px;text-align:center;color:#d4af37;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;">Eternal glory to Mandostan</div>' +
        '<div style="margin-top:10px;text-align:center;color:rgba(240,230,200,0.35);font-size:10px;letter-spacing:0.06em;">mandostan.net</div>' +
      '</div>' +
    '</div>'
  );
}

export async function handleStripeWebhook(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }
  if (!env.STRIPE_WEBHOOK_SECRET || !env.RESEND_API_KEY) {
    return new Response('Webhook not configured', { status: 500 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get('Stripe-Signature');
  const valid = await verifyStripeSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) {
    return new Response('Invalid signature', { status: 400 });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return new Response('Invalid payload', { status: 400 });
  }

  if (event.type !== 'payment_intent.succeeded') {
    // Not an event we care about — acknowledge so Stripe stops retrying it.
    return new Response('ok', { status: 200 });
  }

  const pi = event.data && event.data.object;
  const to = pi && (pi.receipt_email || (pi.metadata && pi.metadata.email));
  if (!pi || !to) {
    return new Response('ok', { status: 200 });
  }

  const html = buildReceiptHtml(pi);

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Mandostan <orders@mandostan.net>',
        to: [to],
        subject: 'Your Mandostan order is confirmed',
        html: html
      })
    });
  } catch (e) {
    // Swallow — Stripe considers the webhook handled either way; a failed
    // email send shouldn't cause Stripe to keep retrying the whole event.
  }

  return new Response('ok', { status: 200 });
}
