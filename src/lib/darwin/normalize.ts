/**
 * Darwin raw response → PingMarket shared types.
 *
 * Honesty rules: ids/revisions are copied verbatim, `requiredSetup: null` means unknown,
 * a match is a capability (not inventory/quote), and `searchToken` never leaves this layer.
 */
import type {
  DarwinCapabilityResult,
  DarwinConnectionMethod,
  DarwinReadiness,
  DarwinSearchOutcome,
} from "../types";
import { DARWIN_INDEX_BASE, DarwinError, type DarwinRawAgent, type DarwinRawSearchResponse } from "./client";

const READINESS_VALUES: readonly DarwinReadiness[] = [
  "ready",
  "authentication_required",
  "recheck_required",
  "unavailable",
];

const MAX_TEXT_ITEMS = 10;

function textItems(items: unknown[]): string[] {
  return items.filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, MAX_TEXT_ITEMS);
}

export function normalizeDarwinAgent(agent: DarwinRawAgent): DarwinCapabilityResult {
  const uncertainties = textItems(agent.uncertainties);

  let readiness: DarwinReadiness;
  if (agent.readiness && (READINESS_VALUES as readonly string[]).includes(agent.readiness)) {
    readiness = agent.readiness as DarwinReadiness;
  } else {
    readiness = "recheck_required";
    uncertainties.push(`Readiness value '${agent.readiness ?? "missing"}' not recognized`);
  }

  const connectionMethods: DarwinConnectionMethod[] = agent.connectionMethods.map((m) => ({
    protocol: m.protocol ?? "unknown",
    environment: m.environment ?? null,
    endpointUrl: m.endpointUrl ?? null,
    endpointStatus: m.endpointStatus ?? null,
    documentationUrl: m.documentationUrl ?? null,
  }));

  return {
    type: "darwin_capability",
    agentId: agent.agentId,
    agentSlug: agent.agentSlug ?? null,
    capabilityId: agent.capabilityId,
    capabilityRevision: agent.capabilityRevision ?? null,
    rank: agent.rank,
    name: agent.name ?? "(unnamed capability)",
    description: agent.description ?? null,
    readiness,
    canStartThread: agent.canStartThread,
    canAttemptThread: agent.canAttemptThread,
    providerCheck: agent.providerCheck ?? null,
    reasons: textItems(agent.reasons),
    uncertainties,
    requiredSetup: agent.requiredSetup
      ? {
          kind: agent.requiredSetup.kind ?? "unknown",
          suppliedBy: agent.requiredSetup.suppliedBy ?? null,
          description: agent.requiredSetup.description ?? null,
        }
      : null,
    connectionMethods,
    connectionPrompt: agent.connectionPrompt ?? null,
    agentPageUrl: `${DARWIN_INDEX_BASE}/agent/${encodeURIComponent(agent.agentId)}?capability=${encodeURIComponent(agent.capabilityId)}`,
  };
}

export function normalizeDarwinResponse(
  raw: DarwinRawSearchResponse,
  latencyMs: number,
): { outcome: DarwinSearchOutcome; capabilities: DarwinCapabilityResult[] } {
  const r = raw.response;
  const capabilities = r.agents.map(normalizeDarwinAgent).sort((a, b) => a.rank - b.rank);

  const outcome: DarwinSearchOutcome = {
    status: "completed",
    searchId: raw.searchId ?? null,
    responseId: raw.responseId ?? null,
    question: r.question ?? null,
    noMatchReason: r.noMatchReason ?? null,
    overview: r.overview ?? null,
    assessment: r.assessment
      ? { outcome: r.assessment.outcome, explanation: r.assessment.explanation ?? "" }
      : null,
    error: null,
    latencyMs,
  };

  switch (raw.status) {
    case "completed":
      // Never present an empty list as a successful match.
      if (capabilities.length === 0) {
        outcome.status = "no_match";
        outcome.noMatchReason ??= "Darwin completed the search but returned no agent capabilities.";
      }
      break;
    case "needs_input":
    case "no_match":
      outcome.status = raw.status;
      break;
    default:
      outcome.status = "error";
      outcome.error = `Darwin Search returned an unrecognized status '${raw.status}'.`;
  }

  return { outcome, capabilities };
}

function errorMessage(err: unknown): string {
  if (!(err instanceof DarwinError)) return "Darwin Search failed unexpectedly.";
  switch (err.code) {
    case "RATE_LIMITED":
      return "Darwin Search is rate-limited right now (HTTP 429). Try again shortly.";
    case "TIMEOUT":
      return "Darwin Search timed out.";
    case "NETWORK":
      return "Could not reach Darwin Search.";
    case "INVALID_RESPONSE":
      return "Darwin Search returned a response PingMarket could not read.";
    case "HTTP_ERROR":
      return err.status ? `Darwin Search returned HTTP ${err.status}.` : "Darwin Search returned an error.";
  }
}

export function darwinErrorOutcome(err: unknown, latencyMs: number | null): DarwinSearchOutcome {
  return {
    status: "error",
    searchId: null,
    responseId: null,
    question: null,
    noMatchReason: null,
    overview: null,
    assessment: null,
    error: errorMessage(err),
    latencyMs,
  };
}

export const DARWIN_SKIPPED_OUTCOME: DarwinSearchOutcome = Object.freeze({
  status: "skipped",
  searchId: null,
  responseId: null,
  question: null,
  noMatchReason: null,
  overview: null,
  assessment: null,
  error: null,
  latencyMs: null,
}) as DarwinSearchOutcome;
