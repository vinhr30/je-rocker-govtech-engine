/**
 * J.E. Rocker - Master Semantic Auto-Responder Template Engine
 * Location: server/semantic-autoresponder.js
 * Hardware Node: Mac Miller
 */

const express = require('express');
const router = express.Router();

// HARDWIRED PRODUCTION STRIPE LINKS
const STRIPE_LINKS = {
    veteran: "https://buy.stripe.com/7sY9AT9Na09O7x6flBbll00",
    civilian: "https://buy.stripe.com/8x27sLaRe09O9FeflBbll01"
};

function generateAutoresponder(first_name, candidate_type, match_count) {
    // Strict input validation
    if (!first_name || !candidate_type) {
        throw new Error("Missing required tracking parameters: first_name or candidate_type.");
    }

    const count = match_count || 0;
    const isVeteran = String(candidate_type).toLowerCase() === 'veteran';
    const launch_offer = isVeteran ? '$99 Semantic Normalization Upgrade' : '$149 Semantic Normalization Upgrade';
    const subject = "Resume Received: Local Ingestion Complete | J.E. Rocker Match Evaluation";
    let body = "";

    if (isVeteran) {
        body = `Dear ${first_name},

First and foremost, thank you for your service to our nation. 

I am writing to personally confirm that your resume payload has been safely received and processed through our localized data gateway here in Phoenix. Your data is completely secure, and we enforce a strict 100% data privacy, zero-cloud commitment.

INITIAL MAIN CORE EVALUATION:
- Status: Verified U.S. Military Veteran
- Local Core Search: Run complete across 63,711 live opportunities
- Initial Match Profile: ${count} qualified targets found above baseline floor

CRITICAL STRUCTURAL OBSERVATION:
Our local neural matchmaking models ran your profile context against major aerospace, technology, and defense primes. Your vector relevance score is currently bottlenecked because highly valuable tactical experience (such as your operations supervision and diagnostic latency milestones) is currently buried in non-standard military terminology that corporate ATS systems routinely flag or drop. 

👉 OUR LAUNCH PROMOTIONAL UPSELL UPGRADE:
For an introductory promotional fee of $99, our local team will deploy our advanced semantic normalization taxonomy engine directly to your file. We will:
1. De-militarize all command and hardware jargon into clear, high-yield enterprise tech terms.
2. Hardwire explicit skill and telemetry tags (like Systems Engineering, NOC Operations, and CI/CD tools) straight into your text layout.
3. Instantly re-run our 63,000+ vector collection to maximize your matching density.

To authorize this semantic upgrade and immediately scale your visibility across our active hiring corridors, click your secure checkout link here to complete your transaction:
${STRIPE_LINKS.veteran}

Once payment clears, our local cluster will instantly unlock your offline LLM rewrite pipeline and launch your automated Microsoft Word review environment.

Welcome to the Launchpad.

Best regards,

Vinh L. Rocker
Founder & CEO | J.E. Rocker
📱 480-414-9915
📧 JEROCKER@outlook.com`;

    } else {
        // Civilian Track Template Layout
        body = `Hi ${first_name},

I am confirming that your professional resume has been successfully processed through our local systems operations gateway. Your file is completely secure, and your record has been assigned an encrypted candidate tracking ID inside our secure database.

INITIAL MAIN CORE EVALUATION:
- Status: Civilian Professional Profile
- Local Core Search: Run complete across 63,711 live opportunities
- Initial Match Profile: ${count} qualified targets found above baseline floor

CRITICAL STRUCTURAL OBSERVATION:
Our system executed a multi-format text analysis across our 63,000+ enterprise listings. While your background holds clear technical competency, your file currently features sparse job metadata formatting, which prevents our vector rankers from cleanly mapping your skills to high-yield positions. Your tools are getting buried in unformatted blocks, which will cause your application to drop out of automated corporate recruitment filters.

👉 OUR LAUNCH PROMOTIONAL UPSELL UPGRADE:
For an introductory fee of $149, we will run your text layout through our custom Regex Taxonomy-v1 Engine. We will reconstruct your layout, isolate your tools (such as Python, AWS, Git, and Docker), and inject dense infrastructure tokens to maximize your visibility with corporate recruiters.

To authorize this semantic upgrade and immediately scale your visibility across our active hiring corridors, click your secure checkout link here to complete your transaction:
${STRIPE_LINKS.civilian}

Best regards,

Vinh L. Rocker
Founder & CEO | J.E. Rocker
📱 480-414-9915
📧 JEROCKER@outlook.com`;
    }

    // Explicitly override any legacy placeholder stubs if present
    body = body
        .split('https://stripe.com')
        .join(isVeteran ? STRIPE_LINKS.veteran : STRIPE_LINKS.civilian);

    return { subject, body, launch_offer, candidate_type, first_name, match_count: count };
}

function generateReceipt(candidate_id, first_name, candidate_type) {
    if (!first_name || !candidate_type) {
        throw new Error("Missing required parameters: first_name or candidate_type.");
    }

    const isVeteran = String(candidate_type).toLowerCase() === 'veteran';
    const amount = isVeteran ? "$99.00" : "$149.00";
    const tierName = isVeteran ? "Veteran Semantic Normalization Upgrade" : "Civilian Technical Resume Normalization Upgrade";
    const rawId = String(candidate_id || '').trim();
    const tokenFragment = rawId.length >= 8 
        ? rawId.substring(0, 8).toUpperCase()
        : Math.random().toString(36).substring(2, 10).toUpperCase();
    const orderRef = `JER-SEMAN-${tokenFragment}`;
    const dateFormatted = new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC';

    const subject = `Payment Confirmed: Order ${orderRef} | J.E. Rocker Semantic Normalization Engine`;

    const body = `Dear ${first_name},

Thank you for your business. We have successfully processed and verified your transaction.

==================================================
           PAYMENT CONFIRMATION & RECEIPT
==================================================
Order Reference: ${orderRef}
Date / Timestamp: ${dateFormatted}
Candidate Type:  ${isVeteran ? 'U.S. Military Veteran' : 'Civilian Professional'}
Service Package: ${tierName}
Amount Paid:     ${amount} USD
Payment Status:  PAID IN FULL (Verified via Stripe Gateway)
Delivery Node:   Phoenix Main Core (100% Local / Zero-Cloud)
==================================================

WHAT HAPPENS NEXT — 3-STEP PROCESSING QUEUE:
1. Parsing:
   Our local cluster extracts and classifies your full raw competencies, telemetry metrics, and career history.
2. Core Matrix Match:
   We de-jargonize your technical background and run high-density vector alignment against our live database of 63,000+ prime defense and aerospace opportunities.
3. Outbound Pitching:
   We synthesize and deliver your candidate dossier directly to scouted corporate talent acquisition leads and hiring authorities.

EXPLICIT DELIVERY COMMITMENT:
Your fully normalized, ATS-optimized Word document and initial high-yield target match dossier will be delivered to your inbox within twenty-four (24) business hours.

If you have any questions or need immediate adjustments to your candidate profile, reply directly to this message.

Welcome to the Launchpad.

Best regards,

Vinh L. Rocker
Founder & CEO | J.E. Rocker
📱 480-414-9915
📧 JEROCKER@outlook.com`;

    return {
        order_reference: orderRef,
        candidate_id: rawId,
        first_name,
        candidate_type,
        amount,
        payment_status: "PAID IN FULL",
        subject,
        body
    };
}

router.post('/api/headhunter/semantic-autoresponder', (req, res) => {
    const { first_name, candidate_type, match_count } = req.body || {};

    // Strict input validation
    if (!first_name || !candidate_type) {
        return res.status(400).json({ error: "Missing required tracking parameters: first_name or candidate_type." });
    }

    try {
        const result = generateAutoresponder(first_name, candidate_type, match_count);
        return res.status(200).json({
            subject: result.subject,
            body: result.body,
            responder: result,
            stripe_links: STRIPE_LINKS
        });
    } catch (error) {
        return res.status(400).json({ error: error.message });
    }
});

router.post('/api/headhunter/receipt', (req, res) => {
    const { candidate_id, first_name, candidate_type } = req.body || {};

    if (!first_name || !candidate_type) {
        return res.status(400).json({ error: "Missing required tracking parameters: first_name or candidate_type." });
    }

    try {
        const receipt = generateReceipt(candidate_id, first_name, candidate_type);
        return res.status(200).json({
            order_reference: receipt.order_reference,
            subject: receipt.subject,
            body: receipt.body,
            receipt
        });
    } catch (error) {
        return res.status(400).json({ error: error.message });
    }
});

function buildSemanticAutoresponder(payload) {
    const { candidate_type, first_name, match_count } = payload || {};
    return generateAutoresponder(first_name, candidate_type, match_count);
}

function buildPaymentReceipt(payload) {
    const { candidate_id, candidate_type, first_name } = payload || {};
    return generateReceipt(candidate_id, first_name, candidate_type);
}

router.buildSemanticAutoresponder = buildSemanticAutoresponder;
router.buildPaymentReceipt = buildPaymentReceipt;
router.generateAutoresponder = generateAutoresponder;
router.generateReceipt = generateReceipt;
router.STRIPE_LINKS = STRIPE_LINKS;

module.exports = router;
module.exports.STRIPE_LINKS = STRIPE_LINKS;
module.exports.buildSemanticAutoresponder = buildSemanticAutoresponder;
module.exports.buildPaymentReceipt = buildPaymentReceipt;
module.exports.generateAutoresponder = generateAutoresponder;
module.exports.generateReceipt = generateReceipt;
