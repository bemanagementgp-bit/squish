# Squish – Free Online Image Compressor

Private, in-browser image compressor. Compress, resize and convert JPG, PNG and WebP images without uploading anything: every byte is processed with the Canvas API on the user's device.

**Live:** https://__SITE_URL__/ (placeholder – replace after deploy)

## Features

**Free**
- Drag & drop, file picker (multiple), folder drop and paste-from-clipboard
- Quality slider (10–100, default 75), output format (keep / JPEG / PNG / WebP), max width/height resize (default 1920 px, "no resize" option)
- "Keep original if result is bigger" toggle
- Up to 10 images per batch, 10 MB each; 3 images processed concurrently
- Results list with thumbnail, original → new size, % saved, dimensions, per-file download and remove
- Summary bar (total original / compressed / saved)
- Before/after comparison modal with a reveal slider
- EXIF metadata is stripped by the canvas re-encode (privacy feature)
- Friendly error for HEIC/HEIF (browsers cannot decode it)
- Settings persisted in `localStorage`; dark/light theme

**Pro (one-time, price from `config.js`)**
- Unlimited images per batch, up to 50 MB per file
- Download all as ZIP (JSZip loaded lazily from jsDelivr only when used)
- Custom output filename pattern (`{name}`, `{ext}`, `{index}`, `{w}`, `{h}`)
- Target file size mode (binary search over quality, up to 7 iterations)

## Files

```
index.html     tool page + SEO content + FAQ (JSON-LD WebApplication + FAQPage)
styles.css     _shared/base.css + app styles
app.js         tool logic (vanilla JS, no build step)
monetize.js    shared theme / toast / analytics / AdSense / Pro helpers
config.js      window.APP_CONFIG (site URL, AdSense, GA, checkout URL, price)
privacy.html   privacy policy (required for AdSense)
terms.html     terms of use
robots.txt, sitemap.xml, vercel.json, favicon.svg, .gitignore
```

## Run locally

```bash
npx serve .
```

Then open the printed URL (usually http://localhost:3000). No build step.

## Deploy

Deploy the folder as a static site on Vercel (`vercel --prod`). After the first deploy, replace the placeholder URL everywhere:

```bash
sed -i 's/__SITE_URL__/squish.example.com/g' index.html privacy.html terms.html robots.txt sitemap.xml config.js README.md
```

## Monetization setup

1. **AdSense** – create an AdSense account, add the site, then set `ADSENSE_CLIENT: "ca-pub-XXXXXXXXXXXXXXXX"` in `config.js`. The three ad slots (`sidebar-1`, `sidebar-2`, `below-tool`) are filled automatically; until then they show a dashed placeholder. `privacy.html` already discloses advertising cookies.
2. **Analytics** – create a GA4 property and set `GA_ID: "G-XXXXXXX"`. Events tracked: `add_files`, `generate`, `download`, `download_all`, `download_zip`, `compare_open`, `sample`, `pro_click`, `begin_checkout`.
3. **Pro checkout** – create a one-time product (Lemon Squeezy, Gumroad or Stripe Payment Link) and set `PRO_CHECKOUT_URL`. Set `PRO_PRICE` to match. Buyers receive a license key by email and paste it into the Pro modal ("Enter license key"). The default validation in `monetize.js` accepts any key of 8+ characters; replace `activateLicense` with a real check (e.g. Lemon Squeezy license API) before launch.
4. **Affiliates (optional)** – add links to `AFFILIATE_LINKS` in `config.js` and reference them from the content section (e.g. image CDN or hosting offers).

## Notes

- The only external request is the lazy JSZip load when a Pro user clicks "Download ZIP". Images are never sent anywhere.
- WebP encoding is unsupported in old Safari (< 16); the app detects the fallback and labels the result accordingly.
- Animated GIFs lose animation when re-encoded (canvas only sees the first frame); the UI notes this.
