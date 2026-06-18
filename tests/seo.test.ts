import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyPageSeo,
  buildStructuredData,
  getCanonicalUrl,
  seoPages,
} from "../src/lib/seo";

afterEach(() => {
  document.head.innerHTML = "";
});

describe("SEO metadata", () => {
  it("includes the Google Search Console verification tag in the static homepage", () => {
    const indexHtml = readFileSync(resolve(process.cwd(), "index.html"), "utf8");

    expect(indexHtml).toContain(
      '<meta name="google-site-verification" content="4su37Q-i1rqArRfSfS-vHJHrcGsuEKrXuXW4E1sz-0A" />',
    );
  });

  it("keeps page titles and descriptions within search-snippet friendly bounds", () => {
    for (const page of Object.values(seoPages)) {
      expect(page.title.length).toBeLessThanOrEqual(60);
      expect(page.description.length).toBeGreaterThanOrEqual(90);
      expect(page.description.length).toBeLessThanOrEqual(160);
    }
  });

  it("builds canonical URLs for crawlable routes", () => {
    expect(getCanonicalUrl("dashboard")).toBe("https://catc.zyhe.me/");
    expect(getCanonicalUrl("about")).toBe("https://catc.zyhe.me/about/");
  });

  it("adds breadcrumb and dataset download JSON-LD", () => {
    const data = buildStructuredData("about") as {
      "@graph": Array<Record<string, unknown>>;
    };

    const breadcrumb = data["@graph"].find(
      (item) => item["@type"] === "BreadcrumbList",
    );
    expect(breadcrumb).toBeTruthy();
    expect(JSON.stringify(breadcrumb)).toContain("https://catc.zyhe.me/about/");

    const dataset = data["@graph"].find((item) => item["@type"] === "Dataset");
    expect(dataset).toMatchObject({
      license: "https://github.com/Ate329/btc-cowen-atc/blob/main/LICENSE",
      distribution: {
        "@type": "DataDownload",
        contentUrl: "https://catc.zyhe.me/data/btc-atc.json",
        encodingFormat: "application/json",
      },
    });

    const webpage = data["@graph"].find((item) =>
      Array.isArray(item["@type"]),
    );
    expect(webpage?.["@type"]).toContain("AboutPage");
  });

  it("adds Google image license metadata to the primary page image", () => {
    const data = buildStructuredData("dashboard") as {
      "@graph": Array<Record<string, unknown>>;
    };

    const webpage = data["@graph"].find(
      (item) => item["@id"] === "https://catc.zyhe.me/#webpage",
    );

    expect(webpage).toMatchObject({
      primaryImageOfPage: {
        "@type": "ImageObject",
        url: "https://catc.zyhe.me/social-preview.png",
        contentUrl: "https://catc.zyhe.me/social-preview.png",
        license: "https://github.com/Ate329/btc-cowen-atc/blob/main/LICENSE",
        acquireLicensePage:
          "https://github.com/Ate329/btc-cowen-atc/blob/main/LICENSE",
        creditText: "BTC Cowen ATC",
        creator: {
          "@type": "Organization",
          name: "BTC Cowen ATC",
          url: "https://catc.zyhe.me",
        },
      },
    });
  });

  it("applies route-specific head tags in the browser", () => {
    document.head.innerHTML = `
      <title></title>
      <meta name="description" content="" />
      <link rel="canonical" href="" />
      <script id="structured-data" type="application/ld+json"></script>
    `;

    applyPageSeo("about");

    expect(document.title).toBe(
      "Bitcoin ATC Quantile Model Methodology | BTC Cowen ATC",
    );
    expect(
      document.querySelector<HTMLMetaElement>('meta[name="description"]')
        ?.content,
    ).toBe(
      "Methodology notes for the Bitcoin ATC quantile model: Cowen paper inputs, BTC/USD data snapshot, projection caveats, and non-trading limits.",
    );
    expect(
      document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href,
    ).toBe("https://catc.zyhe.me/about/");
    expect(
      document.querySelector<HTMLMetaElement>('meta[property="og:image:alt"]')
        ?.content,
    ).toBe("BTC Cowen ATC chart preview with Bitcoin quantile model bands");

    const structuredData = JSON.parse(
      document.querySelector<HTMLScriptElement>("#structured-data")?.textContent ??
        "{}",
    );
    expect(JSON.stringify(structuredData)).toContain("BreadcrumbList");
  });
});
