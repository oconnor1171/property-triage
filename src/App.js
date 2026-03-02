import { useState, useCallback, useEffect } from "react";

const CRITERIA = {
  minCapRate: 0.07,
  maxPrice: 1_000_000,
  minUnits: 5,
  maxUnits: 20,
  downPayment: 0.25,
  interestRate: 0.0725,
  loanTermYears: 25,
  vacancyRate: 0.05,
  expenseRatio: 0.45,
  minDSCR: 1.25,
  minCoC: 0.08,
  // v2.0 — price per unit thresholds
  maxPricePerUnitHard: 250_000,   // auto-FAIL above this
  maxPricePerUnitWarn: 175_000,   // yellow flag above this
  maxPricePerUnitNoRent: 150_000, // no-rent listings only REVIEW if at/below this
};

// ─── v2.0: Land-play keyword detector ────────────────────────────────────────
const LAND_PLAY_KEYWORDS = [
  "redevelopment", "redevelop", "land value", "assemblage",
  "entitlement", "entitle", "ground lease", "land play",
  "development opportunity", "teardown", "tear down",
  "shovel ready", "build to suit", "land opportunity",
];

function isLandPlay(prop) {
  const text = `${prop.name} ${prop.description}`.toLowerCase();
  return LAND_PLAY_KEYWORDS.some((kw) => text.includes(kw));
}

function triageProperty(prop) {
  const flags = [], passes = [], disqualifiers = [];
  let score = 0;

  const landPlay = isLandPlay(prop);
  const noRentData = prop.capRate === null;
  const ppu = prop.price && prop.units ? prop.price / prop.units : null;

  // ── FIX 1: Land-play + no income data = hard FAIL ─────────────────────────
  if (landPlay && noRentData) {
    disqualifiers.push(
      "LAND / REDEVELOPMENT PLAY — no income data disclosed. Seller is pricing for land value, not cash flow. Not suitable for income underwriting."
    );
  } else if (landPlay) {
    flags.push("⚠ Redevelopment language detected — verify income thesis is primary, not land play");
  }

  // ── Price check ────────────────────────────────────────────────────────────
  if (prop.price > CRITERIA.maxPrice) {
    flags.push(`Price $${(prop.price/1000).toFixed(0)}K exceeds $1M limit`);
  } else if (prop.price) {
    passes.push(`Price $${(prop.price/1000).toFixed(0)}K ✓`);
    score += 20;
  }

  // ── Unit count ─────────────────────────────────────────────────────────────
  if (!prop.units || prop.units < CRITERIA.minUnits || prop.units > CRITERIA.maxUnits) {
    flags.push(`${prop.units ?? "?"} units outside 5–20 range`);
  } else {
    passes.push(`${prop.units} units ✓`);
    score += 15;
  }

  // ── FIX 2: Price-per-unit check ────────────────────────────────────────────
  if (ppu !== null) {
    if (ppu > CRITERIA.maxPricePerUnitHard) {
      disqualifiers.push(
        `Price/unit $${Math.round(ppu/1000)}K exceeds $250K hard limit — land premium detected, not income value`
      );
    } else if (ppu > CRITERIA.maxPricePerUnitWarn) {
      flags.push(`⚠ Price/unit $${Math.round(ppu/1000)}K is high (>$175K) — verify income justifies premium`);
    } else {
      passes.push(`Price/unit $${Math.round(ppu/1000)}K ✓`);
      score += 10;
    }
  }

  // ── FIX 3: Tightened no-cap-rate rule ─────────────────────────────────────
  let capRateStatus = "missing";
  if (prop.capRate !== null) {
    if (prop.capRate >= CRITERIA.minCapRate) {
      passes.push(`Cap rate ${(prop.capRate*100).toFixed(1)}% ≥ 7.0% ✓`);
      score += 30;
      capRateStatus = "pass";
    } else {
      flags.push(`Cap rate ${(prop.capRate*100).toFixed(1)}% below 7.0% threshold`);
      capRateStatus = "fail";
    }
  } else {
    if (ppu !== null && ppu <= CRITERIA.maxPricePerUnitNoRent) {
      // Low price/unit + no cap rate = possible genuine value-add
      flags.push("Cap rate not stated — possible value-add. Verify rent roll before proceeding.");
      capRateStatus = "missing-low-ppu";
      score += 5;
    } else {
      // Higher price/unit + no cap rate = cannot underwrite
      disqualifiers.push(
        `No cap rate or rent data disclosed + price/unit $${ppu ? Math.round(ppu/1000)+"K" : "unknown"} exceeds $150K threshold — cannot underwrite on income basis. Obtain rent roll from broker first.`
      );
      capRateStatus = "missing-high-ppu";
    }
  }

  // ── DSCR & CoC estimate ───────────────────────────────────────────────────
  let dscr = null, coc = null;
  if (prop.price && prop.capRate) {
    const noi = prop.price * prop.capRate;
    const loan = prop.price * (1 - CRITERIA.downPayment);
    const mr = CRITERIA.interestRate / 12;
    const n = CRITERIA.loanTermYears * 12;
    const pmt = loan * (mr * Math.pow(1+mr,n)) / (Math.pow(1+mr,n)-1);
    const debt = pmt * 12;
    dscr = noi / debt;
    coc = (noi - debt) / (prop.price * CRITERIA.downPayment);
    if (dscr >= CRITERIA.minDSCR) { passes.push(`Est. DSCR ${dscr.toFixed(2)}x ✓`); score += 20; }
    else { flags.push(`Est. DSCR ${dscr.toFixed(2)}x below 1.25x`); }
    if (coc >= CRITERIA.minCoC) { passes.push(`Est. CoC ${(coc*100).toFixed(1)}% ✓`); score += 15; }
    else { flags.push(`Est. CoC ${(coc*100).toFixed(1)}% below 8% target`); }
  }

  // ── Final verdict ─────────────────────────────────────────────────────────
  let verdict;
  if (disqualifiers.length > 0) {
    verdict = "FAIL";
  } else {
    const hardFails = flags.filter(f => !f.startsWith("⚠")).length;
    verdict =
      hardFails === 0 && score >= 65 ? "PASS" :
      (capRateStatus === "missing-low-ppu") && hardFails <= 1 && score >= 30 ? "REVIEW" :
      "FAIL";
  }

  return { flags, passes, disqualifiers, score, verdict, dscr, coc };
}

function extractSingleProperty(raw) {
  // Flatten to single line for regex, keep original lines for name extraction
  const flat = raw.replace(/\s+/g, " ").trim();
  const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);

  // Price — try in order of specificity
  let price = null;
  const pricePatterns = [
    /asking\s*(?:price)?:?\s*\$?([\d,.]+)\s*[Mm]/i,
    /(?:sale\s*price|list(?:ing)?\s*price|price):?\s*\$?([\d,.]+)\s*[Mm]/i,
    /\$([\d,.]+)\s*[Mm]\b/,
    /asking\s*(?:price)?:?\s*\$?([\d,]+)/i,
    /(?:sale\s*price|list(?:ing)?\s*price|price):?\s*\$?([\d,]+)/i,
    /\$([\d,]+)/,
  ];
  for (const p of pricePatterns) {
    const m = flat.match(p);
    if (m) {
      let v = m[1].replace(/,/g, "");
      if (/[Mm]/.test(m[0])) v = parseFloat(v) * 1e6;
      else if (/[Kk]/.test(m[0])) v = parseFloat(v) * 1e3;
      else v = parseFloat(v);
      if (v >= 50000 && v <= 15000000) { price = Math.round(v); break; }
    }
  }

  // Units
  let units = null;
  const unitPatterns = [
    /(?:number\s+of\s+units?|unit\s+count|total\s+units?):?\s*(\d+)/i,
    /(\d+)\s*-\s*unit/i,
    /(\d+)\s*unit(?:s|\s|$)/i,
    /(\d+)\s*(?:residential\s+)?(?:apartment|apt|suite)s?\b/i,
  ];
  for (const p of unitPatterns) {
    const m = flat.match(p);
    if (m) { const u = parseInt(m[1]); if (u >= 1 && u <= 999) { units = u; break; } }
  }

  // Cap rate
  let capRate = null;
  const capPatterns = [
    /cap\s*rate:?\s*([\d.]+)\s*%/i,
    /([\d.]+)\s*%\s*cap(?:\s*rate)?/i,
  ];
  for (const p of capPatterns) {
    const m = flat.match(p);
    if (m) { const c = parseFloat(m[1]) / 100; if (c > 0 && c < 0.5) { capRate = c; break; } }
  }

  // Year built
  let yearBuilt = null;
  const yearPatterns = [
    /(?:year\s*built|built\s*in|year\s*of\s*construction|built):?\s*(\d{4})/i,
    /(\d{4})\s*(?:built|construction|year)/i,
  ];
  for (const p of yearPatterns) {
    const m = flat.match(p);
    if (m) { const y = parseInt(m[1]); if (y >= 1850 && y <= 2030) { yearBuilt = String(y); break; } }
  }

  // Square footage
  let sqft = null;
  const sqftPatterns = [
    /(?:building\s+size|gross\s+(?:leasable\s+)?area|total\s+(?:sq\.?\s*ft|sf)|rentable\s+area):?\s*([\d,]+)/i,
    /([\d,]+)\s*(?:sq\.?\s*ft\.?|square\s*feet)\b/i,
    /([\d,]+)\s*sf\b/i,
  ];
  for (const p of sqftPatterns) {
    const m = flat.match(p);
    if (m) { const s = parseInt(m[1].replace(/,/g, "")); if (s >= 100 && s < 1000000) { sqft = s; break; } }
  }

  // Location — prefer full address with zip
  let location = null;
  const locPatterns = [
    /\d+\s+[\w\s]+(?:Ave|Blvd|St|Dr|Rd|Ln|Way|Ct|Pl|Pkwy|Hwy|Cir|Ter|Loop)\w*\.?,?\s*[\w\s]+,\s*[A-Z]{2}\s+\d{5}/i,
    /[\w\s]+,\s*[A-Z]{2}\s+\d{5}/,
    /[\w\s]+,\s*[A-Z]{2}\b/,
  ];
  for (const p of locPatterns) {
    const m = flat.match(p);
    if (m && m[0].length < 100) { location = m[0].trim(); break; }
  }

  // Property name — first non-boilerplate line that looks like a title
  const skipPhrases = /^(menu|home|search|log\s*in|sign|for\s*sale|loopnet|crexi|browse|commercial|©|all\s*rights|cookie|privacy|terms|share|save|print|map|street|photo|back\s*to)/i;
  let name = null;
  for (const line of lines.slice(0, 20)) {
    if (skipPhrases.test(line)) continue;
    if (line.length < 6 || line.length > 150) continue;
    if (/^\d+$/.test(line)) continue;
    if (/^https?:/.test(line)) continue;
    name = line;
    break;
  }
  if (!name) name = location || "Property";

  // Description — grab the meatiest paragraph
  const description = lines.filter(l => l.length > 60 && l.length < 600 && !skipPhrases.test(l)).slice(0, 3).join(" ");

  return { name, price, units, capRate, yearBuilt, sqft, location, description };
}

function parsePastedListings(raw) {
  try {
    // For large pastes (full page copies), always try single-property extraction
    if (raw.trim().length > 400) {
      const single = extractSingleProperty(raw);
      if (single.price || single.units || single.capRate) return [single];
    }

    // Structured multi-block format (short, formatted input)
    const lines = raw.trim().split("\n").filter(l => l.trim());
    const properties = []; let current = null;
    for (const line of lines) {
      const l = line.trim();
      const isHeader = /^\$[\d,]+/.test(l) || /\d+\s*units?/i.test(l) || (/[A-Z].*,\s*[A-Z]{2}/.test(l) && l.length < 80);
      if (isHeader && !current) { current = { name: l, price: null, units: null, capRate: null, yearBuilt: null, sqft: null, location: null, description: "" }; }
      else if (isHeader && current) { properties.push(current); current = { name: l, price: null, units: null, capRate: null, yearBuilt: null, sqft: null, location: null, description: "" }; }
      else if (current) {
        const pm = l.match(/\$([0-9,]+)/); if (pm && !current.price) current.price = parseInt(pm[1].replace(/,/g,""));
        const um = l.match(/(\d+)\s*units?/i); if (um) current.units = parseInt(um[1]);
        const cm = l.match(/(\d+\.?\d*)\s*%?\s*cap/i); if (cm) current.capRate = parseFloat(cm[1])/100;
        const ym = l.match(/(?:built|year built)\s*:?\s*(\d{4})/i); if (ym) current.yearBuilt = ym[1];
        const sm = l.match(/([\d,]+)\s*s[qf]/i); if (sm) current.sqft = parseInt(sm[1].replace(/,/g,""));
        if (/,\s*[A-Z]{2}/.test(l) && !current.location) current.location = l;
        current.description += " " + l;
      }
    }
    if (current) properties.push(current);
    const found = properties.filter(p => p.price || p.units);
    if (found.length) return found;

    // Last resort: try single extraction on the whole thing
    const single = extractSingleProperty(raw);
    return (single.price || single.units || single.capRate) ? [single] : [];
  } catch { return []; }
}

async function parseListingWithClaude(rawText, apiKey) {
  const prompt = `Extract multifamily real estate listing data from the text below. Return ONLY a valid JSON object with these fields (use null for any field you cannot find):
{
  "name": "property name or address",
  "price": 650000,
  "units": 8,
  "capRate": 0.082,
  "yearBuilt": "1962",
  "sqft": 6400,
  "location": "City, ST 12345",
  "description": "brief summary"
}

Rules:
- price: integer dollars (e.g. 650000 not "$650K")
- units: integer number of residential units
- capRate: decimal (e.g. 0.082 for 8.2%)
- yearBuilt: 4-digit string
- sqft: integer total building square footage
- Return ONLY the JSON object, no explanation

LISTING TEXT:
${rawText.slice(0, 6000)}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({ model: "claude-3-haiku-20240307", max_tokens: 400, messages: [{ role: "user", content: prompt }] })
  });
  if (!res.ok) {
    let errMsg = `API ${res.status}`;
    try { const e = await res.json(); errMsg += `: ${e.error?.message || JSON.stringify(e)}`; } catch {}
    throw new Error(errMsg);
  }
  const data = await res.json();
  const text = data.content?.map(b => b.text).join("") ?? "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Claude returned no JSON");
  return JSON.parse(match[0]);
}

async function analyzeWithClaude(prop, triage, apiKey) {
  const prompt = `You are a commercial real estate underwriter. Analyze this multifamily listing for an investor: national market, 5–20 units, under $1M, min 7% cap rate, max $175K/unit, 25% down, min DSCR 1.25x, min CoC 8%.

PROPERTY: ${prop.name}
Price: $${prop.price?.toLocaleString() ?? "Unknown"} | Units: ${prop.units ?? "?"} | Cap: ${prop.capRate ? (prop.capRate*100).toFixed(1)+"%" : "Not stated"}
Built: ${prop.yearBuilt ?? "?"} | SF: ${prop.sqft ?? "?"} | Location: ${prop.location ?? "?"}
Description: ${prop.description?.trim() ?? "None"}
Triage v2.0: ${triage.verdict} | Est. DSCR: ${triage.dscr?.toFixed(2)??"N/A"} | Est. CoC: ${triage.coc?(triage.coc*100).toFixed(1)+"%":"N/A"}
Disqualifiers: ${triage.disqualifiers?.join("; ")||"None"}
Flags: ${triage.flags.join("; ")||"None"}

Provide a 4-part brief:
1. DEAL THESIS (2 sentences — bull case)
2. RED FLAGS (2–4 bullets)
3. KEY UNKNOWNS (missing data that matters)
4. VERDICT: "Strong candidate for full underwrite" OR "Conditional — verify [X] first" OR "Pass — [reason]"

Be direct. Assume sophisticated buyer.`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({ model: "claude-3-haiku-20240307", max_tokens: 1000, messages: [{ role: "user", content: prompt }] })
  });
  if (!res.ok) {
    let errMsg = `API ${res.status}`;
    try { const e = await res.json(); errMsg += `: ${e.error?.message || JSON.stringify(e)}`; } catch {}
    throw new Error(errMsg);
  }
  const data = await res.json();
  return data.content?.map(b => b.text).join("") ?? "Unavailable.";
}

const DEMO = [
  { name: "8-Unit Brick Apartment — Cleveland, OH", price: 640000, units: 8, capRate: 0.082, yearBuilt: "1962", sqft: 6400, location: "Cleveland, OH 44105", description: "Fully occupied. Long-term tenants. New roof 2021." },
  { name: "12-Unit Mixed-Use — Raleigh, NC", price: 895000, units: 10, capRate: 0.071, yearBuilt: "1978", sqft: 9200, location: "Raleigh, NC 27601", description: "2 commercial storefronts + 10 residential. Below-market rents." },
  { name: "6-Unit Garden Apartment — Memphis, TN", price: 425000, units: 6, capRate: null, yearBuilt: "1955", sqft: 4800, location: "Memphis, TN 38104", description: "Rents below market. Owner retiring. Recent HVAC updates." },
  { name: "4-Unit Waterfront Quadruplex — Tampa, FL (Rocky Creek)", price: 999000, units: 4, capRate: null, yearBuilt: "1968", sqft: 2016, location: "Tampa, FL 33615", description: "Waterfront redevelopment opportunity. 200ft Rocky Creek frontage, boat ramp, dock. RMC-6 zoning. No rents disclosed." },
  { name: "7-Unit Multifamily — Birmingham, AL", price: 380000, units: 7, capRate: 0.091, yearBuilt: "1968", sqft: 5600, location: "Birmingham, AL 35203", description: "Below market rents. Owner carry available. Deferred maintenance noted." },
];

function Badge({ v }) {
  const s = { PASS: ["#0d2e1a","#22c55e","#4ade80","✓ PASS"], REVIEW: ["#1a1a0a","#eab308","#fbbf24","⚠ REVIEW"], FAIL: ["#2e0d0d","#ef4444","#f87171","✗ FAIL"] }[v];
  return <span style={{ background:s[0], border:`1px solid ${s[1]}`, color:s[2], padding:"3px 10px", borderRadius:4, fontSize:12, fontWeight:700, letterSpacing:"0.08em", fontFamily:"monospace", whiteSpace:"nowrap" }}>{s[3]}</span>;
}

function Pill({ label, value, good }) {
  const bg = good===null?"#1e2533":good?"#0d2e1a":"#2e0d0d";
  const bc = good===null?"#374151":good?"#166534":"#991b1b";
  const c = good===null?"#94a3b8":good?"#4ade80":"#f87171";
  return <span style={{ background:bg, border:`1px solid ${bc}`, color:c, padding:"2px 8px", borderRadius:3, fontSize:11, fontFamily:"monospace", whiteSpace:"nowrap" }}>{label}: <strong>{value}</strong></span>;
}

function Card({ prop, triage, onAnalyze, analysis, analyzing, hasKey }) {
  const [open, setOpen] = useState(false);
  const isLand = triage.disqualifiers?.some(d => d.includes("LAND") || d.includes("REDEVELOPMENT"));
  const borderColor = triage.verdict==="PASS"?"#166534":triage.verdict==="REVIEW"?"#854d0e":"#3f1010";
  const ppu = prop.price && prop.units ? prop.price / prop.units : null;
  return (
    <div style={{ background:"#0f1621", border:`1px solid ${borderColor}`, borderRadius:8, padding:"18px 20px", marginBottom:12 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:12, marginBottom:10 }}>
        <div>
          <div style={{ color:"#e2e8f0", fontFamily:"'DM Serif Display',Georgia,serif", fontSize:15, fontWeight:600, lineHeight:1.3, marginBottom:4 }}>{prop.name}</div>
          {prop.location && <div style={{ color:"#64748b", fontSize:12, fontFamily:"monospace" }}>{prop.location}</div>}
        </div>
        <Badge v={triage.verdict} />
      </div>
      <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:12 }}>
        {prop.price && <Pill label="Ask" value={`$${(prop.price/1000).toFixed(0)}K`} good={prop.price<=CRITERIA.maxPrice} />}
        {prop.units && <Pill label="Units" value={prop.units} good={prop.units>=CRITERIA.minUnits&&prop.units<=CRITERIA.maxUnits} />}
        {ppu !== null && <Pill label="$/Unit" value={`$${Math.round(ppu/1000)}K`} good={ppu<=CRITERIA.maxPricePerUnitWarn} />}
        {prop.capRate!==null ? <Pill label="Cap" value={`${(prop.capRate*100).toFixed(1)}%`} good={prop.capRate>=CRITERIA.minCapRate} /> : <Pill label="Cap" value="N/S" good={null} />}
        {triage.dscr!==null && <Pill label="Est.DSCR" value={`${triage.dscr.toFixed(2)}x`} good={triage.dscr>=CRITERIA.minDSCR} />}
        {triage.coc!==null && <Pill label="Est.CoC" value={`${(triage.coc*100).toFixed(1)}%`} good={triage.coc>=CRITERIA.minCoC} />}
        {prop.yearBuilt && <Pill label="Built" value={prop.yearBuilt} good={null} />}
      </div>

      {/* Hard disqualifiers — prominent red alert box */}
      {triage.disqualifiers?.length > 0 && (
        <div style={{ background:"#1a0505", border:"1px solid #7f1d1d", borderRadius:6, padding:"10px 14px", marginBottom:12 }}>
          <div style={{ color:"#fca5a5", fontSize:11, fontFamily:"monospace", letterSpacing:"0.08em", marginBottom:6 }}>
            ✗ AUTO-DISQUALIFIED{isLand ? " — LAND / REDEVELOPMENT PLAY" : ""}
          </div>
          {triage.disqualifiers.map((d, i) => (
            <div key={i} style={{ color:"#f87171", fontSize:12, lineHeight:1.7 }}>{d}</div>
          ))}
        </div>
      )}

      <div style={{ display:"flex", gap:20, marginBottom:12, fontSize:12 }}>
        <div>{triage.passes.map((p,i)=><div key={i} style={{ color:"#4ade80", lineHeight:1.7 }}>✓ {p}</div>)}</div>
        <div>{triage.flags.map((f,i)=><div key={i} style={{ color:f.startsWith("⚠")?"#fbbf24":"#f87171", lineHeight:1.7 }}>{f.startsWith("⚠")?"":"✗ "}{f}</div>)}</div>
      </div>
      <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
        {(triage.verdict==="PASS"||triage.verdict==="REVIEW") && (
          <button onClick={()=>{ if(hasKey){ onAnalyze(prop,triage); setOpen(true); } }} disabled={analyzing||!hasKey}
            style={{ background:analyzing||!hasKey?"#1e2533":"linear-gradient(135deg,#1e40af,#1d4ed8)", border:"none", color:!hasKey?"#4b5563":"#fff", padding:"7px 16px", borderRadius:5, fontSize:12, fontWeight:600, cursor:analyzing||!hasKey?"not-allowed":"pointer" }}>
            {analyzing?"⏳ Analyzing...":!hasKey?"🔒 Set API Key to Analyze":"🔍 Analyze This Property"}
          </button>
        )}
        {analysis && <button onClick={()=>setOpen(o=>!o)} style={{ background:"transparent", border:"1px solid #374151", color:"#94a3b8", padding:"7px 14px", borderRadius:5, fontSize:12, cursor:"pointer" }}>{open?"▲ Hide":"▼ Show"} Analysis</button>}
      </div>
      {analysis && open && (
        <div style={{ marginTop:14, background:"#080d14", border:"1px solid #1e3a5f", borderRadius:6, padding:"14px 16px" }}>
          <div style={{ color:"#60a5fa", fontSize:11, fontFamily:"monospace", marginBottom:8, letterSpacing:"0.1em" }}>▸ CLAUDE ANALYSIS</div>
          <pre style={{ color:"#cbd5e1", fontSize:13, fontFamily:"monospace", whiteSpace:"pre-wrap", lineHeight:1.75, margin:0 }}>{analysis}</pre>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [mode, setMode] = useState("paste");
  const [text, setText] = useState("");
  const [props, setProps] = useState([]);
  const [analyses, setAnalyses] = useState({});
  const [analyzing, setAnalyzing] = useState({});
  const [processing, setProcessing] = useState(false);
  const [status, setStatus] = useState("");
  const [stats, setStats] = useState(null);
  const [apiKey, setApiKey] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [urlFetching, setUrlFetching] = useState(false);
  const [urlStatus, setUrlStatus] = useState("");

  useEffect(() => {
    const saved = localStorage.getItem("pt_api_key");
    if (saved) setApiKey(saved);
  }, []);

  const saveKey = () => {
    const k = keyInput.trim();
    if (!k) return;
    localStorage.setItem("pt_api_key", k);
    setApiKey(k);
    setKeyInput("");
    setShowKeyInput(false);
  };

  const clearKey = () => {
    localStorage.removeItem("pt_api_key");
    setApiKey("");
    setShowKeyInput(false);
  };

  const runTriage = useCallback((list) => {
    const results = list.map(p => ({ prop:p, triage:triageProperty(p) }));
    setProps(results);
    const pass=results.filter(r=>r.triage.verdict==="PASS").length;
    const review=results.filter(r=>r.triage.verdict==="REVIEW").length;
    const fail=results.filter(r=>r.triage.verdict==="FAIL").length;
    setStats({ total:results.length, pass, review, fail });
    setStatus(`Triage complete — ${pass} pass · ${review} review · ${fail} fail`);
  }, []);

  const handleRun = async () => {
    const trimmed = text.trim();
    // If the user pasted just a URL, redirect to the URL tab
    if (/^https?:\/\/\S+$/.test(trimmed)) {
      setUrlInput(trimmed);
      setText("");
      setMode("url");
      setStatus("");
      setUrlStatus("URL detected — click \"Fetch & Triage\" to load this listing.");
      return;
    }
    setProcessing(true);

    // Try Claude parsing first if API key is available
    if (apiKey) {
      setStatus("🤖 Parsing with Claude...");
      try {
        const parsed = await parseListingWithClaude(trimmed, apiKey);
        if (parsed && (parsed.price || parsed.units || parsed.capRate)) {
          runTriage([parsed]);
          setProcessing(false);
          return;
        }
      } catch (e) {
        // Claude failed — fall through to regex
        console.warn("Claude parse failed:", e.message);
      }
    }

    // Fallback: regex extraction
    setStatus("Parsing...");
    setTimeout(() => {
      const list = parsePastedListings(trimmed);
      if (!list.length) {
        setStatus(apiKey
          ? "⚠ Could not extract listing data. Make sure you've pasted the full page text from a listing."
          : "⚠ Could not parse. Set an API Key for smarter parsing, or check format."
        );
        setProcessing(false);
        return;
      }
      runTriage(list); setProcessing(false);
    }, 300);
  };

  const handleFetchUrl = async () => {
    if (!urlInput.trim()) return;
    setUrlFetching(true);
    setUrlStatus("");
    try {
      const res = await fetch(`/api/fetch-listing?url=${encodeURIComponent(urlInput.trim())}`);
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        // Server returned HTML — likely still deployed as static site or server unavailable
        setUrlStatus("URL fetch API is unavailable. Switch to the Paste tab: open the listing page, Ctrl+A → Ctrl+C, paste the full page text, and click Run Triage.");
        setUrlFetching(false);
        return;
      }
      const data = await res.json();
      const prop = data.prop;
      if (prop && (prop.price || prop.units)) {
        runTriage([prop]);
        setUrlStatus("");
      } else {
        // Prefill paste box with whatever we extracted
        const lines = [
          prop?.name || urlInput,
          prop?.price ? `$${prop.price.toLocaleString()}` : "",
          prop?.units ? `${prop.units} units` : "",
          prop?.capRate ? `${(prop.capRate * 100).toFixed(1)}% cap rate` : "",
          prop?.yearBuilt ? `Built ${prop.yearBuilt}` : "",
          prop?.sqft ? `${prop.sqft.toLocaleString()} sf` : "",
          prop?.location || "",
          prop?.description || "",
        ].filter(Boolean);
        setText(lines.join("\n"));
        setMode("paste");
        setUrlStatus(data.message || "Partial data extracted — fill in any missing details, then run triage.");
      }
    } catch (e) {
      setUrlStatus(`Error: ${e.message}`);
    }
    setUrlFetching(false);
  };

  const handleAnalyze = async (prop, triage) => {
    const k = prop.name;
    if (analyses[k] || !apiKey) return;
    setAnalyzing(a=>({...a,[k]:true}));
    try { const r = await analyzeWithClaude(prop, triage, apiKey); setAnalyses(a=>({...a,[k]:r})); }
    catch(e) { setAnalyses(a=>({...a,[k]:`Error: ${e.message}`})); }
    setAnalyzing(a=>({...a,[k]:false}));
  };

  const sorted = [...props].sort((a,b)=>({PASS:0,REVIEW:1,FAIL:2}[a.triage.verdict]-{PASS:0,REVIEW:1,FAIL:2}[b.triage.verdict]));

  return (
    <div style={{ minHeight:"100vh", background:"#070c14", color:"#e2e8f0", fontFamily:"'DM Sans',system-ui,sans-serif", paddingBottom:80 }}>
      <div style={{ background:"linear-gradient(135deg,#0a1628,#0f2040,#0a1628)", borderBottom:"1px solid #1e2d45", padding:"28px 32px 22px" }}>
        <div style={{ maxWidth:960, margin:"0 auto" }}>
          <div style={{ display:"flex", alignItems:"baseline", gap:12, marginBottom:6, flexWrap:"wrap" }}>
            <span style={{ fontFamily:"'DM Serif Display',Georgia,serif", fontSize:28, fontWeight:700, color:"#f1f5f9", letterSpacing:"-0.02em" }}>Property Triage</span>
            <span style={{ fontFamily:"monospace", fontSize:11, color:"#3b82f6", background:"#0d2e6e", padding:"2px 8px", borderRadius:3, letterSpacing:"0.1em" }}>SCREENER v2.0</span>
          </div>
          <p style={{ color:"#475569", fontSize:13 }}>National · 5–20 Units · Under $1M · Min 7.0% Cap · ≤$175K/unit · 25% Down · DSCR ≥1.25x · CoC ≥8%</p>
          <div style={{ marginBottom:14, background:"#0a1a0a", border:"1px solid #14532d", borderRadius:6, padding:"8px 14px", fontSize:11, color:"#4ade80", fontFamily:"monospace" }}>
            v2.0: ① Land/redevelopment plays auto-FAIL · ② Price/unit hard cap $250K · ③ No-rent listings only REVIEW if price/unit ≤$150K
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
            {apiKey ? (
              <>
                <span style={{ fontFamily:"monospace", fontSize:11, color:"#4ade80", background:"#0d2e1a", border:"1px solid #166534", padding:"3px 10px", borderRadius:4 }}>✓ API Key set</span>
                <button onClick={clearKey} style={{ background:"transparent", border:"1px solid #374151", color:"#64748b", padding:"3px 10px", borderRadius:4, fontSize:11, cursor:"pointer" }}>Revoke</button>
              </>
            ) : showKeyInput ? (
              <>
                <input value={keyInput} onChange={e=>setKeyInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&saveKey()}
                  placeholder="sk-ant-..." autoFocus type="password"
                  style={{ background:"#080d14", border:"1px solid #3b82f6", borderRadius:4, color:"#e2e8f0", fontSize:12, fontFamily:"monospace", padding:"4px 10px", width:280, outline:"none" }} />
                <button onClick={saveKey} style={{ background:"#1e40af", border:"none", color:"#fff", padding:"4px 12px", borderRadius:4, fontSize:11, fontWeight:600, cursor:"pointer" }}>Save</button>
                <button onClick={()=>setShowKeyInput(false)} style={{ background:"transparent", border:"1px solid #374151", color:"#64748b", padding:"4px 10px", borderRadius:4, fontSize:11, cursor:"pointer" }}>Cancel</button>
              </>
            ) : (
              <button onClick={()=>setShowKeyInput(true)} style={{ background:"transparent", border:"1px solid #1e3a5f", color:"#3b82f6", padding:"3px 12px", borderRadius:4, fontSize:11, fontWeight:600, cursor:"pointer" }}>+ Set API Key to enable analysis</button>
            )}
          </div>
        </div>
      </div>

      <div style={{ maxWidth:960, margin:"0 auto", padding:"28px 24px 0" }}>
        {stats && (
          <div style={{ display:"flex", gap:10, marginBottom:20, flexWrap:"wrap" }}>
            {[["Screened",stats.total,"#94a3b8"],["Pass",stats.pass,"#4ade80"],["Review",stats.review,"#fbbf24"],["Fail",stats.fail,"#f87171"]].map(([l,v,c])=>(
              <div key={l} style={{ background:"#0f1621", border:"1px solid #1e2d45", borderRadius:6, padding:"12px 16px", flex:1, textAlign:"center", minWidth:80 }}>
                <div style={{ fontSize:26, fontWeight:700, color:c, fontFamily:"monospace" }}>{v}</div>
                <div style={{ fontSize:10, color:"#475569", letterSpacing:"0.08em", marginTop:4 }}>{l.toUpperCase()}</div>
              </div>
            ))}
          </div>
        )}

        <div style={{ background:"#0f1621", border:"1px solid #1e2d45", borderRadius:10, padding:"22px 24px", marginBottom:24 }}>
          <div style={{ display:"flex", gap:8, marginBottom:18, flexWrap:"wrap" }}>
            {[["paste","📋 Paste Listings"],["url","🔗 Listing URL"],["format","📐 Format Guide"],["rules","⚙ Filter Rules v2"]].map(([id,label])=>(
              <button key={id} onClick={()=>{ setMode(id); setUrlStatus(""); }} style={{ background:mode===id?"#1e40af":"transparent", border:`1px solid ${mode===id?"#3b82f6":"#1e2d45"}`, color:mode===id?"#fff":"#64748b", padding:"6px 16px", borderRadius:5, fontSize:12, cursor:"pointer", fontWeight:600 }}>{label}</button>
            ))}
          </div>

          {mode==="url" ? (
            <>
              <div style={{ color:"#64748b", fontSize:12, marginBottom:10, lineHeight:1.6 }}>
                Paste a listing URL from LoopNet, Crexi, Zillow, Realtor.com, or any other source — we'll attempt to fetch property data automatically.
                <br/><span style={{ color:"#374151" }}>Note: some sites block direct access; if so, we'll extract the address and prefill the form for you.</span>
              </div>
              <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                <input value={urlInput} onChange={e=>setUrlInput(e.target.value)}
                  onKeyDown={e=>e.key==="Enter"&&handleFetchUrl()}
                  placeholder="https://www.loopnet.com/Listing/... or crexi.com, zillow.com..."
                  style={{ flex:1, minWidth:200, background:"#080d14", border:"1px solid #1e2d45", borderRadius:6, color:"#cbd5e1", fontSize:12.5, fontFamily:"monospace", padding:"10px 14px", outline:"none" }} />
                <button onClick={handleFetchUrl} disabled={!urlInput.trim()||urlFetching}
                  style={{ background:!urlInput.trim()||urlFetching?"#1e2533":"linear-gradient(135deg,#1e40af,#2563eb)", border:"none", color:"#fff", padding:"10px 22px", borderRadius:6, fontSize:13, fontWeight:600, cursor:!urlInput.trim()||urlFetching?"not-allowed":"pointer", opacity:!urlInput.trim()?0.5:1, whiteSpace:"nowrap" }}>
                  {urlFetching?"⏳ Fetching...":"Fetch & Triage"}
                </button>
              </div>
              {urlStatus && (
                <div style={{ marginTop:10, color:"#fbbf24", fontSize:12, fontFamily:"monospace", background:"#1a1200", border:"1px solid #854d0e", borderRadius:4, padding:"8px 12px" }}>
                  ⚠ {urlStatus}
                </div>
              )}
              {status && !urlStatus && <div style={{ marginTop:8, color:"#64748b", fontSize:12, fontFamily:"monospace" }}>{status}</div>}
            </>
          ) : mode==="paste" ? (
            <>
              <textarea value={text} onChange={e=>setText(e.target.value)}
                placeholder={"Paste listing text from any source:\n\n① LoopNet, Crexi, Zillow, Realtor.com, CoStar, MLS, broker email — open the listing, Ctrl+A → Ctrl+C, paste here.\n   With API key: Claude reads any format automatically.\n   Without API key: works best for structured text.\n\n② Or paste multiple quick-format listings:\n\n8-Unit Building — Cleveland, OH\n$640,000 · 8 units · 8.2% cap rate · Built 1962 · 6,400 SF\n\n7-Unit — Birmingham, AL\n$380,000 · 7 units · 9.1% cap"}
                style={{ width:"100%", minHeight:160, background:"#080d14", border:"1px solid #1e2d45", borderRadius:6, color:"#cbd5e1", fontSize:12.5, fontFamily:"monospace", padding:"12px 14px", resize:"vertical", outline:"none", boxSizing:"border-box", lineHeight:1.65 }} />
              <div style={{ display:"flex", gap:10, marginTop:12, alignItems:"center", flexWrap:"wrap" }}>
                <button onClick={handleRun} disabled={!text.trim()||processing}
                  style={{ background:!text.trim()?"#1e2533":"linear-gradient(135deg,#1e40af,#2563eb)", border:"none", color:"#fff", padding:"9px 22px", borderRadius:6, fontSize:13, fontWeight:600, cursor:!text.trim()?"not-allowed":"pointer", opacity:!text.trim()?0.5:1 }}>
                  Run Triage
                </button>
                <button onClick={()=>{ setProcessing(true); setTimeout(()=>{ runTriage(DEMO); setProcessing(false); },400); }}
                  style={{ background:"transparent", border:"1px solid #374151", color:"#94a3b8", padding:"9px 18px", borderRadius:6, fontSize:13, cursor:"pointer" }}>
                  Try Demo (incl. Rocky Creek)
                </button>
                {status && <span style={{ color:"#64748b", fontSize:12, fontFamily:"monospace" }}>{status}</span>}
              </div>
            </>
          ) : mode==="format" ? (
            <div style={{ background:"#080d14", border:"1px solid #1e2d45", borderRadius:6, padding:"14px 16px", color:"#94a3b8", fontSize:12, fontFamily:"monospace", lineHeight:1.85 }}>
              <div style={{ color:"#60a5fa", marginBottom:8, fontWeight:600 }}>▸ ONE BLOCK PER PROPERTY:</div>
              {`8-Unit Building — Memphis, TN     ← name line (triggers new property)\n$540,000 asking                  ← price with $\n8 units                          ← unit count\n7.8% cap rate                    ← cap with %\nBuilt 1961                       ← year built\n4,800 sf                         ← square feet\nMemphis, TN 38104                ← city, ST ZIP\nAny description / notes...       ← scanned for land-play keywords`}
            </div>
          ) : (
            <div style={{ color:"#94a3b8", fontSize:12, lineHeight:2, fontFamily:"monospace" }}>
              <div style={{ color:"#60a5fa", marginBottom:10, fontWeight:600 }}>▸ TRIAGE RULES v2.0 — ALL MUST PASS FOR GREEN</div>
              {[
                ["✗ HARD FAIL","Asking price > $1,000,000"],
                ["✗ HARD FAIL","Units outside 5–20 range"],
                ["✗ HARD FAIL","Price/unit > $250,000 (land premium detected)"],
                ["✗ HARD FAIL","Redevelopment/land keywords + no rent data disclosed"],
                ["✗ HARD FAIL","No cap rate or rent data + price/unit > $150,000"],
                ["✗ HARD FAIL","Stated cap rate < 7.0%"],
                ["✗ HARD FAIL","Est. DSCR < 1.25x (25% dn, 7.25%, 25yr)"],
                ["✗ HARD FAIL","Est. CoC < 8.0%"],
                ["⚠ FLAG ONLY","Price/unit $175K–$250K — verify income justifies premium"],
                ["⚠ FLAG ONLY","Redevelopment language present even with cap rate stated"],
                ["⚠ REVIEW","No cap rate + price/unit ≤ $150K (possible value-add worth a call)"],
              ].map(([tag,rule],i)=>(
                <div key={i} style={{ display:"flex", gap:12, paddingBottom:2 }}>
                  <span style={{ color:tag.includes("HARD")?"#f87171":"#fbbf24", minWidth:120 }}>{tag}</span>
                  <span style={{ color:"#64748b" }}>{rule}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {sorted.length > 0 && (
          <div>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14 }}>
              <span style={{ fontFamily:"'DM Serif Display',Georgia,serif", fontSize:20, color:"#e2e8f0" }}>Triage Results</span>
              <span style={{ color:"#475569", fontSize:12 }}>— sorted by verdict</span>
            </div>
            {sorted.map(({prop,triage})=>(
              <Card key={prop.name} prop={prop} triage={triage} onAnalyze={handleAnalyze} analysis={analyses[prop.name]} analyzing={!!analyzing[prop.name]} hasKey={!!apiKey} />
            ))}
          </div>
        )}

        {!props.length && (
          <div style={{ background:"#0f1621", border:"1px solid #1e2d45", borderRadius:10, padding:"28px 32px" }}>
            <div style={{ fontFamily:"'DM Serif Display',Georgia,serif", fontSize:18, color:"#93c5fd", marginBottom:16 }}>How to Use</div>
            <div style={{ color:"#64748b", fontSize:13, lineHeight:2 }}>
              <strong style={{ color:"#94a3b8" }}>Step 1</strong> — Browse any listing site (LoopNet, Crexi, Zillow, Realtor.com, MLS, broker emails).<br/>
              <strong style={{ color:"#94a3b8" }}>Step 2</strong> — On the listing page, press <strong style={{ color:"#e2e8f0" }}>Ctrl+A</strong> to select all, then <strong style={{ color:"#e2e8f0" }}>Ctrl+C</strong> to copy. Paste it into the <strong style={{ color:"#e2e8f0" }}>Paste Listings</strong> tab and click <strong style={{ color:"#e2e8f0" }}>Run Triage</strong> — Claude extracts the data automatically.<br/>
              <span style={{ color:"#475569", fontSize:12 }}>⚠ Note: The URL tab attempts to fetch listing data directly, but most sites (LoopNet, Zillow, Crexi, Realtor.com) actively block automated access. The Ctrl+A → Ctrl+C paste method is the most reliable approach.</span><br/>
              <strong style={{ color:"#94a3b8" }}>Step 3</strong> — Every property scores instantly: PASS / REVIEW / FAIL.<br/>
              <strong style={{ color:"#94a3b8" }}>Step 4</strong> — Click Analyze on any PASS or REVIEW for a Claude deal brief.<br/>
              <strong style={{ color:"#94a3b8" }}>Step 5</strong> — Send survivors for a full underwriting model.<br/>
              <br/><span style={{ color:"#374151", fontSize:12 }}>→ Click "Try Demo (incl. Rocky Creek)" — Tampa waterfront now correctly auto-FAILs as a land play.</span>
            </div>
          </div>
        )}

        <div style={{ marginTop:48, borderTop:"1px solid #1e2d45", paddingTop:20, color:"#374151", fontSize:11, fontFamily:"monospace", display:"flex", justifyContent:"space-between", flexWrap:"wrap", gap:8 }}>
          <span>Property Triage Screener v2.0</span>
          <span>25% dn · 7.25% · 25yr · 45% expense ratio · $250K/unit hard cap · land-play detector</span>
        </div>
      </div>
    </div>
  );
}
