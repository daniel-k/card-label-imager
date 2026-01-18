import fs from "node:fs/promises";
import path from "node:path";

const distDir = path.resolve("dist");
const sourceHtmlPath = path.join(distDir, "index.html");
const outputHtmlPath = path.join(distDir, "card-label-imager.html");
const cssImportRegex = /@import\s*(?:url\()?['"]?([^'")]+)['"]?\)?\s*;/g;
const cssUrlRegex = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
const fetchHeaders = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

const mimeTypes = new Map([
  [".woff2", "font/woff2"],
  [".woff", "font/woff"],
  [".ttf", "font/ttf"],
  [".otf", "font/otf"],
  [".eot", "application/vnd.ms-fontobject"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

function resolveAssetPath(assetUrl) {
  const cleanUrl = stripQueryAndHash(assetUrl);
  const relativePath = cleanUrl.startsWith("/") ? cleanUrl.slice(1) : cleanUrl;
  return path.join(distDir, relativePath);
}

function stripQueryAndHash(value) {
  return value.split("?")[0].split("#")[0];
}

function escapeScriptContent(content) {
  return content.replace(/<\/script>/gi, "<\\/script>");
}

function escapeStyleContent(content) {
  return content.replace(/<\/style>/gi, "<\\/style>");
}

function isRemoteUrl(url) {
  return url.startsWith("http://") || url.startsWith("https://");
}

function isSkippableUrl(url) {
  return (
    url.startsWith("data:") ||
    url.startsWith("blob:") ||
    url.startsWith("about:") ||
    url.startsWith("#")
  );
}

function resolveResource(url, base) {
  if (isRemoteUrl(url)) {
    return { type: "remote", url };
  }
  if (url.startsWith("//")) {
    return { type: "remote", url: `https:${url}` };
  }
  if (base.type === "remote") {
    return { type: "remote", url: new URL(url, base.url).toString() };
  }
  const cleanUrl = stripQueryAndHash(url);
  if (cleanUrl.startsWith("/")) {
    return { type: "local", path: path.join(distDir, cleanUrl.slice(1)) };
  }
  return { type: "local", path: path.resolve(base.dir, cleanUrl) };
}

function guessMimeType(resourcePath, contentType) {
  if (contentType) {
    return contentType.split(";")[0];
  }
  const ext = path.extname(stripQueryAndHash(resourcePath)).toLowerCase();
  return mimeTypes.get(ext) || "application/octet-stream";
}

async function loadTextResource(resource) {
  try {
    if (resource.type === "remote") {
      const response = await fetch(resource.url, { headers: fetchHeaders });
      if (!response.ok) {
        return null;
      }
      return await response.text();
    }
    return await fs.readFile(resource.path, "utf8");
  } catch (error) {
    console.warn(`Failed to inline CSS from ${resource.url ?? resource.path}`);
    return null;
  }
}

async function loadBinaryResource(resource) {
  try {
    if (resource.type === "remote") {
      const response = await fetch(resource.url, { headers: fetchHeaders });
      if (!response.ok) {
        return null;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      return {
        buffer,
        mimeType: guessMimeType(
          resource.url,
          response.headers.get("content-type"),
        ),
      };
    }
    const buffer = await fs.readFile(resource.path);
    return {
      buffer,
      mimeType: guessMimeType(resource.path, null),
    };
  } catch (error) {
    console.warn(
      `Failed to inline asset from ${resource.url ?? resource.path}`,
    );
    return null;
  }
}

async function inlineCss(cssText, base) {
  const withImports = await inlineCssImports(cssText, base);
  return inlineCssUrls(withImports, base);
}

async function inlineCssImports(cssText, base) {
  const matches = [...cssText.matchAll(cssImportRegex)];
  if (matches.length === 0) {
    return cssText;
  }
  let output = "";
  let lastIndex = 0;
  for (const match of matches) {
    const start = match.index ?? 0;
    output += cssText.slice(lastIndex, start);
    lastIndex = start + match[0].length;

    const importUrl = match[1].trim();
    if (isSkippableUrl(importUrl)) {
      output += match[0];
      continue;
    }

    const resource = resolveResource(importUrl, base);
    const imported = await loadTextResource(resource);
    if (!imported) {
      continue;
    }
    const importBase =
      resource.type === "remote"
        ? { type: "remote", url: resource.url }
        : { type: "local", dir: path.dirname(resource.path) };
    output += await inlineCss(imported, importBase);
  }
  output += cssText.slice(lastIndex);
  return output;
}

async function inlineCssUrls(cssText, base) {
  let output = "";
  let lastIndex = 0;
  for (const match of cssText.matchAll(cssUrlRegex)) {
    const start = match.index ?? 0;
    output += cssText.slice(lastIndex, start);
    lastIndex = start + match[0].length;

    const rawUrl = match[2].trim();
    if (isSkippableUrl(rawUrl)) {
      output += match[0];
      continue;
    }

    const resource = resolveResource(rawUrl, base);
    const asset = await loadBinaryResource(resource);
    if (!asset) {
      output += match[0];
      continue;
    }

    const dataUri = `data:${asset.mimeType};base64,${asset.buffer.toString(
      "base64",
    )}`;
    output += `url("${dataUri}")`;
  }
  output += cssText.slice(lastIndex);
  return output;
}

async function inlineAssets() {
  const html = await fs.readFile(sourceHtmlPath, "utf8");
  let output = html.replace(/<link rel="modulepreload"[^>]*>/g, "");

  const cssLinks = [...output.matchAll(/<link[^>]+rel="stylesheet"[^>]+>/g)];
  for (const match of cssLinks) {
    const hrefMatch = match[0].match(/href="([^"]+)"/);
    if (!hrefMatch) {
      continue;
    }
    const assetPath = resolveAssetPath(hrefMatch[1]);
    const css = await fs.readFile(assetPath, "utf8");
    const inlinedCss = await inlineCss(css, {
      type: "local",
      dir: path.dirname(assetPath),
    });
    const styleTag = `<style>\n${escapeStyleContent(inlinedCss)}\n</style>`;
    output = output.replace(match[0], () => styleTag);
  }

  const scriptTags = [
    ...output.matchAll(
      /<script[^>]+type="module"[^>]+src="([^"]+)"[^>]*><\/script>/g,
    ),
  ];
  for (const match of scriptTags) {
    const assetPath = resolveAssetPath(match[1]);
    const js = await fs.readFile(assetPath, "utf8");
    const scriptTag = `<script type="module">\n${escapeScriptContent(
      js,
    )}\n</script>`;
    output = output.replace(match[0], () => scriptTag);
  }

  await fs.writeFile(outputHtmlPath, output);
  console.log(`Wrote single-file build to ${outputHtmlPath}`);
}

inlineAssets();
