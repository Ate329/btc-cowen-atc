import { ExternalLink, GitBranch, User } from "lucide-react";

const cowenPaperUrl =
  "https://benjamincowen.com/reports/asymmetric-tail-curvature-in-bitcoin-price-quantiles";
const repositoryUrl = "https://github.com/Ate329/btc-cowen-atc";
const profileUrl = "https://github.zyhe.me";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="footer-credit">
        <span>Credit</span>
        <p>
          Built as a visual companion to Benjamin Cowen's paper{" "}
          <a href={cowenPaperUrl} target="_blank" rel="noreferrer">
            "Asymmetric Tail Curvature in Bitcoin Price Quantiles"
            <ExternalLink size={14} />
          </a>
          .
        </p>
      </div>
      <div className="footer-links" aria-label="Project links">
        <a href={repositoryUrl} target="_blank" rel="noreferrer">
          <GitBranch size={15} />
          GitHub repo
        </a>
        <a href={profileUrl} target="_blank" rel="noreferrer">
          <User size={15} />
          My GitHub profile
        </a>
      </div>
    </footer>
  );
}
