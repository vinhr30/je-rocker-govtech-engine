/**
 * Business 1 (GovTech Contracts & Procurement Intelligence)
 * Commercial Layer & Client Intake Module
 * 
 * Strict Namespace: GovTech
 * Isolation Guarantee: Never imports or references veteran_intake.json, b2b_leads.json, or deal_ledger.json.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { renderGovtechDashboard } = require('../../govtech-modules/controllers/govtech_dashboard');
const { renderGovtechPipeline } = require('../../govtech-modules/controllers/govtech_pipeline');

const GOVTECH_PRICING_PATH = path.join(__dirname, '../../pricing/govtech_pricing.json');
const GOVTECH_CLIENTS_PATH = path.join(__dirname, '../../data/govtech_clients.json');
const UPLOADS_DIR = path.join(__dirname, '../../uploads/govtech');

function loadGovtechPricing() {
  if (fs.existsSync(GOVTECH_PRICING_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(GOVTECH_PRICING_PATH, 'utf8'));
    } catch (e) {
      console.error(`[govtech] Error reading pricing: ${e.message}`);
    }
  }
  return {
    namespace: 'govtech',
    pricing_model: {
      readiness: { product_id: 'govtech_readiness_499', name: 'GovTech Readiness Package', price: 499.00, billing_type: 'one-time', checkout_route: '/govtech-checkout/readiness' },
      intel: { product_id: 'govtech_intel_149_monthly', name: 'GovTech Intelligence Subscription', price: 149.00, billing_type: 'monthly', checkout_route: '/govtech-checkout/intel' },
      proposal: { product_id: 'govtech_proposal_399', name: 'GovTech Proposal Support', price: 399.00, billing_type: 'per-proposal', checkout_route: '/govtech-checkout/proposal' },
      retainer: { product_id: 'govtech_retainer_999_monthly', name: 'GovTech Retainer', price: 999.00, billing_type: 'monthly', checkout_route: '/govtech-checkout/retainer' }
    }
  };
}

function readGovtechClients() {
  if (!fs.existsSync(GOVTECH_CLIENTS_PATH)) {
    return { namespace: 'govtech', clients: [] };
  }
  try {
    const data = JSON.parse(fs.readFileSync(GOVTECH_CLIENTS_PATH, 'utf8'));
    if (!data.clients || !Array.isArray(data.clients)) {
      return { namespace: 'govtech', clients: [] };
    }
    return data;
  } catch (e) {
    return { namespace: 'govtech', clients: [] };
  }
}

function writeGovtechClients(store) {
  fs.mkdirSync(path.dirname(GOVTECH_CLIENTS_PATH), { recursive: true });
  const tmpPath = `${GOVTECH_CLIENTS_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmpPath, GOVTECH_CLIENTS_PATH);
}

function registerGovtechCommercialRoutes(app) {
  // Configure EJS view directory & engine for views/
  app.set('views', path.join(__dirname, '../../views'));
  app.set('view engine', 'ejs');

  // 1. GET /govtech -> Public-Facing GovTech Landing Page
  app.get('/govtech', (req, res) => {
    const pricing = loadGovtechPricing();
    res.render('govtech-landing', { pricing });
  });

  // 2. GET /govtech-intake -> Render views/govtech-intake.ejs
  app.get('/govtech-intake', (req, res) => {
    const pricing = loadGovtechPricing();
    res.render('govtech-intake', { pricing });
  });

  // 3. GET /govtech-dashboard -> Cockpit Operations Tile & Table
  app.get('/govtech-dashboard', renderGovtechDashboard);

  // 4. GET /govtech-pipeline -> GovTech CRM Pipeline & Revenue Ledger
  app.get('/govtech-pipeline', renderGovtechPipeline);

  // 5. POST /govtech-intake -> Save client and redirect to appropriate checkout route
  app.post('/govtech-intake', (req, res) => {
    try {
      const {
        business_name,
        owner_name,
        veteran_owned,
        sam_status,
        uei,
        naics_codes,
        website,
        target_states,
        target_agencies,
        proposal_budget,
        preferred_plan
      } = req.body;

      if (!business_name || !owner_name) {
        return res.status(400).send('Business Name and Owner Name are required.');
      }

      const client_id = 'GTC-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      const planKey = (preferred_plan || 'readiness').toLowerCase();

      const newClient = {
        client_id,
        namespace: 'govtech',
        business_name: String(business_name).trim(),
        owner_name: String(owner_name).trim(),
        veteran_owned: String(veteran_owned).toLowerCase() === 'yes',
        sam_status: String(sam_status || 'not_registered'),
        uei: String(uei || '').trim().toUpperCase(),
        naics_codes: String(naics_codes || '').split(',').map(s => s.trim()).filter(Boolean),
        website: String(website || '').trim(),
        target_states: String(target_states || 'AZ, CA, TX, FL, VA, NY').split(',').map(s => s.trim()).filter(Boolean),
        target_agencies: String(target_agencies || '').split(',').map(s => s.trim()).filter(Boolean),
        proposal_budget: String(proposal_budget || 'under_25k'),
        preferred_plan: planKey,
        selected_plan: planKey,
        onboarding_status: 'pending_payment',
        timestamp: new Date().toISOString(),
        created_at: new Date().toISOString()
      };

      const store = readGovtechClients();
      store.clients.unshift(newClient);
      writeGovtechClients(store);

      console.info(`[govtech] Client registered: ${newClient.client_id} (${newClient.business_name}). Redirecting to plan: ${planKey}`);

      // Map to target checkout route
      const checkoutRoutes = {
        readiness: '/govtech-checkout/readiness',
        intel: '/govtech-checkout/intel',
        proposal: '/govtech-checkout/proposal',
        retainer: '/govtech-checkout/retainer'
      };

      const targetRoute = checkoutRoutes[planKey] || '/govtech-checkout/readiness';
      return res.redirect(`${targetRoute}?client_id=${client_id}`);
    } catch (error) {
      console.error(`[govtech] Intake error: ${error.message}`);
      return res.status(500).send(`GovTech Intake Error: ${error.message}`);
    }
  });

  // 3. Direct Stripe Checkout Redirect Routes for the 4 Products
  const STRIPE_CHECKOUT_URLS = {
    readiness: 'https://buy.stripe.com/00w7sL3oM9Ko5oYdAtbII02',
    intel: 'https://buy.stripe.com/14A14n0cA6yc3gQdAtbII03',
    proposal: 'https://buy.stripe.com/fZu14n2kI8Gk5oYgMFbII04',
    retainer: 'https://buy.stripe.com/8x200j0cA2hWg3CdAtbII05'
  };

  // GovTech Readiness Package - $499
  app.get('/govtech-checkout/readiness', (req, res) => {
    const clientId = req.query.client_id || 'unknown';
    console.log(`Redirecting GovTech client ${clientId} to Readiness checkout`);
    res.redirect(STRIPE_CHECKOUT_URLS.readiness);
  });

  // GovTech Intelligence Subscription - $149/mo
  app.get('/govtech-checkout/intel', (req, res) => {
    const clientId = req.query.client_id || 'unknown';
    console.log(`Redirecting GovTech client ${clientId} to Intelligence checkout`);
    res.redirect(STRIPE_CHECKOUT_URLS.intel);
  });

  // GovTech Proposal Support - $399
  app.get('/govtech-checkout/proposal', (req, res) => {
    const clientId = req.query.client_id || 'unknown';
    console.log(`Redirecting GovTech client ${clientId} to Proposal checkout`);
    res.redirect(STRIPE_CHECKOUT_URLS.proposal);
  });

  // GovTech Retainer - $999/mo
  app.get('/govtech-checkout/retainer', (req, res) => {
    const clientId = req.query.client_id || 'unknown';
    console.log(`Redirecting GovTech client ${clientId} to Retainer checkout`);
    res.redirect(STRIPE_CHECKOUT_URLS.retainer);
  });

  // 4. API endpoint to record payment metadata in govtech_clients.json
  app.post('/api/govtech/confirm-payment', (req, res) => {
    try {
      const { client_id, product_id, status } = req.body || {};
      const store = readGovtechClients();
      const client = store.clients.find(c => c.client_id === client_id);
      if (client) {
        client.onboarding_status = status || 'active';
        client.active_product = product_id;
        client.payment_verified_at = new Date().toISOString();
        writeGovtechClients(store);
      }
      return res.status(200).json({ success: true, client });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });
}

module.exports = {
  registerGovtechCommercialRoutes,
  loadGovtechPricing,
  readGovtechClients,
  writeGovtechClients
};
