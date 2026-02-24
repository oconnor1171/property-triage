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
};

function triageProperty(prop) {
  const flags = [], passes = [];
  let score = 0;
  if (prop.price > CRITERIA.maxPrice) { flags.push(`Price $${(prop.price/1000).toFixed(0)}K exceeds $1M limit`); }
  else { passes.push(`Price $${(prop.price/1000).toFixed(0)}K ✓`); score += 20; }
  if (prop.units < CRITERIA.minUnits || prop.units > CRITERIA.maxUnits) { flags.push(`${prop.units} units outside 5–20 range`); }
  else { passes.push(`${prop.units} units ✓`); score += 15; }
  let capRateStatus = "missing";
  if (prop.capRate !== null) {
    if (prop.capRate >= CRITERIA.minCapRate) { passes.push(`Cap rate ${(prop.capRate*100).toFixed(1)}% ≥ 7.0% ✓`); score += 30; capRateStatus = "pass"; }
    else { flags.push(`Cap rate ${(prop.capRate*100).toFixed(1)}% below 7.0% threshold`); capRateStatus = "fail"; }
  } else { flags.push("Cap rate not stated — manual review required"); score += 5; }
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
  const hardFails = flags.filter(f => !f.includes("manual review")).length;
  const verdict = hardFails === 0 && score >= 65 ? "PASS" : capRateStatus === "missing" && hardFails <= 1 && score >= 35 ? "REVIEW" : "FAIL";
  return { flags, passes, score, verdict, dscr, coc };
}

function parsePastedListings(raw) {
  try {
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
    return properties.filter(p => p.price || p.units);
  } catch { return []; }
}

async function analyzeWithClaude(prop, triage, apiKey) {
  const prompt = `You are a commercial real estate underwriter. Analyze this multifamily listing for an investor: national market, 5–20 units, under $1M, min 7% cap rate, 25% down, min DSCR 1.25x, min CoC 8%.

PROPERTY: ${prop.name}
Price: $${prop.price?.toLocaleString() ?? "Unknown"} | Units: ${prop.units ?? "?"} | Cap: ${prop.capRate ? (prop.capRate*100).toFixed(1)+"%" : "Not stated"}
Built: ${prop.yearBuilt ?? "?"} | SF: ${prop.sqft ?? "?"} | Location: ${prop.location ?? "?"}
Description: ${prop.description?.trim() ?? "None"}
Triage: ${triage.verdict} | Est. DSCR: ${triage.dscr?.toFixed(2)??"N/A"} | Est. CoC: ${triage.coc?(triage.coc*100).toFixed(1)+"%":"N/A"}
Flags: ${triage.flags.join("; ")||"None"}

Provide a 4-part brief:
1. DEAL THESIS (2 sentences — bull case)
2. RED FLAGS (2–4 bullets)
3. KEY UNKNOWNS (missing data that matters)
4. VERDICT: "Strong candidate for full underwrite" OR "Conditional — verify [X] first" OR "Pass — [reason]"

Be direct. Assume sophisticated buyer.`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, messages: [{ role: "user", content: prompt }] })
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  const data = await res.json();
  return data.content?.map(b => b.text).join("") ?? "Unavailable.";
}

const DEMO = [
  { name: "8-Unit Brick Apartment — Cleveland, OH", price: 640000, units: 8, capRate: 0.082, yearBuilt: "1962", sqft: 6400, location: "Cleveland, OH 44105", description: "Fully occupied. New roof 2021." },
  { name: "12-Unit Mixed-Use — Raleigh, NC", price: 895000, units: 10, capRate: 0.071, yearBuilt: "1978", sqft: 9200, location: "Raleigh, NC 27601", description: "2 commercial storefronts + 10 residential. Below-market rents." },
  { name: "6-Unit Garden Apartment — Memphis, TN", price: 425000, units: 6, capRate: null, yearBuilt: "1955", sqft: 4800, location: "Memphis, TN 38104", description: "Rents below market. Owner retiring." },
  { name: "15-Unit Complex — Phoenix, AZ", price: 1250000, units: 15, capRate: 0.055, yearBuilt: "1989", sqft: 12000, location: "Phoenix, AZ 85003", description: "Class B. Strong occupancy." },
  { name: "7-Unit Multifamily — Birmingham, AL", price: 380000, units: 7, capRate: 0.091, yearBuilt: "1968", sqft: 5600, location: "Birmingham, AL 35203", description: "Below market rents. Owner carry available." },
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
  const borderColor = triage.verdict==="PASS"?"#166534":triage.verdict==="REVIEW"?"#854d0e":"#1f2937";
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
        {prop.capRate!==null ? <Pill label="Cap" value={`${(prop.capRate*100).toFixed(1)}%`} good={prop.capRate>=CRITERIA.minCapRate} /> : <Pill label="Cap" value="N/S" good={null} />}
        {triage.dscr!==null && <Pill label="Est.DSCR" value={`${triage.dscr.toFixed(2)}x`} good={triage.dscr>=CRITERIA.minDSCR} />}
        {triage.coc!==null && <Pill label="Est.CoC" value={`${(triage.coc*100).toFixed(1)}%`} good={triage.coc>=CRITERIA.minCoC} />}
        {prop.yearBuilt && <Pill label="Built" value={prop.yearBuilt} good={null} />}
      </div>
      <div style={{ display:"flex", gap:20, marginBottom:12, fontSize:12 }}>
        <div>{triage.passes.map((p,i)=><div key={i} style={{ color:"#4ade80", lineHeight:1.7 }}>✓ {p}</div>)}</div>
        <div>{triage.flags.map((f,i)=><div key={i} style={{ color:f.includes("manual")?"#fbbf24":"#f87171", lineHeight:1.7 }}>{f.includes("manual")?"⚠":"✗"} {f}</div>)}</div>
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

  const handleRun = () => {
    setProcessing(true); setStatus("Parsing...");
    setTimeout(() => {
      const list = parsePastedListings(text);
      if (!list.length) { setStatus("⚠ Could not parse. Try demo or check format."); setProcessing(false); return; }
      runTriage(list); setProcessing(false);
    }, 300);
  };

  const handleFetchUrl = async () => {
    if (!urlInput.trim()) return;
    setUrlFetching(true);
    setUrlStatus("");
    try {
      const res = await fetch(`/api/fetch-listing?url=${encodeURIComponent(urlInput.trim())}`);
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
            <span style={{ fontFamily:"monospace", fontSize:11, color:"#3b82f6", background:"#0d2e6e", padding:"2px 8px", borderRadius:3, letterSpacing:"0.1em" }}>SCREENER v1.0</span>
          </div>
          <p style={{ color:"#475569", fontSize:13 }}>National · 5–20 Units · Under $1M · Min 7.0% Cap · 25% Down · DSCR ≥1.25x · CoC ≥8%</p>
          <div style={{ marginTop:14, display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
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
            {[["paste","📋 Paste Listings"],["url","🔗 LoopNet URL"],["format","📐 Format Guide"]].map(([id,label])=>(
              <button key={id} onClick={()=>{ setMode(id); setUrlStatus(""); }} style={{ background:mode===id?"#1e40af":"transparent", border:`1px solid ${mode===id?"#3b82f6":"#1e2d45"}`, color:mode===id?"#fff":"#64748b", padding:"6px 16px", borderRadius:5, fontSize:12, cursor:"pointer", fontWeight:600 }}>{label}</button>
            ))}
          </div>

          {mode==="url" ? (
            <>
              <div style={{ color:"#64748b", fontSize:12, marginBottom:10, lineHeight:1.6 }}>
                Paste a LoopNet listing URL — we'll fetch the property data automatically and run triage.
                <br/><span style={{ color:"#374151" }}>Note: LoopNet may block access; if so, we'll extract the address and prefill the form for you.</span>
              </div>
              <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                <input value={urlInput} onChange={e=>setUrlInput(e.target.value)}
                  onKeyDown={e=>e.key==="Enter"&&handleFetchUrl()}
                  placeholder="https://www.loopnet.com/Listing/..."
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
                placeholder={"Paste listing data here — one property per block.\n\nExample:\n8-Unit Building — Cleveland, OH\n$640,000 asking\n8 units\n8.2% cap rate\nBuilt 1962\n6,400 SF"}
                style={{ width:"100%", minHeight:160, background:"#080d14", border:"1px solid #1e2d45", borderRadius:6, color:"#cbd5e1", fontSize:12.5, fontFamily:"monospace", padding:"12px 14px", resize:"vertical", outline:"none", boxSizing:"border-box", lineHeight:1.65 }} />
              <div style={{ display:"flex", gap:10, marginTop:12, alignItems:"center", flexWrap:"wrap" }}>
                <button onClick={handleRun} disabled={!text.trim()||processing}
                  style={{ background:!text.trim()?"#1e2533":"linear-gradient(135deg,#1e40af,#2563eb)", border:"none", color:"#fff", padding:"9px 22px", borderRadius:6, fontSize:13, fontWeight:600, cursor:!text.trim()?"not-allowed":"pointer", opacity:!text.trim()?0.5:1 }}>
                  Run Triage
                </button>
                <button onClick={()=>{ setProcessing(true); setTimeout(()=>{ runTriage(DEMO); setProcessing(false); },400); }}
                  style={{ background:"transparent", border:"1px solid #374151", color:"#94a3b8", padding:"9px 18px", borderRadius:6, fontSize:13, cursor:"pointer" }}>
                  Try Demo
                </button>
                {status && <span style={{ color:"#64748b", fontSize:12, fontFamily:"monospace" }}>{status}</span>}
              </div>
            </>
          ) : (
            <div style={{ background:"#080d14", border:"1px solid #1e2d45", borderRadius:6, padding:"14px 16px", color:"#94a3b8", fontSize:12, fontFamily:"monospace", lineHeight:1.85 }}>
              <div style={{ color:"#60a5fa", marginBottom:8, fontWeight:600 }}>▸ ONE BLOCK PER PROPERTY:</div>
              {`8-Unit Building — Memphis, TN     ← name line\n$540,000 asking                  ← price with $\n8 units                          ← unit count\n7.8% cap rate                    ← cap with %\nBuilt 1961                       ← year built\n4,800 sf                         ← square feet\nMemphis, TN 38104                ← city, ST\nAny description notes...`}
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
              <strong style={{ color:"#94a3b8" }}>Step 1</strong> — Browse LoopNet or Crexi. Copy listing details into the paste box.<br/>
              <strong style={{ color:"#94a3b8" }}>Step 2</strong> — Run Triage. Every property scores instantly: PASS / REVIEW / FAIL.<br/>
              <strong style={{ color:"#94a3b8" }}>Step 3</strong> — Click Analyze on any PASS or REVIEW for a Claude deal brief.<br/>
              <strong style={{ color:"#94a3b8" }}>Step 4</strong> — Send survivors for a full 11-sheet underwriting model.<br/>
              <br/><span style={{ color:"#374151", fontSize:12 }}>→ Click "Try Demo" to see 5 sample properties triaged now.</span>
            </div>
          </div>
        )}

        <div style={{ marginTop:48, borderTop:"1px solid #1e2d45", paddingTop:20, color:"#374151", fontSize:11, fontFamily:"monospace", display:"flex", justifyContent:"space-between", flexWrap:"wrap", gap:8 }}>
          <span>Property Triage Screener v1.0</span>
          <span>25% down · 7.25% rate · 25yr term · 45% expense ratio</span>
        </div>
      </div>
    </div>
  );
}
