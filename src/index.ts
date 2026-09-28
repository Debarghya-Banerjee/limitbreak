import { anthropicAdapter } from "./adapters/anthropic.js";
import { geminiAdapter } from "./adapters/gemini.js";
import { openaiAdapter } from "./adapters/openai.js";
import { packContext } from "./context.js";
import { DEFAULT_PRICING, estimateCostUSD, resolveModel, resolveTier } from "./router.js";
import { recordUsage } from "./telemetry.js";
import type {
  Adapter,
  CompletionRequest,
  CompletionResult,
  LimitbreakConfig,
  ProviderConfig,
} from "./types.js";

export * from "./types.js";
export { packContext, estimateTokens } from "./context.js";
export { aggregateUsage, parseDuration } from "./telemetry.js";
export { createMcpHandler, runMcpStdio } from "./mcp.js";
export { Ledger, loadSettings, configDir, DEFAULT_SETTINGS } from "./ledger.js";
export type { GovernorSettings, QuotaWindow, WindowForecast, LimitEvent } from "./ledger.js";
export { calibrateBudgets, effectiveWindows } from "./calibrate.js";
export type { CalibratedBudget } from "./calibrate.js";
export { assess, shape, TERSE_STEER } from "./governor.js";
export type { Assessment, HeadroomLevel, ShapeResult } from "./governor.js";
export { computeRunway, formatDuration } from "./runway.js";
export type { RunwayInfo } from "./runway.js";
export { evaluateGuardrails, readGuardrailRecords, DEFAULT_GUARDRAILS } from "./guardrails.js";
export type { GuardrailConfig, GuardrailVerdict, GuardrailRecord, PolicyVerdict } from "./guardrails.js";
export { createProxy, extractUsage } from "./proxy.js";
export { buildStats, dashboardHtml } from "./dashboard.js";
export type { DashboardStats } from "./dashboard.js";
export { compress, compressToolResults, compressJson, compressLog, headTail, mapToolResults, compressionBudget } from "./compress.js";
export type { Intensity, CompressOutcome } from "./compress.js";
export { builtinBackend, externalBackend, makeCompressionBackend } from "./backends.js";
export type { CompressionBackend, ExternalBackendConfig, CompressionBackendSetting, CompressOpts } from "./backends.js";
export { Store } from "./store.js";
export { Memory, formatEntry, MEMORY_TEXT_LIMIT } from "./memory.js";
export type { MemoryEntry } from "./memory.js";
export {
  Team,
  buildTeamReport,
  formatLease,
  formatPlan,
  leasePressure,
  leaseSteer,
  DEFAULT_ROLES,
  DEFAULT_TEAM,
} from "./team.js";
export type {
  Complexity,
  Lease,
  LeaseOutcome,
  LeasePressure,
  LeaseState,
  PriorityClass,
  RoleEstimate,
  RoleReport,
  RoleSpec,
  RosterEntry,
  StaffingPlan,
  StaffingRequest,
  TeamConfig,
  TeamReport,
} from "./team.js";

const ADAPTERS: Record<string, Adapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  gemini: geminiAdapter,
};

const TERSE =
  "Answer directly with no preamble, no restating of the question, and no closing summary. Be complete but minimal.";

export class Limitbreak {
  private pricing: Record<string, [number, number]>;

  constructor(private config: LimitbreakConfig) {
    if (Object.keys(config.providers).length === 0) {
      throw new Error("Limitbreak: configure at least one provider.");
    }
    this.pricing = { ...DEFAULT_PRICING, ...config.pricing };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const providerName =
      req.provider ??
      this.config.defaultProvider ??
      Object.keys(this.config.providers)[0]!;
    const cfg = this.config.providers[providerName];
    if (!cfg) {
      throw new Error(`Limitbreak: provider "${providerName}" is not configured.`);
    }

    let tier = resolveTier(req.tier, req.task);
    let pressured = false;
    // Only downgrade task-routed tiers — an explicit tier/model is a caller
    // decision the governor must not override.
    if (this.config.governor && !req.tier && !req.model) {
      const level = await this.headroomLevel();
      if (level === "yellow" && tier === "max") {
        tier = "balanced";
        pressured = true;
      } else if (level === "red" && tier !== "fast") {
        tier = "fast";
        pressured = true;
      }
    }
    const model = req.model ?? resolveModel(providerName, cfg, tier);
    const adapter = this.resolveAdapter(providerName, cfg);

    const packed = packContext(
      req.context ?? [],
      this.config.budget?.maxInputTokens,
    );

    // Stable prefix (cache-eligible): system instructions + pinned context,
    // identical bytes across calls. Volatile content stays in the user turn.
    const systemParts = [req.system, packed.pinned];
    if (req.terse !== false && !req.schema) systemParts.push(TERSE);
    const system = systemParts.filter(Boolean).join("\n\n") || "You are a helpful assistant.";
    const user = [packed.volatile, req.prompt].filter(Boolean).join("\n\n");

    const maxOutputTokens =
      req.maxOutputTokens ?? this.config.budget?.maxOutputTokens ?? 1024;

    const res = await adapter(
      {
        model,
        system,
        user,
        schema: req.schema,
        maxOutputTokens,
        temperature: req.temperature,
        stop: req.stop,
      },
      cfg,
    );

    const costUSD = estimateCostUSD(
      model,
      res.usage.inputTokens,
      res.usage.outputTokens,
      res.usage.cacheReadTokens,
      this.pricing,
    );

    if (this.config.telemetry !== false) {
      recordUsage(this.config.telemetry ?? ".limitbreak/usage.jsonl", {
        ts: new Date().toISOString(),
        provider: providerName,
        model,
        tag: req.tag,
        costUSD,
        droppedContextTokens: packed.droppedTokens,
        surface: "sdk",
        ...(pressured && { shaped: true }),
        ...res.usage,
      });
    }

    return {
      text: res.text,
      json: res.json,
      model,
      provider: providerName,
      usage: res.usage,
      costUSD,
      droppedContextTokens: packed.droppedTokens,
    };
  }

  private async headroomLevel(): Promise<"green" | "yellow" | "red"> {
    try {
      const res = await fetch(`${this.config.governor!.url.replace(/\/$/, "")}/status`, {
        signal: AbortSignal.timeout(500),
      });
      const data = (await res.json()) as { level?: string };
      if (data.level === "yellow" || data.level === "red") return data.level;
    } catch {
      // Governor unreachable — fail open, never block the call.
    }
    return "green";
  }

  private resolveAdapter(name: string, cfg: ProviderConfig): Adapter {
    const protocol = cfg.protocol ?? name;
    const adapter = ADAPTERS[protocol];
    if (!adapter) {
      throw new Error(
        `Limitbreak: unknown protocol "${protocol}" for provider "${name}". ` +
          `Set providers.${name}.protocol to "anthropic", "openai", or "gemini".`,
      );
    }
    return adapter;
  }
}
