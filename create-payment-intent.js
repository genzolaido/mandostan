// Handles POST /api/create-payment-intent
//
// Takes the cart contents from the client, recomputes the total from a
// trusted server-side price list (never trusts a client-supplied amount),
// and asks Stripe to create a PaymentIntent using the secret key, which
// lives only in this Worker's environment (Settings -> Variables and
// Secrets on the Cloudflare dashboard) — never in site code.

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

  let amount = 0;
  const descriptionParts = [];

  for (const item of items) {
    const slug = String(item.slug || '');
    const unit = PRICES_EUR_CENTS[slug];
    if (!unit) {
      return json({ error: 'Unknown product: ' + slug }, 400);
    }
    const qty = Math.max(1, Math.min(10, parseInt(item.qty, 10) || 1));
    amount += unit * qty;
    descriptionParts.push(slug + ' x' + qty + (item.size ? ' (' + item.size + ')' : ''));
  }

  if (amount < 50) {
    return json({ error: 'Invalid order amount' }, 400);
  }

  const params = new URLSearchParams();
  params.append('amount', String(amount));
  params.append('currency', 'eur');
  params.append('description', 'Mandostan order: ' + descriptionParts.join(', '));
  params.append('automatic_payment_methods[enabled]', 'true');

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

  return json({ clientSecret: data.client_secret, amount: amount });
}
