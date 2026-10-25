"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import BrandMark from "@/components/BrandMark";
import Neighbourhood from "@/components/Neighbourhood";
import { loadUserFromStorage } from "@/lib/auth";
import styles from "./page.module.css";

const steps = [
  {
    title: "Start with what you noticed.",
    copy: "A broken light. An overflowing bin. Tell it in your own words, or record a voice note.",
  },
  {
    title: "Give it a little clarity.",
    copy: "AI helps organise the details into a useful report. You review and edit it before anything is posted.",
  },
  {
    title: "Keep the effort visible.",
    copy: "Share with your society, add your vote to common concerns, and follow the status together.",
  },
];

function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d={diagonal ? "M6 18 18 6M6 6h12v12" : "M4 12h16m-6-6 6 6-6 6"}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FeatureIcon({ type }: { type: "voice" | "people" | "progress" }) {
  return (
    <svg
      width="27"
      height="27"
      viewBox="0 0 28 28"
      fill="none"
      aria-hidden="true"
    >
      <path
        d={
          type === "voice"
            ? "M11 6a3 3 0 0 1 6 0v8a3 3 0 0 1-6 0ZM7 12v2a7 7 0 0 0 14 0v-2M14 21v4m-4 0h8"
            : type === "people"
              ? "M11 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 11v-3a8 8 0 0 1 16 0v3m0-18a4 4 0 0 1 0 8m3 3a7 7 0 0 1 3 6"
              : "M5 8h18M5 14h12M5 20h8m6-1 3 3 5-7"
        }
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function Home() {
  const [hasUser, setHasUser] = useState(false);
  const [step, setStep] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menuToggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setHasUser(Boolean(loadUserFromStorage()));
  }, []);

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const elements = Array.from(
      root.current?.querySelectorAll<HTMLElement>("[data-parallax]") ?? [],
    );
    let frame = 0;
    const update = () => {
      frame = 0;
      // Clamp hero drift so off-screen layers do not travel through later sections.
      const offset = motion.matches ? 0 : Math.min(window.scrollY, 900);
      elements.forEach((element) =>
        element.style.setProperty(
          "--drift",
          `${offset * Number(element.dataset.parallax)}px`,
        ),
      );
    };
    const scroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    window.addEventListener("scroll", scroll, { passive: true });
    motion.addEventListener("change", scroll);
    update();
    return () => {
      window.removeEventListener("scroll", scroll);
      motion.removeEventListener("change", scroll);
      cancelAnimationFrame(frame);
    };
  }, []);

  const primaryHref = hasUser ? "/dashboard" : "/register";
  const closeMenu = () => setMenuOpen(false);

  return (
    <div className={styles.page} ref={root}>
      <a className={styles.skipLink} href="#main">
        Skip to content
      </a>
      <header
        className={styles.header}
        onKeyDown={(event) => {
          if (event.key === "Escape" && menuOpen) {
            setMenuOpen(false);
            menuToggle.current?.focus();
          }
        }}
      >
        <div className={styles.navInner}>
          <Link href="/" className={styles.brand} aria-label="Prayaas home">
            <BrandMark />
            <span>
              prayaas<span className={styles.brandDot}>.</span>
            </span>
          </Link>
          <nav className={styles.desktopNav} aria-label="Main navigation">
            <a href="#approach">Our approach</a>
            <a href="#how-it-works">How it works</a>
            <a href="#questions">Good to know</a>
          </nav>
          <div className={styles.navActions}>
            <Link
              href={hasUser ? "/dashboard" : "/login"}
              className={styles.signIn}
            >
              {hasUser ? "Your workspace" : "Resident login"}
            </Link>
            <Link href={primaryHref} className={styles.navCta}>
              Come on in <Arrow />
            </Link>
            <button
              ref={menuToggle}
              type="button"
              className={styles.menuButton}
              aria-expanded={menuOpen}
              aria-controls="mobile-menu"
              onClick={() => setMenuOpen(!menuOpen)}
            >
              {menuOpen ? "Close" : "Menu"}
            </button>
          </div>
        </div>
        {menuOpen && (
          <nav
            id="mobile-menu"
            className={styles.mobileMenu}
            aria-label="Mobile navigation"
          >
            <a href="#approach" onClick={closeMenu}>
              Our approach
            </a>
            <a href="#how-it-works" onClick={closeMenu}>
              How it works
            </a>
            <a href="#questions" onClick={closeMenu}>
              Good to know
            </a>
            <Link href={primaryHref} onClick={closeMenu}>
              Join your neighbourhood <Arrow />
            </Link>
          </nav>
        )}
      </header>

      <main id="main">
        <section className={styles.hero} aria-labelledby="hero-title">
          <div className={styles.heroCopy}>
            <div className={styles.eyebrow}>
              <span className={styles.smallSun} aria-hidden="true">
                ✳
              </span>{" "}
              A little effort. A better neighbourhood.
            </div>
            <h1 id="hero-title">
              Good things
              <br />
              start <em>next door.</em>
            </h1>
            <p>
              For the places we share, and the people we call neighbours. Turn
              everyday concerns into small steps forward, together.
            </p>
            <div className={styles.heroActions}>
              <Link className={styles.primaryButton} href={primaryHref}>
                {hasUser ? "Open your workspace" : "Join your neighbourhood"}
                <Arrow />
              </Link>
              <a href="#how-it-works" className={styles.textLink}>
                See how it works <span aria-hidden="true">↓</span>
              </a>
            </div>
            <div className={styles.heroNote}>
              <span className={styles.noteLine} />
              Made for residents. Built around collective effort.
            </div>
          </div>
          <div className={styles.heroVisual}>
            <div className={styles.illustration} data-parallax="0.035">
              <Neighbourhood />
            </div>
            <div className={styles.annotationTop} data-parallax="-0.025">
              <span className={styles.statusDot} />A place for every voice.
            </div>
            <div className={styles.neighbourNote} data-parallax="0.06">
              <span className={styles.noteNumber}>01</span>
              <div>
                Shared spaces.
                <br />
                <strong>Shared responsibility.</strong>
              </div>
              <svg
                width="34"
                height="34"
                viewBox="0 0 36 36"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M4 24 18 6l14 18M8 20v11h20V20m-13 11V20h6v11"
                  stroke="currentColor"
                  strokeWidth="1.3"
                />
              </svg>
            </div>
            <div className={styles.figureCaption}>
              <span>THE NEIGHBOURHOOD, REIMAGINED</span>
              <span>Fig. 01</span>
            </div>
          </div>
        </section>

        <section className={styles.beliefStrip} aria-label="Our belief">
          <span>
            A SHARED ADDRESS.
            <br />A SHARED PURPOSE.
          </span>
          <p>
            Less lost in the chat.
            <br />
            <em>More done for the community.</em>
          </p>
          <div>
            Because a society is more than
            <br />
            the buildings we live in.
          </div>
        </section>

        <section
          id="approach"
          className={styles.approach}
          aria-labelledby="approach-title"
        >
          <div className={styles.sectionHeading}>
            <span className={styles.eyebrow}>
              01 / THE EVERYDAY, MADE EASIER
            </span>
            <h2 id="approach-title">
              A little structure.
              <br />A lot more possibility.
            </h2>
            <p>
              Not another noisy group chat. A shared place to raise concerns,
              find common ground, and keep track of what happens next.
            </p>
          </div>
          <div className={styles.featureLayout}>
            <article className={styles.featureLead}>
              <span className={styles.eyebrow}>
                YOUR WORDS. A CLEARER WAY FORWARD.
              </span>
              <div
                className={styles.paperStack}
                aria-label="Illustrative report example"
              >
                <div className={styles.paperBack} />
                <div className={styles.reportPaper}>
                  <div className={styles.paperMeta}>
                    <span>THE COMMUNITY NOTE</span>
                    <span>EXAMPLE</span>
                  </div>
                  <h3>A brighter walk home.</h3>
                  <p>The pathway light near the main gate needs attention.</p>
                  <div className={styles.paperRule} />
                  <div className={styles.paperDetails}>
                    <span>Infrastructure</span>
                    <span>Main gate</span>
                  </div>
                  <div className={styles.paperSignature}>
                    <span className={styles.miniMark}>
                      <BrandMark />
                    </span>
                    One concern, clearly heard.
                  </div>
                </div>
              </div>
              <h3>
                Say it naturally.
                <br />
                Make it actionable.
              </h3>
              <p>
                Prayaas helps turn a rough note into a clear report, with a
                category, location and suggested next steps. You make the final
                call.
              </p>
              <Link
                href={hasUser ? "/problems/new" : "/register"}
                className={styles.textLink}
              >
                Make your first report <Arrow diagonal />
              </Link>
            </article>
            <div className={styles.featureList}>
              <article>
                <div className={styles.featureTop}>
                  <FeatureIcon type="voice" />
                  <span>01</span>
                </div>
                <h3>Speak your mind.</h3>
                <p>
                  Type a few lines or leave a voice note. A concern does not
                  need perfect wording to deserve attention.
                </p>
              </article>
              <article>
                <div className={styles.featureTop}>
                  <FeatureIcon type="people" />
                  <span>02</span>
                </div>
                <h3>Find your people.</h3>
                <p>
                  Join society groups and add your vote to the issues that
                  matter. Let shared concerns speak a little louder.
                </p>
              </article>
              <article>
                <div className={styles.featureTop}>
                  <FeatureIcon type="progress" />
                  <span>03</span>
                </div>
                <h3>Follow the follow-through.</h3>
                <p>
                  See what is open, in progress, or resolved. Keep the story in
                  one place, instead of starting it over in every conversation.
                </p>
              </article>
            </div>
          </div>
        </section>

        <section
          id="how-it-works"
          className={styles.workflow}
          aria-labelledby="workflow-title"
        >
          <div className={styles.workflowInner}>
            <div className={styles.workflowCopy}>
              <span className={styles.eyebrow}>
                02 / FROM CONCERN TO COLLECTIVE ACTION
              </span>
              <h2 id="workflow-title">
                From &ldquo;someone should&rdquo;
                <br />
                to <em>&ldquo;we did.&rdquo;</em>
              </h2>
              <div className={styles.steps}>
                {steps.map((item, index) => (
                  <button
                    key={item.title}
                    type="button"
                    className={`${styles.step} ${step === index ? styles.stepActive : ""}`}
                    aria-pressed={step === index}
                    aria-controls="walkthrough-preview"
                    onClick={() => setStep(index)}
                  >
                    <span className={styles.stepNumber}>0{index + 1}</span>
                    <span>
                      <strong>{item.title}</strong>
                      <span>{item.copy}</span>
                    </span>
                    <span className={styles.stepArrow} aria-hidden="true">
                      ↗
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <div className={styles.previewWrap}>
              <div className={styles.previewLabel}>
                <span>TAKE A LOOK INSIDE</span>
                <span>0{step + 1} / 03</span>
              </div>
              <div
                id="walkthrough-preview"
                className={styles.preview}
                aria-live="polite"
                aria-atomic="true"
              >
                <div className={styles.previewBrand}>
                  <BrandMark />
                  <span>prayaas.</span>
                  <small>ILLUSTRATIVE WALKTHROUGH</small>
                </div>
                <div className={styles.previewContent} key={step}>
                  {step === 0 && (
                    <>
                      <span className={styles.eyebrow}>
                        A NOTE FROM YOUR NEIGHBOUR
                      </span>
                      <h3>
                        What needs a<br />
                        little attention?
                      </h3>
                      <div className={styles.rawNote}>
                        &ldquo;The light by the main gate has been out since
                        yesterday. It gets quite dark when we walk back in the
                        evening.&rdquo;
                      </div>
                      <div className={styles.voiceNote}>
                        <span className={styles.voiceBars} aria-hidden="true">
                          {[9, 18, 26, 15, 32, 22, 12, 24, 16, 28, 10, 19].map(
                            (height, i) => (
                              <i key={i} style={{ height }} />
                            ),
                          )}
                        </span>
                        <span>Your words are enough.</span>
                      </div>
                    </>
                  )}
                  {step === 1 && (
                    <>
                      <span className={styles.eyebrow}>
                        ORGANISED WITH AI. REVIEWED BY YOU.
                      </span>
                      <h3>
                        Main gate pathway
                        <br />
                        light not working
                      </h3>
                      <div className={styles.draftTags}>
                        <span>Infrastructure</span>
                        <span>Main gate</span>
                      </div>
                      <p>
                        The pathway light near the main gate has not been
                        working since yesterday, making the entrance difficult
                        to see in the evening.
                      </p>
                      <div className={styles.reviewNote}>
                        <span aria-hidden="true">✓</span> Check the details.
                        Edit anything. Post when ready.
                      </div>
                    </>
                  )}
                  {step === 2 && (
                    <>
                      <span className={styles.eyebrow}>
                        A SHARED RECORD OF THE EFFORT
                      </span>
                      <h3>
                        One issue.
                        <br />A visible next step.
                      </h3>
                      <div className={styles.statusTimeline}>
                        <div>
                          <span />
                          <p>
                            <strong>Open</strong>A resident raises the concern.
                          </p>
                        </div>
                        <div>
                          <span />
                          <p>
                            <strong>In progress</strong>The committee updates
                            the status.
                          </p>
                        </div>
                        <div>
                          <span />
                          <p>
                            <strong>Resolved</strong>The outcome stays on the
                            record.
                          </p>
                        </div>
                      </div>
                    </>
                  )}
                </div>
                <div className={styles.previewBottom}>
                  <span>EXAMPLE ONLY / NOT A LIVE REPORT</span>
                  <span aria-hidden="true">✳</span>
                </div>
              </div>
              <p className={styles.previewFootnote}>
                Better tools for the effort that already exists.
              </p>
            </div>
          </div>
        </section>

        <section
          className={styles.principles}
          aria-labelledby="principles-title"
        >
          <div className={styles.sectionHeading}>
            <span className={styles.eyebrow}>03 / PEOPLE FIRST. ALWAYS.</span>
            <h2 id="principles-title">
              Technology in the background.
              <br />
              Neighbourhoods at the heart.
            </h2>
          </div>
          <div className={styles.principleGrid}>
            <article>
              <span>01</span>
              <h3>Everyday voices matter.</h3>
              <p>
                The dripping tap and the broken gate deserve a place to be
                heard. Small things shape how a place feels.
              </p>
            </article>
            <article>
              <span>02</span>
              <h3>You stay in the loop.</h3>
              <p>
                AI helps with the paperwork, not the final word. Review your
                draft and choose what you share.
              </p>
            </article>
            <article>
              <span>03</span>
              <h3>Progress belongs to everyone.</h3>
              <p>
                A vote, an update, a resolved concern. Community gets better
                through many small contributions.
              </p>
            </article>
          </div>
        </section>

        <section
          id="questions"
          className={styles.questions}
          aria-labelledby="questions-title"
        >
          <div>
            <span className={styles.eyebrow}>
              A FEW THINGS, BEFORE YOU COME IN
            </span>
            <h2 id="questions-title">Good to know.</h2>
          </div>
          <div className={styles.faqList}>
            <details>
              <summary>
                Who is Prayaas for?<span aria-hidden="true">+</span>
              </summary>
              <p>
                Residents and committees of residential societies who want a
                clearer way to collect concerns, discuss shared issues, and keep
                track of progress.
              </p>
            </details>
            <details>
              <summary>
                What does the AI actually do?<span aria-hidden="true">+</span>
              </summary>
              <p>
                It helps organise text or voice input into a structured issue
                report and suggests possible solutions. It can make mistakes, so
                you review and edit the draft before posting.
              </p>
            </details>
            <details>
              <summary>
                Can I use it without recording my voice?
                <span aria-hidden="true">+</span>
              </summary>
              <p>
                Yes. You can type your concern instead. Voice recording is
                optional, and asks for microphone permission only when you use
                it.
              </p>
            </details>
            <details>
              <summary>
                How do I get started?<span aria-hidden="true">+</span>
              </summary>
              <p>
                Create a resident account with your name, email and flat
                details. From your workspace you can explore groups, report an
                issue, and follow society updates.
              </p>
              <Link href={primaryHref}>
                Create your account <Arrow />
              </Link>
            </details>
          </div>
        </section>

        <section className={styles.closing} aria-labelledby="closing-title">
          <div className={styles.closingSymbol} aria-hidden="true">
            ✳
          </div>
          <span className={styles.eyebrow}>PRAYAAS / AN EFFORT, TOGETHER</span>
          <h2 id="closing-title">
            The place we call home
            <br />
            is worth a little effort.
          </h2>
          <Link className={styles.primaryButton} href={primaryHref}>
            {hasUser
              ? "Back to your neighbourhood"
              : "Find your place in Prayaas"}
            <Arrow />
          </Link>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerTop}>
          <div>
            <Link href="/" className={styles.brand}>
              <BrandMark />
              <span>prayaas.</span>
            </Link>
            <p>
              For the everyday work
              <br />
              of living better, together.
            </p>
          </div>
          <div>
            <span>EXPLORE</span>
            <a href="#approach">Our approach</a>
            <a href="#how-it-works">How it works</a>
            <a href="#questions">Good to know</a>
          </div>
          <div>
            <span>YOUR NEIGHBOURHOOD</span>
            <Link href="/login">Resident login</Link>
            <Link href="/register">Create an account</Link>
            <Link href="/dashboard">Society workspace</Link>
          </div>
          <div className={styles.footerNote}>
            <span>A NOTE FROM PRAYAAS</span>
            <p>
              Good communities do not happen by accident.
              <br />
              They happen by participation.
            </p>
          </div>
        </div>
        <div className={styles.footerBottom}>
          <span>© {new Date().getFullYear()} Prayaas</span>
          <span>Small steps. Shared spaces. Lasting change.</span>
          <a href="#main">Back to top ↑</a>
        </div>
      </footer>
    </div>
  );
}
