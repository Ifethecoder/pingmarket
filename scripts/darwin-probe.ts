/**
 * Live Darwin Search probe.
 * Usage: npx tsx scripts/darwin-probe.ts "<query>"
 */
import { runDarwinDiscovery } from "../src/lib/darwin/search";

const DEFAULT_QUERY = "MCP tool to audit a website for WCAG accessibility issues";

async function main() {
  const query = process.argv.slice(2).join(" ").trim() || DEFAULT_QUERY;
  console.log(`query:    ${query}`);

  const { outcome, capabilities } = await runDarwinDiscovery(query);

  console.log(`status:   ${outcome.status}`);
  console.log(`latency:  ${outcome.latencyMs}ms`);
  if (outcome.searchId) console.log(`searchId: ${outcome.searchId}`);
  if (outcome.assessment) console.log(`assessment: ${outcome.assessment.outcome} — ${outcome.assessment.explanation}`);
  if (outcome.question) console.log(`question: ${outcome.question}`);
  if (outcome.noMatchReason) console.log(`noMatchReason: ${outcome.noMatchReason}`);
  if (outcome.error) console.log(`error:    ${outcome.error}`);

  if (capabilities.length > 0) {
    console.table(
      capabilities.map((c) => ({
        rank: c.rank,
        name: c.name.length > 50 ? `${c.name.slice(0, 47)}...` : c.name,
        readiness: c.readiness,
        agentId: c.agentId,
        capabilityId: c.capabilityId,
      })),
    );
  }

  if (outcome.status === "error") process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
