# J.E. Rocker & Associates | Master B2B Corporate Placement Invoice

**Document ID**: `DOC-B2B-INV-001`  
**Classification**: Proprietary Commercial Billing Asset  
**Business Line**: Business #2 (AI Headhunter / Corporate Placement Funnel) & Business #3 (Executive Matchmaker)  
**Standard Contingency Placement Rate**: 20.00% of Verified Gross Annualized Base Salary  
**Payment Terms**: Net 30 (Strictly Enforced)  
**Target Recipient**: Target Prime Corporate Accounts Payable / Talent Acquisition Finance  

---

## 1. Copy-Ready Master Placement Invoice Template

Copy the block below directly into Outlook or billing software upon candidate offer clearance:

```text
==============================================================================
🧾 J.E. ROCKER & ASSOCIATES | COMMERCIAL PLACEMENT INVOICE
==============================================================================
Date Issued:     [Date of Hire]
Invoice Number:  JER-B2B-INV-[6-Digit Random Hashed Counter]
Payment Terms:   Net 30 (Strictly Enforced)
Remittance Type: Direct ACH Wire Transfer / Corporate Check

VENDOR DETAILS:
Firm Name:       J.E. Rocker
Executive Lead:  Vinh L. Rocker, Founder & CEO
Direct Contact:  480-414-9915 | JEROCKER@outlook.com
Corporate Mail:  Phoenix, AZ, USA

CLIENT DETAILS (Debtor):
Corporate Firm:  [Target Prime Name - e.g., Lockheed Martin / RTX Corporation]
Department:      Talent Acquisition / Engineering Accounts Payable
Attn To:         [Scouted Recruiter Name - e.g., Allison Rosenberg / Mark Davis]

==============================================================================
📋 PLACEMENT REQUISITION PERFORMANCE SUMMARY
==============================================================================
Candidate Name:   [Candidate Real Full Name]
Corporate Role:   [Canonical Position Title - e.g., Systems Engineer Stf]
Placement Date:   [Candidate Official Start Date]
Verified Base:    $[Candidate Confirmed Gross Annualized Base Salary].00 USD

BILLING ITEMIZATION:
- Service Rendered: Contingency Technical Executive Sourcing & Recruitment
- Fee Percentage:   20.00% Placement Fee (Per Presentation Contract Terms)
- Subtotal Fees:    $[Annualized Base Salary * 0.20].00 USD

==============================================================================
💰 TOTAL OUTSTANDING REMITTANCE DUE: $[Annualized Base Salary * 0.20].00 USD
==============================================================================

REMITTANCE DIRECTIONS (ACH / WIRE ROUTING):
Bank Name:       [ Type Bank Name Here ]
Account Name:    J.E. Rocker
Routing Number:  [ Type 9-Digit Routing Number Here ]
Account Number:  [ Type Account Number Here ]
Reference Tag:   [Invoice Number Placeholder]

Thank you for your business. For any corporate procurement or vendor onboarding 
inquiries regarding our standard W-9 configurations, please contact our local 
operations center directly at 480-414-9915 or JEROCKER@outlook.com.
==============================================================================
```

---

## 2. Field Hydration Specifications

| Template Field | Source Location / Parameter | Example Real-World Value |
| :--- | :--- | :--- |
| `[Date of Hire]` | Offer acceptance date / Invoice generation date | `October 7, 2026` |
| `[6-Digit Random Hashed Counter]` | 6-character alphanumeric uppercase hash | `4F8A21` -> `JER-B2B-INV-4F8A21` |
| `[Target Prime Name]` | Ingested corporate target from `db/b2b_leads.json` | `Lockheed Martin Space` |
| `[Scouted Recruiter Name]` | Recruiter lead from `db/b2b_leads.json` | `Allison Rosenberg` |
| `[Candidate Real Full Name]` | Staged candidate profile from `db/veteran_intake.json` | `Marcus Vance` |
| `[Canonical Position Title]` | Matched requisition role title | `Systems Engineer Senior (Integration & Test Focus)` |
| `[Candidate Official Start Date]` | Confirmed employee onboarding start date | `November 3, 2026` |
| `[Verified Base]` | Candidate's signed offer letter gross base salary | `165,000.00` |
| `$[Annualized Base Salary * 0.20]` | 20.00% placement fee calculation | `$33,000.00 USD` |

---

## 3. Operational Workflow for Corporate Billing

1. **Offer Clearance**: Confirm the candidate has signed the corporate offer letter and successfully passed background/security clearance screening.
2. **Ledger Update**: Transition the candidate's deal in `db/deal_ledger.json` to `"current_pipeline_stage": "Contract Placed"`.
3. **Invoice Generation**: Hydrate the template with the verified annualized base salary and prime vendor information.
4. **Outbound Dispatch**:
   - Send email via Outlook to the Talent Acquisition lead with CC to Corporate Accounts Payable (`AP@[domain].com`).
   - Attach your signed standard **W-9 form** (Vendor TIN / EIN documentation).
   - Set email priority to High with payment terms Net 30.
5. **Remittance Reconciliation**: When ACH wire clears, record remittance into J.E. Rocker commercial checking and reconcile against `db/deal_ledger.json`.
