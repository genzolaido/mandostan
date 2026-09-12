import { handleCreatePaymentIntent, handleUpdateShipping } from './create-payment-intent.js';
import { handleStripeWebhook } from './stripe-webhook.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/create-payment-intent') {
      return handleCreatePaymentIntent(request, env);
    }

    if (url.pathname === '/api/update-shipping') {
      return handleUpdateShipping(request, env);
    }

    if (url.pathname === '/api/stripe-webhook') {
      return handleStripeWebhook(request, env);
    }

    // Everything else is a static file (index.html, shop.html, cart.html,
    // history.html, home.html, privacy.html, termini.html, ...).
    return env.ASSETS.fetch(request);
  }
};
