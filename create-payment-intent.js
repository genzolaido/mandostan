// Handles POST /api/create-payment-intent and POST /api/update-shipping
//
// Takes the cart contents from the client, recomputes the total from a
// trusted server-side price list (never trusts a client-supplied amount),
// and asks Stripe to create a PaymentIntent using the secret key, which
// lives only in this Worker's environment (Settings -> Variables and
// Secrets on the Cloudflare dashboard) — never in site code.
//
// Shipping is added in a second step: the PaymentIntent is created first
// (subtotal only, address not known yet), then once the customer fills in
// their shipping address the client calls /api/update-shipping with the
// selected country. This function recomputes subtotal + shipping fully
// server-side and updates the existing PaymentIntent's amount via the
// Stripe API — the client never gets to set the amount directly.

const PRICES_EUR_CENTS = {
  'all-roads': 2500,
  'map-ends': 2500,
  'sunskrs': 3500,
  'striped': 3500,
  'mirrored': 3500,
  'jungle-green': 2000,
  'light-pink': 2000,
  'pamir-blue': 2000,
  'savana-red': 2000,
  'night-blue': 2000,
  'mds-olympic': 2000,
  'classic': 500,
  'mirror': 500
};

// EU member states (ISO 3166-1 alpha-2). Italy is handled separately since
// it has its own (cheaper, free-over-threshold) rate.
const EU_COUNTRIES = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IE', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'
];

const SHIPPING_IT_CENTS = 300;
const SHIPPING_IT_FREE_THRESHOLD_CENTS = 4000;
const SHIPPING_EU_CENTS = 700;
const SHIPPING_WORLD_CENTS = 1600;

function computeShippingCents(countryCode, subtotalCents) {
  const cc = String(countryCode || '').toUpperCase();
  if (cc === 'IT') {
    return subtotalCents >= SHIPPING_IT_FREE_THRESHOLD_CENTS ? 0 : SHIPPING_IT_CENTS;
  }
  if (EU_COUNTRIES.includes(cc)) {
    return SHIPPING_EU_CENTS;
  }
  return SHIPPING_WORLD_CENTS;
}

function computeSubtotalCents(items) {
  let subtotal = 0;
  const descriptionParts = [];
  for (const item of items) {
    const slug = String(item.slug || '');
    const unit = PRICES_EUR_CENTS[slug];
    if (!unit) {
      throw new Error('Unknown product: ' + slug);
    }
    const qty = Math.max(1, Math.min(10, parseInt(item.qty, 10) || 1));
    subtotal += unit * qty;
    descriptionParts.push(slug + ' x' + qty + (item.size ? ' (' + item.size + ')' : ''));
  }
  return { subtotal, descriptionParts };
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function handleCreatePaymentIntent(request, env) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  if (!env.STRIPE_SECRET_KEY) {
    return json({ error: 'Payments are not configured yet on this deployment.' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'Invalid request body' }, 400);
  }

  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) {
    return json({ error: 'Cart is empty' }, 400);
  }

  let subtotal, descriptionParts;
  try {
    ({ subtotal, descriptionParts } = computeSubtotalCents(items));
  } catch (e) {
    return json({ error: e.message }, 400);
  }

  if (subtotal < 50) {
    return json({ error: 'Invalid order amount' }, 400);
  }

  // Shipping isn't known yet at this point (address not collected), so the
  // PaymentIntent starts out at the items subtotal only. It gets bumped up
  // by /api/update-shipping once the customer enters their address. The
  // full item list is stashed in metadata (compact, human-readable) so the
  // payment_intent.succeeded webhook can build a real order confirmation
  // email without needing a database.
  const itemsSummary = descriptionParts.join(', ').slice(0, 490);
  const params = new URLSearchParams();
  params.append('amount', String(subtotal));
  params.append('currency', 'eur');
  params.append('description', 'Mandostan order: ' + descriptionParts.join(', '));
  params.append('automatic_payment_methods[enabled]', 'true');
  params.append('metadata[items]', itemsSummary);
  params.append('metadata[subtotal]', String(subtotal));

  let stripeRes;
  try {
    stripeRes = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
  } catch (e) {
    return json({ error: 'Could not reach Stripe' }, 502);
  }

  const data = await stripeRes.json();

  if (!stripeRes.ok) {
    const msg = (data && data.error && data.error.message) || 'Stripe error';
    return json({ error: msg }, 500);
  }

  return json({ clientSecret: data.client_secret, amount: subtotal });
}

export async function handleUpdateShipping(request, env) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  if (!env.STRIPE_SECRET_KEY) {
    return json({ error: 'Payments are not configured yet on this deployment.' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'Invalid request body' }, 400);
  }

  const paymentIntentId = String(body.paymentIntentId || '');
  const items = Array.isArray(body.items) ? body.items : [];
  const country = String(body.country || '');
  const email = String(body.email || '').trim();

  if (!paymentIntentId.startsWith('pi_')) {
    return json({ error: 'Invalid payment intent' }, 400);
  }
  if (!items.length) {
    return json({ error: 'Cart is empty' }, 400);
  }
  if (!country && !email) {
    return json({ error: 'Country or email is required' }, 400);
  }

  let subtotal, descriptionParts;
  try {
    ({ subtotal, descriptionParts } = computeSubtotalCents(items));
  } catch (e) {
    return json({ error: e.message }, 400);
  }

  const params = new URLSearchParams();
  let shipping = null;
  let amount = subtotal;

  // Only recompute (and charge) shipping once we actually know the
  // destination country — an email-only update must never touch amount.
  if (country) {
    shipping = computeShippingCents(country, subtotal);
    amount = subtotal + shipping;
    params.append('amount', String(amount));
    params.append('metadata[country]', country);
    params.append('metadata[shipping]', String(shipping));
  }

  if (email) {
    params.append('receipt_email', email);
    params.append('metadata[email]', email.slice(0, 490));
  }

  params.append('metadata[items]', descriptionParts.join(', ').slice(0, 490));
  params.append('metadata[subtotal]', String(subtotal));

  let stripeRes;
  try {
    stripeRes = await fetch('https://api.stripe.com/v1/payment_intents/' + encodeURIComponent(paymentIntentId), {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.STRIPE_SECRET_KEY,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
  } catch (e) {
    return json({ error: 'Could not reach Stripe' }, 502);
  }

  const data = await stripeRes.json();

  if (!stripeRes.ok) {
    const msg = (data && data.error && data.error.message) || 'Stripe error';
    return json({ error: msg }, 500);
  }

  return json({ subtotal: subtotal, shipping: shipping, amount: amount });
}

export { computeSubtotalCents, computeShippingCents, PRICES_EUR_CENTS };
