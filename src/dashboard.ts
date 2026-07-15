import { assess } from "./governor.js";
import { evaluateGuardrails, readGuardrailRecords } from "./guardrails.js";
import type { GovernorSettings, Ledger } from "./ledger.js";
import { computeRunway } from "./runway.js";
import { aggregateUsage } from "./telemetry.js";

export interface DashboardStats {
  generatedAt: string;
  level: "green" | "yellow" | "red";
  burnPerMin: number;
  windows: {
    name: string;
    usedTokens: number;
    budgetTokens: number;
    pct: number;
    calibrated: boolean;
    exhaustsInMin: number | null;
  }[];
  runway: { window: string; runwayMin: number | null; gainedMin: number | null; savedTokens: number } | null;
  savings: {
    calls: number;
    tokensSaved: number;
    compressionSavedTokens: number;
    shapingSavedTokens: number;
    droppedContextTokens: number;
    cacheHitRate: number;
    costUSD: number;
    costComplete: boolean;
  };
  guardrails: {
    enabled: boolean;
    shapingDisabled: boolean;
    shapingReason: string | null;
    downgradeDisabled: boolean;
    downgradeReason: string | null;
  };
}

/** Assembles everything the dashboard (and any monitor) needs, in one JSON payload. */
export function buildStats(ledger: Ledger, settings: GovernorSettings): DashboardStats {
  const eff = ledger.effectiveSettings(settings);
  const now = Date.now();
  const a = assess(ledger.forecasts(eff, now), eff);
  const calibration = ledger.calibration(settings, now);
  const report = aggregateUsage(ledger.logPath, { pricing: settings.pricing });

  let runway: DashboardStats["runway"] = null;
  if (a.worst) {
    const windowMs = a.worst.window.hours * 3_600_000;
    const s = aggregateUsage(ledger.logPath, { sinceMs: now - windowMs });
    const savedInWindow = s.compressionSavedTokens + s.shapingSavedTokens + s.droppedContextTokens;
    const rw = computeRunway(a.worst, savedInWindow);
    runway = { window: rw.window, runwayMin: rw.runwayMin, gainedMin: rw.gainedMin, savedTokens: rw.savedTokens };
  }

  const guardrails = { enabled: settings.guardrails.enabled, shapingDisabled: false, shapingReason: null as string | null, downgradeDisabled: false, downgradeReason: null as string | null };
  if (settings.guardrails.enabled) {
    const recs = readGuardrailRecords(ledger.logPath, now - settings.guardrails.lookbackHours * 3_600_000);
    const v = evaluateGuardrails(recs, settings.guardrails);
    guardrails.shapingDisabled = v.shaping.disabled;
    guardrails.shapingReason = v.shaping.reason;
    guardrails.downgradeDisabled = v.downgrade.disabled;
    guardrails.downgradeReason = v.downgrade.reason;
  }

  return {
    generatedAt: new Date(now).toISOString(),
    level: a.level,
    burnPerMin: a.worst?.burnPerMin ?? 0,
    windows: a.forecasts.map((f) => ({
      name: f.window.name,
      usedTokens: f.usedTokens,
      budgetTokens: f.window.budgetTokens,
      pct: f.pct,
      calibrated: !settings.windowsExplicit && calibration[f.window.name] != null,
      exhaustsInMin: f.exhaustsAt ? Math.max(0, (f.exhaustsAt - now) / 60_000) : null,
    })),
    runway,
    savings: {
      calls: report.calls,
      tokensSaved: report.compressionSavedTokens + report.shapingSavedTokens + report.droppedContextTokens,
      compressionSavedTokens: report.compressionSavedTokens,
      shapingSavedTokens: report.shapingSavedTokens,
      droppedContextTokens: report.droppedContextTokens,
      cacheHitRate: report.cacheHitRate,
      costUSD: report.costUSD,
      costComplete: report.costComplete,
    },
    guardrails,
  };
}

/** The dashboard: one self-contained page — no framework, no build step, no deps. */
export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>limitbreak</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b0d10; color: #e6e8eb; font: 15px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 15px; letter-spacing: .04em; color: #7a828c; font-weight: 600; margin: 0 0 24px; text-transform: uppercase; }
  .hero { border: 1px solid #1c2027; border-radius: 14px; padding: 28px; margin-bottom: 20px; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; vertical-align: middle; }
  .green { background: #3fb950; } .yellow { background: #d29922; } .red { background: #f85149; }
  .level { font-size: 13px; letter-spacing: .08em; text-transform: uppercase; color: #9aa4af; }
  .runway { font-size: 46px; font-weight: 700; margin: 6px 0 2px; }
  .sub { color: #7a828c; font-size: 14px; }
  .gain { color: #3fb950; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .card { border: 1px solid #1c2027; border-radius: 12px; padding: 16px 18px; }
  .card h2 { font-size: 12px; letter-spacing: .06em; text-transform: uppercase; color: #7a828c; margin: 0 0 12px; font-weight: 600; }
  .row { display: flex; justify-content: space-between; margin: 6px 0; }
  .row .k { color: #9aa4af; } .row .v { font-variant-numeric: tabular-nums; }
  .barwrap { margin: 10px 0; }
  .barlabel { display: flex; justify-content: space-between; font-size: 13px; color: #9aa4af; margin-bottom: 4px; }
  .bar { height: 8px; background: #161a20; border-radius: 6px; overflow: hidden; }
  .bar > span { display: block; height: 100%; border-radius: 6px; }
  .warn { border-color: #5a2b2b; background: #1a1113; }
  .warn h2 { color: #f0a3a0; }
  .muted { color: #55606b; }
  .foot { margin-top: 20px; color: #55606b; font-size: 12px; }
  .full { grid-column: 1 / -1; }
</style>
</head>
<body>
<div class="wrap">
  <h1>limitbreak · never hit the wall</h1>
  <div class="hero">
    <div class="level"><span id="dot" class="dot"></span><span id="level">—</span></div>
    <div class="runway" id="runway">—</div>
    <div class="sub" id="gain"></div>
  </div>
  <div class="grid">
    <div class="card full">
      <h2>quota windows</h2>
      <div id="windows"></div>
    </div>
    <div class="card">
      <h2>burn</h2>
      <div class="row"><span class="k">rate</span><span class="v" id="burn">—</span></div>
      <div class="row"><span class="k">calls</span><span class="v" id="calls">—</span></div>
      <div class="row"><span class="k">cache hit</span><span class="v" id="cache">—</span></div>
    </div>
    <div class="card">
      <h2>saved</h2>
      <div class="row"><span class="k">total</span><span class="v gain" id="saved">—</span></div>
      <div class="row"><span class="k">compression</span><span class="v" id="comp">—</span></div>
      <div class="row"><span class="k">est. cost</span><span class="v" id="cost">—</span></div>
    </div>
    <div class="card warn full" id="guardcard" style="display:none">
      <h2>auto-revert active</h2>
      <div id="guards"></div>
    </div>
  </div>
  <div class="foot" id="foot">connecting…</div>
</div>
<script>
const fmt = n => Math.round(n).toLocaleString();
function dur(min) {
  if (min == null) return "idle";
  if (min < 1) return "<1 min";
  const m = Math.round(min);
  if (m < 60) return m + " min";
  const h = Math.floor(m/60), r = m%60;
  if (h < 24) return r ? h+"h "+r+"m" : h+"h";
  const d = Math.floor(h/24), rh = h%24;
  return rh ? d+"d "+rh+"h" : d+"d";
}
async function tick() {
  let s;
  try { s = await (await fetch("/stats")).json(); }
  catch { document.getElementById("foot").textContent = "daemon unreachable"; return; }
  document.getElementById("dot").className = "dot " + s.level;
  document.getElementById("level").textContent = s.level.toUpperCase();
  const rw = s.runway;
  document.getElementById("runway").textContent = rw ? "≈ " + dur(rw.runwayMin) + " of runway" : "no burn yet";
  document.getElementById("gain").innerHTML = (rw && rw.gainedMin >= 1)
    ? '<span class="gain">+' + dur(rw.gainedMin) + '</span> bought by limitbreak (saved ' + fmt(rw.savedTokens) + ' tok this window)'
    : '<span class="muted">before your "' + (rw ? rw.window : "—") + '" limit at current burn</span>';
  document.getElementById("windows").innerHTML = s.windows.map(w => {
    const pct = Math.min(100, w.pct*100);
    const col = w.pct >= 0.9 ? "#f85149" : w.pct >= 0.7 ? "#d29922" : "#3fb950";
    return '<div class="barwrap"><div class="barlabel"><span>' + w.name +
      (w.calibrated ? ' <span class="muted">(calibrated)</span>' : '') + '</span><span>' +
      (w.pct*100).toFixed(1) + '% · ' + fmt(w.usedTokens) + '/' + fmt(w.budgetTokens) + '</span></div>' +
      '<div class="bar"><span style="width:' + pct + '%;background:' + col + '"></span></div></div>';
  }).join("");
  document.getElementById("burn").textContent = fmt(s.burnPerMin) + " tok/min";
  document.getElementById("calls").textContent = fmt(s.savings.calls);
  document.getElementById("cache").textContent = (s.savings.cacheHitRate*100).toFixed(1) + "%";
  document.getElementById("saved").textContent = fmt(s.savings.tokensSaved) + " tok";
  document.getElementById("comp").textContent = fmt(s.savings.compressionSavedTokens) + " tok";
  document.getElementById("cost").textContent = s.savings.costComplete ? "$" + s.savings.costUSD.toFixed(4) : "n/a";
  const g = s.guardrails, gs = [];
  if (g.shapingDisabled) gs.push("shaping OFF — " + g.shapingReason);
  if (g.downgradeDisabled) gs.push("downgrade OFF — " + g.downgradeReason);
  document.getElementById("guardcard").style.display = gs.length ? "" : "none";
  document.getElementById("guards").innerHTML = gs.map(x => '<div class="row"><span class="v">⚠ ' + x + '</span></div>').join("");
  document.getElementById("foot").textContent = "updated " + new Date(s.generatedAt).toLocaleTimeString();
}
tick(); setInterval(tick, 3000);
</script>
</body>
</html>`;
}
