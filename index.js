import { handleCreatePaymentIntent } from './create-payment-intent.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/create-payment-intent') {
      return handleCreatePaymentIntent(request, env);
    }

    // Everything else is a static file (index.html, shop.html, cart.html,
    // history.html, home.html, privacy.html, termini.html, ...).
    return env.ASSETS.fetch(request);
  }
};
