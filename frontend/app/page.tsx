'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { loadUserFromStorage } from '@/lib/auth';
import styles from './page.module.css';

type IconName = 'voice' | 'brain' | 'groups' | 'draft' | 'plan' | 'vote';

const navLinks = [
  { href: '#features', label: 'Platform' },
  { href: '#workflow', label: 'Workflow' },
  { href: '#pricing', label: 'Pricing' },
  { href: '#stories', label: 'Stories' },
];

const kpis = [
  {
    value: '92%',
    label: 'Issues routed with first-pass clarity',
    progress: 92,
    spark: '4,22 24,18 44,24 64,11 84,16 104,7',
  },
  {
    value: '4.8/5',
    label: 'Resident review sentiment',
    progress: 88,
    spark: '4,24 24,20 44,14 64,17 84,9 104,6',
  },
  {
    value: '<2m',
    label: 'Average AI draft time',
    progress: 76,
    spark: '4,8 24,13 44,9 64,19 84,15 104,22',
  },
];

const features: Array<{ icon: IconName; title: string; copy: string; tone: string }> = [
  {
    icon: 'voice',
    title: 'Voice-to-report intake',
    copy: 'Residents speak naturally while Prayaas turns noisy details into a structured civic-grade report.',
    tone: 'Large',
  },
  {
    icon: 'brain',
    title: 'AI triage engine',
    copy: 'Severity, category, location and next action are inferred before the committee opens the ticket.',
    tone: 'Fast',
  },
  {
    icon: 'groups',
    title: 'Society groups',
    copy: 'Route block, wing and facility issues to the people who can actually move them forward.',
    tone: 'Local',
  },
  {
    icon: 'draft',
    title: 'Clean drafts',
    copy: 'Every issue gets a concise title, context, affected residents and a professional summary.',
    tone: 'Clear',
  },
  {
    icon: 'plan',
    title: 'Solution plans',
    copy: 'Generate practical options with responsible owners, timelines and escalation paths.',
    tone: 'Action',
  },
  {
    icon: 'vote',
    title: 'Community voting',
    copy: 'Surface what matters most, avoid duplicate complaints and keep resolution progress visible.',
    tone: 'Aligned',
  },
];

const timeline = [
  {
    step: '01',
    title: 'Capture the signal',
    copy: 'Residents submit a voice note, quick text or formatted report from any device.',
  },
  {
    step: '02',
    title: 'Convert noise into context',
    copy: 'The AI pipeline extracts severity, stakeholders, location, evidence and recommended routing.',
  },
  {
    step: '03',
    title: 'Move the society forward',
    copy: 'Committees assign owners, collect votes and track visible progress until the issue is closed.',
  },
];

const pricing = [
  {
    tier: 'Starter',
    price: 'Free',
    summary: 'For small societies starting with transparent issue reporting.',
    features: ['1 society workspace', 'Voice and text reporting', 'Community voting', 'Basic dashboard'],
  },
  {
    tier: 'Council',
    price: 'Rs 999',
    summary: 'For active committees that need AI routing and faster closure.',
    features: ['Unlimited residents', 'AI draft and triage', 'Priority categories', 'Committee analytics'],
    featured: true,
  },
  {
    tier: 'Federation',
    price: 'Custom',
    summary: 'For multi-building groups with governance and reporting needs.',
    features: ['Multiple societies', 'Custom workflows', 'Role permissions', 'Dedicated onboarding'],
  },
];

const testimonials = [
  {
    name: 'AK',
    role: 'Treasurer, Green Vista',
    quote: 'Prayaas gave our committee one place to understand what was urgent and what was repeated noise.',
  },
  {
    name: 'SN',
    role: 'Resident, Tower B',
    quote: 'The voice report felt effortless. The final issue summary was clearer than anything I would write.',
  },
  {
    name: 'RM',
    role: 'Facility Manager',
    quote: 'We stopped losing context across chat threads. Each ticket now has owner, priority and next step.',
  },
];

const proofLogos = ['Aster Court', 'Nivaan Heights', 'Bluebell CHS', 'Urban Grove', 'Sattva One'];

function LineIcon({ name }: { name: IconName }) {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    strokeWidth: 1.6,
  };

  if (name === 'voice') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path {...common} d="M12 4a3 3 0 0 0-3 3v4a3 3 0 0 0 6 0V7a3 3 0 0 0-3-3Z" />
        <path {...common} d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v3M9 21h6" />
      </svg>
    );
  }

  if (name === 'brain') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path {...common} d="M9 4a4 4 0 0 0-4 4v8a4 4 0 0 0 4 4" />
        <path {...common} d="M15 4a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4" />
        <path {...common} d="M9 8h6M8 12h8M9 16h6M12 4v16" />
      </svg>
    );
  }

  if (name === 'groups') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path {...common} d="M12 12a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM4 20a8 8 0 0 1 16 0" />
        <path {...common} d="M18 8.5a2.5 2.5 0 0 1 0 5M6 8.5a2.5 2.5 0 0 0 0 5" />
      </svg>
    );
  }

  if (name === 'draft') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path {...common} d="M6 3h8l4 4v14H6V3Z" />
        <path {...common} d="M14 3v5h5M9 12h6M9 16h4" />
      </svg>
    );
  }

  if (name === 'plan') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path {...common} d="M5 19V5h14v14H5Z" />
        <path {...common} d="m8 12 2.2 2.2L16 8.5M8 7h3M13 17h3" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path {...common} d="M12 21s7-4 7-11V5l-7-3-7 3v5c0 7 7 11 7 11Z" />
      <path {...common} d="m9 12 2 2 4-5" />
    </svg>
  );
}

function PrayaasMark() {
  return (
    <span className={styles.logoMark} aria-hidden="true">
      <span className={styles.logoOrbit} />
      <span className={styles.logoPeople}>
        <span />
        <span />
        <span />
      </span>
      <span className={styles.logoArrow} />
    </span>
  );
}

export default function LandingPage() {
  const router = useRouter();
  const [hasUser, setHasUser] = useState(false);
  const glowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setHasUser(Boolean(loadUserFromStorage()));
    });

    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const parallaxItems = Array.from(document.querySelectorAll<HTMLElement>('[data-speed]'));
    let frame = 0;

    const updateParallax = () => {
      frame = 0;
      const scrollY = window.scrollY;
      parallaxItems.forEach((item) => {
        const speed = Number(item.dataset.speed || 0);
        item.style.transform = `translate3d(0, ${scrollY * speed}px, 0)`;
      });
    };

    const requestTick = () => {
      if (!frame) {
        frame = window.requestAnimationFrame(updateParallax);
      }
    };

    updateParallax();
    window.addEventListener('scroll', requestTick, { passive: true });

    return () => {
      window.removeEventListener('scroll', requestTick);
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, []);

  useEffect(() => {
    let frame = 0;
    let x = 0;
    let y = 0;

    const moveGlow = () => {
      frame = 0;
      if (glowRef.current) {
        glowRef.current.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      x = event.clientX - 180;
      y = event.clientY - 180;
      if (!frame) {
        frame = window.requestAnimationFrame(moveGlow);
      }
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, []);

  const goPrimary = () => router.push(hasUser ? '/dashboard' : '/register');

  return (
    <main className={styles.page}>
      <div ref={glowRef} className={styles.cursorGlow} aria-hidden="true" />

      <nav className={styles.navbar}>
        <div className={styles.navInner}>
          <a className={styles.brand} href="#top" aria-label="Prayaas home">
            <PrayaasMark />
            <span>
              <strong>Prayaas</strong>
              <small>Societal evolution</small>
            </span>
          </a>

          <div className={styles.navLinks} aria-label="Primary navigation">
            {navLinks.map((link) => (
              <a key={link.href} href={link.href}>
                {link.label}
              </a>
            ))}
          </div>

          <div className={styles.navActions}>
            <button className={styles.ghostButton} onClick={() => router.push('/login')} type="button">
              Log in
            </button>
            <button className={styles.primaryButton} onClick={goPrimary} type="button">
              {hasUser ? 'Open dashboard' : 'Start free'}
            </button>
          </div>
        </div>
      </nav>

      <section className={styles.hero} id="top">
        <div className={styles.heroOrbOne} data-speed="0.3" />
        <div className={styles.heroOrbTwo} data-speed="0.3" />
        <div className={styles.heroOrbThree} data-speed="0.3" />

        <div className={styles.heroInner}>
          <div className={styles.heroCopy}>
            <span className={styles.badge}>Powered by community intelligence</span>
            <h1 className={styles.heroTitle}>Prayaas</h1>
            <p className={styles.heroLead}>
              Working for societal evolution with an AI platform that converts resident concerns into structured
              reports, practical solutions and visible progress.
            </p>
            <div className={styles.heroActions}>
              <button className={styles.primaryButtonLarge} onClick={goPrimary} type="button">
                {hasUser ? 'Open dashboard' : 'Register your society'}
              </button>
              <button className={styles.secondaryButtonLarge} onClick={() => router.push('/login')} type="button">
                View resident portal
              </button>
            </div>
            <div className={styles.trustStrip} aria-label="Resident trust rating">
              <div className={styles.avatarStack} aria-hidden="true">
                <span>AV</span>
                <span>RS</span>
                <span>MJ</span>
                <span>NK</span>
              </div>
              <p>
                <strong>2,400+ resident reviews</strong>
                <span>Average rating 4.8 from active society members</span>
              </p>
            </div>
          </div>

          <div className={styles.societyScene} aria-label="Animated society improvement dashboard">
            <div className={styles.sceneHeader}>
              <span>Society health</span>
              <strong>Improving</strong>
            </div>
            <div className={styles.sceneGrid}>
              <span className={styles.blockOne} />
              <span className={styles.blockTwo} />
              <span className={styles.blockThree} />
              <span className={styles.blockFour} />
              <span className={styles.blockFive} />
              <span className={styles.blockSix} />
            </div>
            <div className={styles.progressPath}>
              <span />
              <span />
              <span />
            </div>
            <div className={styles.sceneMetric}>
              <small>Resolved this month</small>
              <strong>148</strong>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.kpiSection} aria-label="Prayaas platform metrics">
        <div className={styles.kpiGrid}>
          {kpis.map((kpi, index) => (
            <div className={styles.kpiParallax} data-speed="0.08" key={kpi.label}>
              <article className={`${styles.glassCard} ${styles.kpiCard}`} style={{ transitionDelay: `${index * 60}ms` }}>
                <div className={styles.kpiTopline}>
                  <strong>{kpi.value}</strong>
                  <svg viewBox="0 0 108 28" aria-hidden="true">
                    <polyline points={kpi.spark} />
                  </svg>
                </div>
                <p>{kpi.label}</p>
                <div className={styles.progressTrack} aria-hidden="true">
                  <span style={{ '--progress': `${kpi.progress}%` } as React.CSSProperties} />
                </div>
              </article>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section} id="features">
        <div className={styles.sectionHeading}>
          <span className={styles.eyebrow}>Complete platform</span>
          <h2>Every report becomes a trackable path to action.</h2>
          <p>Built for societies that need resident empathy, committee clarity and operational follow-through in one place.</p>
        </div>

        <div className={styles.featureGrid}>
          {features.map((feature, index) => (
            <article
              className={`${styles.glassCard} ${styles.featureCard} ${index === 0 ? styles.featureLarge : ''}`}
              key={feature.title}
            >
              <div className={styles.cardLabel}>{feature.tone}</div>
              <div className={styles.iconBox}>
                <LineIcon name={feature.icon} />
              </div>
              <h3>{feature.title}</h3>
              <p>{feature.copy}</p>
            </article>
          ))}
        </div>
      </section>

      <section className={`${styles.section} ${styles.workflow}`} id="workflow">
        <div className={styles.timeline}>
          <span className={styles.eyebrow}>How it works</span>
          <h2>From scattered complaints to society momentum.</h2>
          <div className={styles.timelineList}>
            {timeline.map((item) => (
              <article className={styles.timelineItem} key={item.step}>
                <span>{item.step}</span>
                <div>
                  <h3>{item.title}</h3>
                  <p>{item.copy}</p>
                </div>
              </article>
            ))}
          </div>
        </div>

        <div className={styles.stackParallax} data-speed="-0.06">
          <div className={styles.cardStack} aria-label="Layered issue resolution cards">
            <article className={`${styles.stackCard} ${styles.stackCardBack}`}>
              <span>Community vote</span>
              <strong>84 residents agree</strong>
              <p>Street lighting repair ranked as this week&apos;s top facility issue.</p>
            </article>
            <article className={`${styles.stackCard} ${styles.stackCardMid}`}>
              <span>AI solution plan</span>
              <strong>3 recommended actions</strong>
              <p>Assign electrician, inspect wiring junctions and schedule a night audit.</p>
            </article>
            <article className={`${styles.stackCard} ${styles.stackCardFront}`}>
              <span>Structured issue</span>
              <strong>Block B lights inactive</strong>
              <p>Severity high. Location mapped. Owner suggested: facility manager.</p>
            </article>
          </div>
        </div>
      </section>

      <section className={styles.section} id="pricing">
        <div className={styles.sectionHeading}>
          <span className={styles.eyebrow}>Pricing</span>
          <h2>Start lean, scale when your committee needs more control.</h2>
        </div>

        <div className={styles.pricingGrid}>
          {pricing.map((plan) => (
            <article
              className={`${styles.glassCard} ${styles.pricingCard} ${plan.featured ? styles.pricingFeatured : ''}`}
              key={plan.tier}
            >
              {plan.featured ? <span className={styles.popularPill}>Most popular</span> : null}
              <span className={styles.cardLabel}>{plan.tier}</span>
              <strong className={styles.price}>{plan.price}</strong>
              <p>{plan.summary}</p>
              <ul>
                {plan.features.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <button
                className={plan.featured ? styles.primaryButton : styles.secondaryButton}
                onClick={goPrimary}
                type="button"
              >
                Choose {plan.tier}
              </button>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.section} id="stories">
        <div className={styles.proofStrip} aria-label="Societies using Prayaas">
          {proofLogos.map((logo) => (
            <span key={logo}>{logo}</span>
          ))}
        </div>

        <div className={styles.sectionHeading}>
          <span className={styles.eyebrow}>Testimonials</span>
          <h2>Residents and committees finally see the same picture.</h2>
        </div>

        <div className={styles.testimonialGrid}>
          {testimonials.map((story) => (
            <article className={`${styles.glassCard} ${styles.testimonialCard}`} key={story.name}>
              <div className={styles.stars} aria-label="5 star rating">
                <span />
                <span />
                <span />
                <span />
                <span />
              </div>
              <p>&quot;{story.quote}&quot;</p>
              <div className={styles.person}>
                <span>{story.name}</span>
                <small>{story.role}</small>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.section} id="technology">
        <div className={styles.sectionHeading}>
          <span className={styles.eyebrow}>Technical excellence</span>
          <h2>Built on production-grade intelligence and security.</h2>
          <p>Every layer of the platform is designed for reliability, scale and accountability at the civic level.</p>
        </div>

        <div className={styles.techGrid}>
          <article className={`${styles.glassCard} ${styles.techCard}`}>
            <div className={`${styles.techPillarIcon} ${styles.techPillarBlue}`}>🧠</div>
            <h3>AI &amp; Intelligence Layer</h3>
            <ul className={styles.techList}>
              <li>Duplicate detection via semantic similarity (text-embedding-004) before saving</li>
              <li>Sentiment &amp; urgency escalation — auto-bump severity on distress language</li>
              <li>Voice language auto-detect — Hindi, Hinglish, Marathi, Tamil and 8+ languages</li>
              <li>AI-generated status updates when admins change problem state</li>
              <li>Multi-model fallback chain: gemini-2.5-flash-lite → 2.0-flash-lite → 2.0-flash</li>
            </ul>
          </article>

          <article className={`${styles.glassCard} ${styles.techCard}`}>
            <div className={`${styles.techPillarIcon} ${styles.techPillarTeal}`}>⚡</div>
            <h3>Backend &amp; Data</h3>
            <ul className={styles.techList}>
              <li>Geospatial indexing — PostGIS/SpatiaLite radius queries</li>
              <li>Problem clustering via Celery + Redis background jobs</li>
              <li>Webhook system for municipal department integrations</li>
              <li>Full audit trail with actor, timestamp and diff</li>
            </ul>
          </article>

          <article className={`${styles.glassCard} ${styles.techCard}`}>
            <div className={`${styles.techPillarIcon} ${styles.techPillarViolet}`}>🛡️</div>
            <h3>Security &amp; Compliance</h3>
            <ul className={styles.techList}>
              <li>JWT auth with HttpOnly refresh tokens — zero XSS exposure</li>
              <li>PII redaction before any data reaches the LLM</li>
              <li>AES-256 field-level encryption at rest</li>
              <li>TOTP-based 2FA for admin accounts</li>
              <li>Prompt injection guard + anomaly detection</li>
            </ul>
          </article>

          <article className={`${styles.glassCard} ${styles.techCard}`}>
            <div className={`${styles.techPillarIcon} ${styles.techPillarGold}`}>📱</div>
            <h3>Frontend &amp; UX</h3>
            <ul className={styles.techList}>
              <li>Offline-first PWA with service worker queue</li>
              <li>Live map view — Leaflet/Mapbox with severity pins</li>
              <li>Real-time status push via WebSocket/SSE</li>
              <li>WCAG 2.1 AA accessibility compliance</li>
            </ul>
          </article>

          <article className={`${styles.glassCard} ${styles.techCard}`}>
            <div className={`${styles.techPillarIcon} ${styles.techPillarPink}`}>📊</div>
            <h3>Observability</h3>
            <ul className={styles.techList}>
              <li>Structured JSON logging via structlog</li>
              <li>AI cost dashboard — tokens/day/model/user cohort</li>
              <li>Health check endpoints for Docker orchestration</li>
              <li>Token budgeting per user per day (50K default)</li>
            </ul>
          </article>
        </div>

        <div className={styles.techPhases}>
          <article className={styles.phaseCard}>
            <h4>Phase 1 — Trust &amp; reliability</h4>
            <p>Audit trail → Geospatial columns → Duplicate detection → Health checks</p>
          </article>
          <article className={styles.phaseCard}>
            <h4>Phase 2 — User engagement</h4>
            <p>Live map → Real-time status push → PWA offline mode</p>
          </article>
          <article className={styles.phaseCard}>
            <h4>Phase 3 — Scale &amp; ops</h4>
            <p>Problem clustering → Webhook system → AI cost dashboard → Field encryption</p>
          </article>
        </div>
      </section>

      <section className={styles.ctaSection}>
        <div className={styles.ctaOrbOne} data-speed="0.3" />
        <div className={styles.ctaOrbTwo} data-speed="0.3" />
        <div className={styles.ctaBanner}>
          <span className={styles.eyebrow}>Make society better</span>
          <h2>Give every resident concern a clear next step.</h2>
          <p>Prayaas helps committees listen faster, decide smarter and show visible progress without drowning in chat threads.</p>
          <div className={styles.heroActions}>
            <button className={styles.primaryButtonLarge} onClick={goPrimary} type="button">
              Launch Prayaas
            </button>
            <button className={styles.secondaryButtonLarge} onClick={() => router.push('/login')} type="button">
              Sign in
            </button>
          </div>
        </div>
      </section>

      <footer className={styles.footer}>
        <div className={styles.footerBrand}>
          <a className={styles.brand} href="#top" aria-label="Prayaas home">
            <PrayaasMark />
            <span>
              <strong>Prayaas</strong>
              <small>Powered by intelligence</small>
            </span>
          </a>
          <p>AI-assisted community reporting for societies working toward cleaner, safer and more responsive living.</p>
        </div>
        <div>
          <h3>Product</h3>
          <a href="#features">Features</a>
          <a href="#workflow">Workflow</a>
          <a href="#pricing">Pricing</a>
        </div>
        <div>
          <h3>Company</h3>
          <a href="#stories">Stories</a>
          <a href="/login">Resident login</a>
          <a href="/register">Start society</a>
        </div>
        <div>
          <h3>Newsletter</h3>
          <form className={styles.newsletter}>
            <input aria-label="Email address" placeholder="you@society.in" type="email" />
            <button aria-label="Subscribe" type="button">
              Join
            </button>
          </form>
          <div className={styles.socials} aria-label="Social links">
            <a href="#" aria-label="LinkedIn">
              in
            </a>
            <a href="#" aria-label="X">
              x
            </a>
            <a href="#" aria-label="Mail">
              @
            </a>
          </div>
        </div>
      </footer>
    </main>
  );
}
