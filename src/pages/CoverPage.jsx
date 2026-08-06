import { useState } from 'react';

const HERO_BUTTONS = [
  { href: '/primary-dashboard', label: 'Primary Dashboard' },
  { href: '/client-dashboard', label: 'Client Dashboard' },
  { href: '/business-driver', label: 'Business Driver Page' },
];

const INFO_CARDS = [
  {
    id: 'who',
    icon: '🏛️',
    title: 'Who We Are',
    summary: 'Federal business consultants translating procurement complexity into practical decisions.',
    details: 'JE ROCKER LC is a federal business consulting firm powered by contract intelligence.',
    bullets: [
      'Consulting-first advisory model for federal market entry',
      'Data-driven assessment of opportunity fit and timing',
      'Designed for small business execution speed',
    ],
  },
  {
    id: 'deliver',
    icon: '📊',
    title: 'What We Deliver',
    summary: 'Weekly intelligence and capture guidance focused on actionable pursuit decisions.',
    details: 'Weekly intelligence, opportunity interpretation, capture strategy, competitive landscape, spend analysis, and proposal readiness.',
    bullets: [
      'Opportunity interpretation with match-context signals',
      'Competitive and spend landscape snapshots',
      'Proposal readiness checkpoints and task framing',
    ],
  },
  {
    id: 'works',
    icon: '⚙️',
    title: 'How It Works',
    summary: 'A recurring engine pipeline that refreshes signals and produces consulting-ready outputs.',
    details: 'Our engine refreshes weekly, analyzes federal opportunities, matches vendors, and generates actionable insights.',
    bullets: [
      'Weekly ingestion and normalization cycle',
      'Automated matching and confidence scoring',
      'Decision-ready outputs for internal and client dashboards',
    ],
  },
  {
    id: 'matters',
    icon: '🎯',
    title: 'Why It Matters',
    summary: 'Small businesses need clarity on agency behavior to compete with focus and confidence.',
    details: 'We help small businesses understand federal buying behavior, identify real opportunities, and compete with confidence.',
    bullets: [
      'Reduce noise and prioritize realistic pursuits',
      'Improve timing with agency and vendor behavior context',
      'Support disciplined capture planning under resource constraints',
    ],
  },
];

export const coverPageMeta = {
  route: '/cover',
  title: 'JE ROCKER LC',
  footer: ['About', 'Contact', 'Privacy', 'Terms'],
};

export function CoverPage() {
  const [expandedCard, setExpandedCard] = useState(null);

  return (
    <div className="cover-hero-container">
      <section className="hero">
        <h1 className="cover-hero-title">JE ROCKER LC</h1>
        <div className="cover-hero-underline" aria-hidden="true" />
        <p className="cover-hero-tagline">Federal Business Consulting & Contract Intelligence</p>
        <p className="cover-hero-microtagline">Powered by the JE ROCKER Intelligence Engine</p>

        <div className="cover-hero-buttons">
          {HERO_BUTTONS.map((button) => (
            <a className="cover-button" href={button.href} key={button.href}>
              {button.label}
            </a>
          ))}
        </div>
      </section>

      <div className="cover-divider-band" aria-hidden="true" />

      <section className="cover-grid-block">
        <div className="cover-info-grid">
          {INFO_CARDS.map((card) => {
            const isExpanded = expandedCard === card.id;
            return (
              <article
                key={card.id}
                className={`cover-info-card ${isExpanded ? 'cover-info-card-expanded' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => setExpandedCard(card.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setExpandedCard(card.id);
                  }
                }}
              >
                <div className="cover-card-header">
                  <span className="cover-info-card-icon" aria-hidden="true">{card.icon}</span>
                  <h3>{card.title}</h3>
                </div>

                <p>{card.summary}</p>

                <div className="cover-card-expand-wrap">
                  <div className={`cover-card-expand ${isExpanded ? 'is-open' : ''}`}>
                    <p>{card.details}</p>
                    <ul>
                      {card.bullets.map((bullet) => (
                        <li key={bullet}>{bullet}</li>
                      ))}
                    </ul>
                    <button
                      type="button"
                      className="cover-collapse-btn"
                      onClick={(event) => {
                        event.stopPropagation();
                        setExpandedCard(null);
                      }}
                    >
                      Collapse
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <p className="cover-footer-tagline">JE ROCKER LC • Federal Consulting Powered by Technology</p>
      <div className="footer-links">
        <span>About</span>
        <span>Contact</span>
        <span>Privacy</span>
        <span>Terms</span>
      </div>
    </div>
  );
}

export default CoverPage;
