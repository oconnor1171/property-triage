const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const path = require("path");

const app = express();
app.use(express.static(path.join(__dirname, "build")));

function parseAddressFromUrl(url) {
  try {
    // LoopNet: /Listing/Street-Address-City-ST/12345
    const loopnet = url.match(/\/Listing\/([^/]+)\/(\d+)/);
    if (loopnet) {
      const parts = loopnet[1].split("-");
      let state = null;
      if (/^[A-Z]{2}$/.test(parts[parts.length - 1])) state = parts.pop();
      const streetTypes = ["Ave","Blvd","St","Dr","Rd","Ln","Way","Ct","Pl","Pkwy","Hwy","Cir","Ter","Trl","Loop"];
      let streetEnd = -1;
      for (let i = 0; i < parts.length; i++) {
        if (streetTypes.includes(parts[i])) { streetEnd = i; break; }
      }
      const street = streetEnd >= 0 ? parts.slice(0, streetEnd + 1).join(" ") : parts.join(" ");
      const city = streetEnd >= 0 ? parts.slice(streetEnd + 1).join(" ") : null;
      const location = [street, city, state].filter(Boolean).join(", ");
      return { street, city, state, location };
    }
    // Zillow: /homedetails/123-Street-Name-City-ST-12345/
    const zillow = url.match(/\/homedetails\/([^/]+)\//);
    if (zillow) {
      const parts = zillow[1].split("-");
      const zip = /^\d{5}$/.test(parts[parts.length - 1]) ? parts.pop() : null;
      const state = /^[A-Z]{2}$/.test(parts[parts.length - 1]) ? parts.pop() : null;
      const location = parts.join(" ") + (state ? `, ${state}` : "") + (zip ? ` ${zip}` : "");
      return { street: parts.join(" "), city: null, state, location };
    }
    // Crexi: /properties/city-st-address/123456 or /for-sale/details/city/...
    const crexi = url.match(/crexi\.com\/(?:properties|for-sale)\/([^/]+)/);
    if (crexi) {
      const slug = crexi[1].replace(/-/g, " ");
      return { street: slug, city: null, state: null, location: slug };
    }
    // Realtor.com: /realestateandhomes-detail/Address_City_ST_ZIP
    const realtor = url.match(/realestateandhomes-detail\/([^?#]+)/);
    if (realtor) {
      const parts = realtor[1].replace(/_/g, " ").split(" ");
      const location = parts.join(", ");
      return { street: parts[0] || "", city: null, state: null, location };
    }
  } catch {}
  return null;
}

app.get("/api/fetch-listing", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing url" });

  const addrInfo = parseAddressFromUrl(url);
  const fallback = {
    name: addrInfo?.location || "Property",
    location: addrInfo?.location || null,
    price: null, units: null, capRate: null,
    yearBuilt: null, sqft: null, description: "",
  };

  try {
    const { data: html } = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Cache-Control": "max-age=0",
        "Referer": "https://www.google.com/",
      },
      timeout: 12000,
    });

    const $ = cheerio.load(html);
    const prop = { ...fallback };

    // JSON-LD structured data (richest source when available)
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).html() || "{}");
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          if (item.name && prop.name === fallback.name) prop.name = item.name;
          if (item.description && !prop.description) prop.description = item.description;
          if (item.address) {
            const a = item.address;
            prop.location = [a.streetAddress, a.addressLocality, a.addressRegion].filter(Boolean).join(", ");
          }
          if (item.offers?.price) prop.price = parseInt(String(item.offers.price).replace(/[^0-9]/g, ""));
        }
      } catch {}
    });

    // OG meta tags
    if (prop.name === fallback.name) {
      const og = $('meta[property="og:title"]').attr("content") || "";
      if (og) prop.name = og.replace(/\s*[-|].*$/, "").trim();
    }
    if (!prop.description) {
      prop.description = $('meta[property="og:description"]').attr("content") || "";
    }

    // Text extraction fallbacks
    const pageText = $("body").text().replace(/\s+/g, " ");

    if (!prop.price) {
      const matches = pageText.match(/\$([\d,]+)/g) || [];
      for (const m of matches) {
        const val = parseInt(m.replace(/[^0-9]/g, ""));
        if (val >= 100000 && val <= 10000000) { prop.price = val; break; }
      }
    }
    if (!prop.units) {
      const um = pageText.match(/(\d+)\s*(?:unit|apt|apartment|suite)s?\b/i);
      if (um) prop.units = parseInt(um[1]);
    }
    if (!prop.capRate) {
      const cm = pageText.match(/(\d+\.?\d*)\s*%\s*cap(?:\s*rate)?/i);
      if (cm) prop.capRate = parseFloat(cm[1]) / 100;
    }
    if (!prop.yearBuilt) {
      const ym = pageText.match(/(?:year\s*built|built\s*in|built:?)\s*(\d{4})/i);
      if (ym) prop.yearBuilt = ym[1];
    }
    if (!prop.sqft) {
      const sm = pageText.match(/([\d,]+)\s*(?:sq\.?\s*ft\.?|sf|square\s*feet)/i);
      if (sm) prop.sqft = parseInt(sm[1].replace(/,/g, ""));
    }

    const hasData = prop.price || prop.units || prop.capRate;
    return res.json({ success: true, prop, partial: !hasData });

  } catch (err) {
    const status = err.response?.status;
    const blocked = status === 403 || status === 429 || status === 503;
    return res.json({
      success: false,
      blocked,
      message: blocked
        ? "Site blocked direct access — address extracted from URL where possible. Fill in remaining details and run triage, or paste the full listing page text in the Paste tab."
        : `Fetch failed (${err.message}). Try pasting the full page text in the Paste tab instead.`,
      prop: fallback,
    });
  }
});

// SPA catch-all
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "build", "index.html"));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Property Triage server on port ${PORT}`));
