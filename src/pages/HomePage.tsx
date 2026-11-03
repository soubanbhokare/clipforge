import { useState } from "react";
import { useAuth } from "../features/auth/AuthContext";
import { navigateTo } from "../features/auth/routing";
import HeroVisual from "../components/landing/HeroVisual";
import BeforeAfterDemo from "../components/landing/BeforeAfterDemo";
import FeatureShowcase from "../components/landing/FeatureShowcase";
import LandingMediaSections from "../components/landing/LandingMediaSections";
import SocialProof from "../components/landing/SocialProof";
import ProblemSolution from "../components/landing/ProblemSolution";
import MediaPlaceholder from "../components/landing/MediaPlaceholder";
import { getLandingAsset, type LandingAssetId } from "../config/landingAssets";
import Logo from "../components/Logo";
import Reveal from "../components/landing/Reveal";
import styles from "./HomePage.module.css";

/**
 * CLIPFORGE landing page — Phase 3, media-placeholder pass (2026-11-02).
 *
 * What is real here: navigation, smooth scrolling, the mobile menu,
 * the FAQ, and — since the Phase 2 auth pass — real accounts:
 * Sign In goes to #/login, Create Clips to #/signup, and Explore Demo
 * opens the workspace in clearly labelled guest demo mode. Upload,
 * AI clip detection, the editor, captions, Face Lock, enhancement
 * and exports are live in the Studio. Social publishing is built
 * too — it activates once the platform (OAuth) credentials are
 * configured, and is labelled as such wherever it appears. No fake
 * metrics, testimonials or prices are shown.
 *
 * MEDIA RULE: every image and video area is an EMPTY reserved
 * MediaPlaceholder from the centralized map in
 * src/config/landingAssets.ts (40 slots). No sample photos, stock
 * images, generated images or sample videos are inserted in this
 * phase, and no placeholder shows a fake play button or progress.
 *
 * SECTION ORDER (one straight line): Hero → Social Proof (logo and
 * testimonial slots folded into one proof section) → Problem →
 * Solution (the Before / After panel follows it, headerless) →
 * Features (the editor, templates, use cases, B-roll and publishing
 * blocks sit inside this chapter as compact sub-blocks) → How It
 * Works → FAQ → Final CTA. Proof slots are reserved only — no logos,
 * quotes, names or metrics are shown until real assets are supplied.
 *
 * Note for the main agent (Phase 2 merge): this page links to
 * "#/studio" as the Studio route. If App.tsx does not yet route that
 * hash to the app shell, that routing still needs to be wired there —
 * this file deliberately does not touch App.tsx.
 */

const HOW_IT_WORKS: { step: string; title: string; text: string; assetId: LandingAssetId }[] = [
  {
    step: "01",
    title: "Add Your Video",
    text: "Paste an eligible YouTube URL or upload an authorized video file.",
    assetId: "how-step-visual-01",
  },
  {
    step: "02",
    title: "Find the Best Moments",
    text: "AI-assisted analysis identifies candidate sections for short-form clips.",
    assetId: "how-step-visual-02",
  },
  {
    step: "03",
    title: "Refine Automatically",
    text: "Use face tracking, smart reframing, captions and quick edits.",
    assetId: "how-step-visual-03",
  },
  {
    step: "04",
    title: "Publish Your Content",
    text: "Review the finished clips and prepare them for export, scheduling or supported publishing integrations.",
    assetId: "how-step-visual-04",
  },
];

const FAQS = [
  {
    q: "How does clip generation work?",
    a: "Upload a video in the Studio and CLIPFORGE transcribes it and analyses it for candidate moments. Those moments are cut into vertical clips, and you review each clip before export.",
  },
  {
    q: "Can I upload my own video?",
    a: "Yes — upload a video file you own or have rights to use in the Studio, and the server reads its real metadata. You can also paste a video URL — from YouTube or another supported site, or a direct link to a media file — and the server downloads it into your project, ready for clip generation and editing in the Studio. Some platforms or videos block server downloads (for example sign-in or regional restrictions); those imports fail with the reason shown, and file upload remains available.",
  },
  {
    q: "How does face tracking work?",
    a: "Face tracking (Auto Face Lock) follows the selected subject so they stay framed during the 16:9 to 9:16 conversion. It runs on CLIPFORGE's own server — in clip analysis and in the editor's Reframe panel.",
  },
  {
    q: "Which output formats are available?",
    a: "Vertical short-form output (9:16) is the primary format, alongside 16:9, 1:1 and 4:5. The Export Studio renders real MP4 and WebM files (H.264, H.265 or VP9) from 480p up to 4K, with captions burned in or delivered as subtitle files.",
  },
  {
    q: "How do publishing integrations depend on authorization?",
    a: "A platform can only receive a clip after you connect and authorize CLIPFORGE through that platform's official integration. Without that authorization, publishing cannot happen — you can still review and export your clips.",
  },
  {
    q: "Which features require connected services?",
    a: "AI analysis and clip detection, face tracking and caption generation run on CLIPFORGE's own server and are live in the Studio once you have an account — no external service needs to be connected for them. Publishing is the exception: it uses the platforms' official APIs and works only after you connect and authorize your own platform accounts.",
  },
];

function scrollToId(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
}

export default function HomePage() {
  const { enterGuest } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [legalNotice, setLegalNotice] = useState<string | null>(null);

  const goTo = (id: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    setMenuOpen(false);
    scrollToId(id);
  };

  // Guest demo entry: sets guest mode first, then opens the Studio.
  // No credentials are involved and nothing is saved in demo mode.
  const exploreDemo = () => {
    setMenuOpen(false);
    enterGuest();
    navigateTo("studio");
  };

  return (
    <div className={styles.page}>
      {/* ---- Landing navigation ---- */}
      <header className={styles.nav}>
        <a className={styles.wordmark} href="#top" onClick={goTo("top")} aria-label="CLIPFORGE home">
          <Logo />
        </a>

        <nav className={styles.navCentre} aria-label="Landing sections">
          <a href="#features" onClick={goTo("features")}>Features</a>
          <a href="#how" onClick={goTo("how")}>How It Works</a>
          <a href="#faq" onClick={goTo("faq")}>FAQ</a>
        </nav>

        <div className={styles.navRight}>
          <a className={styles.signInButton} href="#/login">
            Sign In
          </a>
          <a className={styles.createButton} href="#/signup">Create Clips</a>
          <button
            type="button"
            className={styles.menuButton}
            aria-expanded={menuOpen}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            onClick={() => setMenuOpen((v) => !v)}
          >
            Menu
          </button>
        </div>

        {menuOpen && (
          <nav className={styles.mobileMenu} aria-label="Mobile landing sections">
            <a href="#features" onClick={goTo("features")}>Features</a>
            <a href="#how" onClick={goTo("how")}>How It Works</a>
            <a href="#faq" onClick={goTo("faq")}>FAQ</a>
            <a href="#/login" onClick={() => setMenuOpen(false)}>
              Sign In
            </a>
            <a href="#/signup">Create Clips</a>
          </nav>
        )}
      </header>

      <main id="top">
        {/* ---- Hero ---- */}
        <section className={styles.hero} aria-labelledby="hero-heading">
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>AI-POWERED SHORT-FORM VIDEO STUDIO</p>
            <h1 id="hero-heading" className={styles.title}>
              <span className={styles.line} style={{ animationDelay: "0.05s" }}>ONE VIDEO.</span>
              <span className={styles.line} style={{ animationDelay: "0.2s" }}>MULTIPLE SHORTS.</span>
              <span className={styles.line} style={{ animationDelay: "0.35s" }}>
                READY TO <em>PUBLISH.</em>
              </span>
            </h1>
            <p className={styles.subtitle}>
              Turn long videos into short-form content with AI-assisted clip
              selection, Auto Face Lock, smart reframing, captions and publishing.
            </p>
            <div className={styles.actions}>
              <a className={styles.primaryButton} href="#/signup">Create Clips</a>
            </div>
          </div>
          <div className={styles.heroVisual}>
            <HeroVisual />
          </div>
        </section>

        {/* ---- Social Proof (reserved logo slots only) ---- */}
        <SocialProof />

        {/* ---- Problem → Solution ---- */}
        <ProblemSolution />

        {/* ---- Before / After reserved media (follows Solution) ---- */}
        <section className={styles.demoSection} id="demo" aria-label="Before and after">
          <Reveal>
            <BeforeAfterDemo />
          </Reveal>
        </section>

        {/* ---- Feature showcase ---- */}
        <section className={styles.section} id="features" aria-labelledby="features-heading">
          <Reveal>
            <p className={styles.sectionEyebrow}>Features</p>
            <h2 id="features-heading">BUILT FOR THE VERTICAL FEED</h2>
            <p className={styles.sectionIntro}>
              Each feature below is live in the CLIPFORGE Studio today.
              Where a feature needs your own connected account, the section
              says so.
            </p>
          </Reveal>
          <FeatureShowcase />
        </section>

        {/* ---- Editor, Templates, Use Cases, B-roll, Publishing ---- */}
        <LandingMediaSections />

        {/* ---- How It Works (one reserved visual per step) ---- */}
        <section className={styles.section} id="how" aria-labelledby="how-heading">
          <Reveal>
            <p className={styles.sectionEyebrow}>How It Works</p>
            <h2 id="how-heading">FROM LONG VIDEO TO READY-TO-POST SHORTS</h2>
          </Reveal>
          <ol className={styles.steps}>
            {HOW_IT_WORKS.map((s) => (
              <li key={s.step} className={styles.step}>
                <span className={styles.stepNumber}>{s.step}</span>
                <h3>{s.title}</h3>
                <p>{s.text}</p>
                <div className={styles.stepMedia}>
                  <MediaPlaceholder asset={getLandingAsset(s.assetId)} />
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* ---- FAQ ---- */}
        <section className={styles.section} id="faq" aria-labelledby="faq-heading">
          <Reveal>
            <p className={styles.sectionEyebrow}>FAQ</p>
            <h2 id="faq-heading">FREQUENTLY ASKED QUESTIONS</h2>
          </Reveal>
          <div className={styles.faqList}>
            {FAQS.map((f) => (
              <details key={f.q} className={styles.faqItem}>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* ---- Final CTA ---- */}
        <section className={styles.finalCta} aria-labelledby="final-heading">
          <Reveal>
            <div className={styles.finalCtaVisual}>
              <MediaPlaceholder asset={getLandingAsset("final-cta-visual")} />
            </div>
            <h2 id="final-heading">ONE VIDEO IN. SHORTS OUT.</h2>
            <p>
              Create a free account to open your workspace, or explore the
              demo first — no account needed. Upload and AI clipping are
              live in the Studio today.
            </p>
            <a className={styles.primaryButton} href="#/signup">Create Clips</a>{" "}
            <button type="button" className={styles.exploreLink} onClick={exploreDemo}>
              Explore Demo
            </button>
          </Reveal>
        </section>
      </main>

      {/* ---- Footer ---- */}
      <footer className={styles.footer}>
        <div className={styles.footerBrand}>
          <span className={styles.wordmark}>
            <Logo />
          </span>
          <p>AI-powered short-form video studio.</p>
        </div>
        <nav aria-label="Product links">
          <h3>Product</h3>
          <a href="#how" onClick={goTo("how")}>How It Works</a>
          <a href="#demo" onClick={goTo("demo")}>Before / After</a>
          <a href="#templates" onClick={goTo("templates")}>Templates</a>
          <a href="#use-cases" onClick={goTo("use-cases")}>Use Cases</a>
          <a href="#/studio">Studio</a>
        </nav>
        <nav aria-label="Feature links">
          <h3>Features</h3>
          <a href="#face-lock" onClick={goTo("face-lock")}>Auto Face Lock</a>
          <a href="#clip-detection" onClick={goTo("clip-detection")}>AI Clip Detection</a>
          <a href="#captions" onClick={goTo("captions")}>Smart Captions</a>
          <a href="#reframing" onClick={goTo("reframing")}>Smart Reframing</a>
          <a href="#batch" onClick={goTo("batch")}>Batch Clip Creation</a>
          <a href="#publishing" onClick={goTo("publishing")}>Publishing Workflow</a>
        </nav>
        <nav aria-label="Legal">
          <h3>Legal</h3>
          <button type="button" onClick={() => setLegalNotice("No privacy policy has been published yet.")}>
            Privacy
          </button>
          <button type="button" onClick={() => setLegalNotice("No terms have been published yet.")}>
            Terms
          </button>
        </nav>
        <p className={styles.copyright}>© 2026 CLIPFORGE. All rights reserved.</p>
        {legalNotice && (
          <p className={styles.legalNotice} role="status">
            {legalNotice}{" "}
            <button type="button" onClick={() => setLegalNotice(null)}>Dismiss</button>
          </p>
        )}
      </footer>

    </div>
  );
}
