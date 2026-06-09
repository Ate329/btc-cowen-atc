import { ArrowLeft, BookOpen, ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import modelConfig from "../data/model-config.json";
import { SiteHeader } from "./SiteHeader";

function AboutSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="about-section-card">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function number(value: number, maximumFractionDigits = 4): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits,
    signDisplay: "exceptZero",
  }).format(value);
}

export default function AboutPage() {
  return (
    <div className="app">
      <SiteHeader homeHref="/" navLabel="About navigation">
        <a href="/" className="about-back-link">
          <ArrowLeft size={14} />
          Back to dashboard
        </a>
        <a
          href="https://benjamincowen.com/reports/asymmetric-tail-curvature-in-bitcoin-price-quantiles"
          target="_blank"
          rel="noreferrer"
        >
          Read Cowen paper
          <ExternalLink size={14} />
        </a>
      </SiteHeader>

      <main className="about-main">
        <section className="about-hero">
          <div className="about-copy">
            <p className="about-kicker">Project note</p>
            <h1>Bitcoin ATC quantile model methodology</h1>
            <p className="about-lede">
              This BTC price model chart is a long-form, non-trading companion
              for Cowen's working paper{" "}
              <a
                href="https://benjamincowen.com/reports/asymmetric-tail-curvature-in-bitcoin-price-quantiles"
                target="_blank"
                rel="noreferrer"
              >
                "Asymmetric Tail Curvature in Bitcoin Price Quantiles"
                <ExternalLink size={13} />
              </a>
              .
            </p>
          </div>
          <p className="about-expanded-copy">
            It visualizes Bitcoin's conditional price distribution in the form
            of ATC quantile bands, compares those bands against BTC/USD history,
            and keeps the Bitcoin projection caveats visible.
          </p>
          <div className="about-takeaway">
            <p className="about-takeaway-kicker">Paper-level takeaway</p>
            <p>
              The framework shows upper-tail curvature becoming more negative
              across cycles (compression), while lower-tail curvature stays near
              linear. So the paper is a refinement for the upside tail, not a
              replacement of prior power-law foundations.
            </p>
          </div>
        </section>

        <AboutSection title="The paper">
          <p className="about-metric-row">
            Working paper (version {modelConfig.paperVersion}) is identified as
            a distributional summary model over long history, with quantile
            bands treated as conditional price levels over time, not return-risk
            probabilities.
          </p>
          <div className="about-metric-block">
            <p>
              Core specification (for each quantile):
              <code className="about-code">
                log10(P_tau(t)) = c_tau + a_tau x + b_tau x^2
              </code>
              with x = ln(days since genesis) - {modelConfig.mu}
            </p>
            <div className="about-metric-grid">
              <div>
                <p>Lower-tail curvature</p>
                <strong>bLO</strong>
                <span>{number(modelConfig.curvature.lowerTail)}</span>
              </div>
              <div>
                <p>Upper-tail curvature</p>
                <strong>bHI</strong>
                <span>{number(modelConfig.curvature.upperTail)}</span>
              </div>
              <div>
                <p>Asymmetry</p>
                <strong>Delta b = bHI - bLO</strong>
                <span>{number(modelConfig.curvature.delta)}</span>
              </div>
            </div>
            <p>
              The paper also documents that prior point-prediction-style models
              were materially optimistic out-of-sample in recent cycles,
              especially in 2020-2026 evaluations.
            </p>
          </div>
        </AboutSection>

        <AboutSection title="What this project does">
          <p>
            The dashboard uses this project config and snapshot process as a
            faithful interface around the paper's fixed Table 3 parameters and
            generated price bands. In plain terms, it is a Bitcoin ATC quantile
            model interface for exploring Cowen asymmetric tail curvature
            against historical BTC/USD closes:
          </p>
          <ul className="about-list">
            <li>
              Paper mode: computes quantile bands directly from the published
              coefficients.
            </li>
            <li>
              Alternate modes: fits linear, symmetric quadratic, stretched
              exponential, and ATC-refit model variants against the same BTC
              snapshot.
            </li>
            <li>
              Monotone rearrangement: band curves are sorted for each date to
              prevent crossing in rendering.
            </li>
            <li>
              Data snapshot: BTC/USD daily closes from 2012 onward are pulled,
              versioned, and projected to {modelConfig.projectionEndDate} for
              exploratory long-run view only.
            </li>
          </ul>
          <div className="about-statline">
            <span>Anchor</span>
            <strong>{modelConfig.anchorDate}</strong>
            <span>Start</span>
            <strong>{modelConfig.startDate}</strong>
          </div>
        </AboutSection>

        <AboutSection title="Why?">
          <p>
            I first heard about Cowen's paper from a video, and it immediately
            stood out because it addressed the exact problem I had been noticing:
            old BTC models were getting stretched against a new market reality.
            That is why I started this project, and why it is entirely based on
            the paper. In recent BTC cycles, e.g.
          </p>
          <div className="about-list-wrap">
            <ul className="about-list">
              <li>ETF adoption changing the demand/liquidity profile.</li>
              <li>Large institutions increasing net BTC ownership.</li>
              <li>
                More countries and institutions treating BTC as a recognized
                asset rather than a fringe instrument.
              </li>
              <li>
                Bubble dynamics changing from repeated x100 upside stretches
                toward slower, less explosive peaks.
              </li>
            </ul>
            <div className="about-quote-box">
              <BookOpen size={18} />
              <p>
                In that environment, legacy parameters read too optimistically
                and often ignored structural changes in the market ecosystem.
                Cowen's paper gave me a concrete way to think about that issue:
                upper-tail compression without throwing away the long-run
                power-law structure. The motivation here is to keep the analysis
                aligned with changing regime behavior, not to turn this into a
                trading signal.
              </p>
            </div>
          </div>
        </AboutSection>

        <AboutSection title="What this page does not do">
          <p>
            The projection controls are descriptive model views, not investment
            advice, guaranteed BTC targets, or a trading system.
          </p>
          <ul className="about-list about-list-tight">
            <li>It does not predict the next weekly or daily BTC move.</li>
            <li>
              It does not estimate return-tail probability or portfolio loss
              risk.
            </li>
            <li>It does not provide direct trade entries, exits, or sizing.</li>
            <li>
              It provides a conditional long-run structure read, not a
              guaranteed floor or target.
            </li>
          </ul>
        </AboutSection>
      </main>
    </div>
  );
}
