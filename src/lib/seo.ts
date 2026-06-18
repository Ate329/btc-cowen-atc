import seoConfigJson from "../data/seo-config.json";

export type SeoPage = "dashboard" | "about";

type SeoLink = {
  label: string;
  href: string;
};

type PageSeo = {
  title: string;
  description: string;
  path: "/" | "/about/";
  breadcrumb: string;
  fallback: {
    heading: string;
    paragraphs: string[];
    links: SeoLink[];
  };
};

type SeoConfig = {
  siteUrl: string;
  siteName: string;
  siteDescription: string;
  author: string;
  locale: string;
  language: string;
  socialImage: {
    url: string;
    width: number;
    height: number;
    type: string;
    alt: string;
    licenseUrl: string;
    acquireLicensePageUrl: string;
    creditText: string;
  };
  cowenPaperUrl: string;
  keywords: string[];
  dataset: {
    name: string;
    description: string;
    path: string;
    temporalCoverage: string;
    encodingFormat: string;
    licenseUrl: string;
    measurementTechnique: string;
    variables: string[];
  };
  pages: Record<SeoPage, PageSeo>;
};

const seoConfig = seoConfigJson as SeoConfig;

export const SITE_URL = seoConfig.siteUrl;
export const SITE_NAME = seoConfig.siteName;
export const SITE_DESCRIPTION = seoConfig.siteDescription;
export const AUTHOR = seoConfig.author;
export const SOCIAL_IMAGE_URL = absoluteUrl(seoConfig.socialImage.url);
export const COWEN_PAPER_URL = seoConfig.cowenPaperUrl;
export const seoPages = seoConfig.pages;

export function getCanonicalUrl(page: SeoPage): string {
  return absoluteUrl(seoPages[page].path);
}

export function buildStructuredData(page: SeoPage) {
  const pageSeo = seoPages[page];
  const canonicalUrl = getCanonicalUrl(page);
  const publisherId = `${SITE_URL}/#publisher`;
  const websiteId = `${SITE_URL}/#website`;
  const webappId = `${SITE_URL}/#webapp`;
  const datasetUrl = absoluteUrl(seoConfig.dataset.path);
  const datasetId = `${datasetUrl}#dataset`;
  const breadcrumbId = `${canonicalUrl}#breadcrumb`;

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": publisherId,
        name: SITE_NAME,
        url: SITE_URL,
      },
      {
        "@type": "WebSite",
        "@id": websiteId,
        name: SITE_NAME,
        url: SITE_URL,
        description: SITE_DESCRIPTION,
        publisher: { "@id": publisherId },
        inLanguage: seoConfig.language,
      },
      {
        "@type": "WebApplication",
        "@id": webappId,
        name: SITE_NAME,
        url: SITE_URL,
        applicationCategory: "FinanceApplication",
        operatingSystem: "Any",
        isAccessibleForFree: true,
        description: SITE_DESCRIPTION,
        keywords: seoConfig.keywords,
        publisher: { "@id": publisherId },
        citation: COWEN_PAPER_URL,
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
        citation: COWEN_PAPER_URL,
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
        itemListElement: buildBreadcrumbItems(page, canonicalUrl),
      },
      {
        "@type": page === "about" ? ["WebPage", "AboutPage"] : "WebPage",
        "@id": `${canonicalUrl}#webpage`,
        url: canonicalUrl,
        name: pageSeo.title,
        headline: pageSeo.fallback.heading,
        description: pageSeo.description,
        keywords: seoConfig.keywords,
        isPartOf: { "@id": websiteId },
        primaryImageOfPage: {
          "@type": "ImageObject",
          url: SOCIAL_IMAGE_URL,
          contentUrl: SOCIAL_IMAGE_URL,
          width: seoConfig.socialImage.width,
          height: seoConfig.socialImage.height,
          caption: seoConfig.socialImage.alt,
          license: seoConfig.socialImage.licenseUrl,
          acquireLicensePage: seoConfig.socialImage.acquireLicensePageUrl,
          creditText: seoConfig.socialImage.creditText,
          creator: {
            "@type": "Organization",
            name: SITE_NAME,
            url: SITE_URL,
          },
        },
        breadcrumb: { "@id": breadcrumbId },
        about: [{ "@id": webappId }, { "@id": datasetId }],
        citation: COWEN_PAPER_URL,
        inLanguage: seoConfig.language,
      },
    ],
  };
}

export function applyPageSeo(page: SeoPage) {
  const pageSeo = seoPages[page];
  const canonicalUrl = getCanonicalUrl(page);

  document.title = pageSeo.title;
  setMetaByName("description", pageSeo.description);
  setMetaByName("author", AUTHOR);
  setMetaByName("robots", "index,follow,max-image-preview:large");
  setMetaByName("twitter:card", "summary_large_image");
  setMetaByName("twitter:title", pageSeo.title);
  setMetaByName("twitter:description", pageSeo.description);
  setMetaByName("twitter:image", SOCIAL_IMAGE_URL);
  setMetaByName("twitter:image:alt", seoConfig.socialImage.alt);
  setMetaByProperty("og:type", "website");
  setMetaByProperty("og:locale", seoConfig.locale);
  setMetaByProperty("og:site_name", SITE_NAME);
  setMetaByProperty("og:title", pageSeo.title);
  setMetaByProperty("og:description", pageSeo.description);
  setMetaByProperty("og:url", canonicalUrl);
  setMetaByProperty("og:image", SOCIAL_IMAGE_URL);
  setMetaByProperty("og:image:width", String(seoConfig.socialImage.width));
  setMetaByProperty("og:image:height", String(seoConfig.socialImage.height));
  setMetaByProperty("og:image:type", seoConfig.socialImage.type);
  setMetaByProperty("og:image:alt", seoConfig.socialImage.alt);
  setCanonicalUrl(canonicalUrl);
  setStructuredData(buildStructuredData(page));
}

function buildBreadcrumbItems(page: SeoPage, canonicalUrl: string) {
  const items = [
    {
      "@type": "ListItem",
      position: 1,
      name: SITE_NAME,
      item: `${SITE_URL}/`,
    },
  ];

  if (page !== "dashboard") {
    items.push({
      "@type": "ListItem",
      position: 2,
      name: seoPages[page].breadcrumb,
      item: canonicalUrl,
    });
  }

  return items;
}

function setMetaByName(name: string, content: string) {
  const element =
    document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`) ??
    createMeta("name", name);
  element.content = content;
}

function setMetaByProperty(property: string, content: string) {
  const element =
    document.querySelector<HTMLMetaElement>(`meta[property="${property}"]`) ??
    createMeta("property", property);
  element.content = content;
}

function createMeta(attribute: "name" | "property", value: string) {
  const element = document.createElement("meta");
  element.setAttribute(attribute, value);
  document.head.appendChild(element);
  return element;
}

function setCanonicalUrl(href: string) {
  const element =
    document.querySelector<HTMLLinkElement>('link[rel="canonical"]') ??
    createCanonicalLink();
  element.href = href;
}

function createCanonicalLink() {
  const element = document.createElement("link");
  element.rel = "canonical";
  document.head.appendChild(element);
  return element;
}

function setStructuredData(data: unknown) {
  const element =
    document.querySelector<HTMLScriptElement>("#structured-data") ??
    createStructuredDataScript();
  element.textContent = JSON.stringify(data);
}

function createStructuredDataScript() {
  const element = document.createElement("script");
  element.id = "structured-data";
  element.type = "application/ld+json";
  document.head.appendChild(element);
  return element;
}

function absoluteUrl(pathOrUrl: string): string {
  return new URL(pathOrUrl, SITE_URL).toString();
}
