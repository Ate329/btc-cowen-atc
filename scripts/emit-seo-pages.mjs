import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const distDir = path.join(rootDir, "dist");
const indexPath = path.join(distDir, "index.html");
const aboutDir = path.join(distDir, "about");
const aboutPath = path.join(aboutDir, "index.html");
const sitemapPath = path.join(distDir, "sitemap.xml");
const robotsPath = path.join(distDir, "robots.txt");
const datasetPath = path.join(distDir, "data", "btc-atc.json");
const seoConfigPath = path.join(rootDir, "src", "data", "seo-config.json");

const seoConfig = JSON.parse(await readFile(seoConfigPath, "utf8"));
const lastmod = await getSnapshotDate();
const indexHtml = await readFile(indexPath, "utf8");

await writeFile(indexPath, withPageSeo(indexHtml, "dashboard"), "utf8");
await mkdir(aboutDir, { recursive: true });
await writeFile(aboutPath, withPageSeo(indexHtml, "about"), "utf8");
await writeFile(sitemapPath, buildSitemap(lastmod), "utf8");
await writeFile(robotsPath, buildRobots(), "utf8");

console.log(
  "Emitted SEO pages: dist/index.html, dist/about/index.html, dist/sitemap.xml, and dist/robots.txt",
);

function withPageSeo(html, pageKey) {
  const page = seoConfig.pages[pageKey];
  const canonicalUrl = getCanonicalUrl(pageKey);
  const structuredData = buildStructuredData(pageKey);
  const headTags = [
    [metaNamePattern("description"), metaName("description", page.description)],
    [metaNamePattern("author"), metaName("author", seoConfig.author)],
    [metaNamePattern("robots"), metaName("robots", "index,follow,max-image-preview:large")],
    [canonicalPattern(), `<link rel="canonical" href="${canonicalUrl}" />`],
    [sitemapLinkPattern(), `<link rel="sitemap" type="application/xml" href="/sitemap.xml" />`],
    [metaPropertyPattern("og:locale"), metaProperty("og:locale", seoConfig.locale)],
    [metaPropertyPattern("og:title"), metaProperty("og:title", page.title)],
    [metaPropertyPattern("og:description"), metaProperty("og:description", page.description)],
    [metaPropertyPattern("og:url"), metaProperty("og:url", canonicalUrl)],
    [metaPropertyPattern("og:image"), metaProperty("og:image", absoluteUrl(seoConfig.socialImage.url))],
    [metaPropertyPattern("og:image:width"), metaProperty("og:image:width", String(seoConfig.socialImage.width))],
    [metaPropertyPattern("og:image:height"), metaProperty("og:image:height", String(seoConfig.socialImage.height))],
    [metaPropertyPattern("og:image:alt"), metaProperty("og:image:alt", seoConfig.socialImage.alt)],
    [metaNamePattern("twitter:title"), metaName("twitter:title", page.title)],
    [metaNamePattern("twitter:description"), metaName("twitter:description", page.description)],
    [metaNamePattern("twitter:image"), metaName("twitter:image", absoluteUrl(seoConfig.socialImage.url))],
    [metaNamePattern("twitter:image:alt"), metaName("twitter:image:alt", seoConfig.socialImage.alt)],
    [
      structuredDataPattern(),
      `<script id="structured-data" type="application/ld+json">${escapeJsonScript(
        structuredData,
      )}</script>`,
    ],
  ];

  let output = upsertTitle(html, page.title);
  for (const [pattern, replacement] of headTags) {
    output = upsertHeadTag(output, pattern, replacement);
  }

  return replaceRootFallback(output, pageKey);
}

function upsertTitle(html, title) {
  return html.replace(
    /<title>[\s\S]*?<\/title>/i,
    `<title>${escapeText(title)}</title>`,
  );
}

function upsertHeadTag(html, pattern, replacement) {
  if (pattern.test(html)) {
    return html.replace(pattern, replacement);
  }

  return html.replace(/<head>/i, `<head>\n    ${replacement}`);
}

function replaceRootFallback(html, pageKey) {
  const fallback = buildFallbackHtml(pageKey);
  const rootPattern = /<div id="root">[\s\S]*?<\/div>/i;

  if (!rootPattern.test(html)) {
    return html;
  }

  return html.replace(rootPattern, `<div id="root">${fallback}</div>`);
}

function buildFallbackHtml(pageKey) {
  const fallback = seoConfig.pages[pageKey].fallback;
  const paragraphs = fallback.paragraphs
    .map((paragraph) => `      <p>${escapeText(paragraph)}</p>`)
    .join("\n");
  const links = fallback.links
    .map((link) => {
      const href = escapeAttribute(link.href);
      const rel = isExternalUrl(link.href) ? ' rel="noreferrer"' : "";
      return `          <li><a href="${href}"${rel}>${escapeText(link.label)}</a></li>`;
    })
    .join("\n");

  return `
      <main class="seo-fallback" aria-label="${escapeAttribute(
        seoConfig.pages[pageKey].breadcrumb,
      )}">
        <h1>${escapeText(fallback.heading)}</h1>
${paragraphs}
        <nav aria-label="Important links">
          <ul>
${links}
          </ul>
        </nav>
      </main>
    `;
}

function getCanonicalUrl(pageKey) {
  return absoluteUrl(seoConfig.pages[pageKey].path);
}

function buildStructuredData(pageKey) {
  const page = seoConfig.pages[pageKey];
  const canonicalUrl = getCanonicalUrl(pageKey);
  const publisherId = `${seoConfig.siteUrl}/#publisher`;
  const websiteId = `${seoConfig.siteUrl}/#website`;
  const webappId = `${seoConfig.siteUrl}/#webapp`;
  const datasetUrl = absoluteUrl(seoConfig.dataset.path);
  const datasetId = `${datasetUrl}#dataset`;
  const breadcrumbId = `${canonicalUrl}#breadcrumb`;

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": publisherId,
        name: seoConfig.siteName,
        url: seoConfig.siteUrl,
      },
      {
        "@type": "WebSite",
        "@id": websiteId,
        name: seoConfig.siteName,
        url: seoConfig.siteUrl,
        description: seoConfig.siteDescription,
        publisher: { "@id": publisherId },
        inLanguage: seoConfig.language,
      },
      {
        "@type": "WebApplication",
        "@id": webappId,
        name: seoConfig.siteName,
        url: seoConfig.siteUrl,
        applicationCategory: "FinanceApplication",
        operatingSystem: "Any",
        isAccessibleForFree: true,
        description: seoConfig.siteDescription,
        keywords: seoConfig.keywords,
        publisher: { "@id": publisherId },
        citation: seoConfig.cowenPaperUrl,
      },
      {
        "@type": "Dataset",
        "@id": datasetId,
        name: seoConfig.dataset.name,
        description: seoConfig.dataset.description,
        url: datasetUrl,
        temporalCoverage: seoConfig.dataset.temporalCoverage,
        isAccessibleForFree: true,
        license: seoConfig.dataset.licenseUrl,
        creator: { "@id": publisherId },
        publisher: { "@id": publisherId },
        citation: seoConfig.cowenPaperUrl,
        measurementTechnique: seoConfig.dataset.measurementTechnique,
        variableMeasured: seoConfig.dataset.variables,
        distribution: {
          "@type": "DataDownload",
          contentUrl: datasetUrl,
          encodingFormat: seoConfig.dataset.encodingFormat,
        },
      },
      {
        "@type": "BreadcrumbList",
        "@id": breadcrumbId,
        itemListElement: buildBreadcrumbItems(pageKey, canonicalUrl),
      },
      {
        "@type": pageKey === "about" ? ["WebPage", "AboutPage"] : "WebPage",
        "@id": `${canonicalUrl}#webpage`,
        url: canonicalUrl,
        name: page.title,
        headline: page.fallback.heading,
        description: page.description,
        keywords: seoConfig.keywords,
        isPartOf: { "@id": websiteId },
        primaryImageOfPage: {
          "@type": "ImageObject",
          url: absoluteUrl(seoConfig.socialImage.url),
          contentUrl: absoluteUrl(seoConfig.socialImage.url),
          width: seoConfig.socialImage.width,
          height: seoConfig.socialImage.height,
          caption: seoConfig.socialImage.alt,
          license: seoConfig.socialImage.licenseUrl,
          acquireLicensePage: seoConfig.socialImage.acquireLicensePageUrl,
          creditText: seoConfig.socialImage.creditText,
          creator: {
            "@type": "Organization",
            name: seoConfig.siteName,
            url: seoConfig.siteUrl,
          },
        },
        breadcrumb: { "@id": breadcrumbId },
        about: [{ "@id": webappId }, { "@id": datasetId }],
        citation: seoConfig.cowenPaperUrl,
        inLanguage: seoConfig.language,
      },
    ],
  };
}

function buildBreadcrumbItems(pageKey, canonicalUrl) {
  const items = [
    {
      "@type": "ListItem",
      position: 1,
      name: seoConfig.siteName,
      item: `${seoConfig.siteUrl}/`,
    },
  ];

  if (pageKey !== "dashboard") {
    items.push({
      "@type": "ListItem",
      position: 2,
      name: seoConfig.pages[pageKey].breadcrumb,
      item: canonicalUrl,
    });
  }

  return items;
}

function buildSitemap(snapshotLastmod) {
  const pageEntries = Object.values(seoConfig.pages).map((page) =>
    sitemapEntry({
      loc: absoluteUrl(page.path),
      lastmod: snapshotLastmod,
      changefreq: page.path === "/" ? "daily" : "monthly",
      priority: page.path === "/" ? "1.0" : "0.7",
    }),
  );
  const datasetEntry = sitemapEntry({
    loc: absoluteUrl(seoConfig.dataset.path),
    lastmod: snapshotLastmod,
    changefreq: "daily",
    priority: "0.4",
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[...pageEntries, datasetEntry].join("\n")}
</urlset>
`;
}

function sitemapEntry({ loc, lastmod, changefreq, priority }) {
  return `  <url>
    <loc>${escapeXml(loc)}</loc>
    <lastmod>${escapeXml(lastmod)}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`;
}

function buildRobots() {
  return `User-agent: Googlebot
Allow: /

User-agent: Bingbot
Allow: /

User-agent: OAI-SearchBot
Allow: /

User-agent: GPTBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: *
Allow: /

Sitemap: ${absoluteUrl("/sitemap.xml")}
`;
}

async function getSnapshotDate() {
  try {
    const dataset = JSON.parse(await readFile(datasetPath, "utf8"));
    const generatedAt = dataset?.metadata?.generatedAt;
    if (typeof generatedAt === "string" && /^\d{4}-\d{2}-\d{2}/.test(generatedAt)) {
      return generatedAt.slice(0, 10);
    }
  } catch {
    return new Date().toISOString().slice(0, 10);
  }

  return new Date().toISOString().slice(0, 10);
}

function metaNamePattern(name) {
  return new RegExp(`<meta\\s+[^>]*name="${escapeRegExp(name)}"[^>]*>`, "i");
}

function metaPropertyPattern(property) {
  return new RegExp(`<meta\\s+[^>]*property="${escapeRegExp(property)}"[^>]*>`, "i");
}

function canonicalPattern() {
  return /<link\s+[^>]*rel="canonical"[^>]*>/i;
}

function sitemapLinkPattern() {
  return /<link\s+[^>]*rel="sitemap"[^>]*>/i;
}

function structuredDataPattern() {
  return /<script id="structured-data" type="application\/ld\+json">[\s\S]*?<\/script>/i;
}

function metaName(name, content) {
  return `<meta name="${escapeAttribute(name)}" content="${escapeAttribute(content)}" />`;
}

function metaProperty(property, content) {
  return `<meta property="${escapeAttribute(property)}" content="${escapeAttribute(content)}" />`;
}

function absoluteUrl(pathOrUrl) {
  return new URL(pathOrUrl, seoConfig.siteUrl).toString();
}

function isExternalUrl(href) {
  try {
    return new URL(href, seoConfig.siteUrl).origin !== seoConfig.siteUrl;
  } catch {
    return false;
  }
}

function escapeAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeXml(value) {
  return escapeText(value).replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeJsonScript(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}
