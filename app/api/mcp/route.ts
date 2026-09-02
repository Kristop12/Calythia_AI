import { NextResponse } from "next/server";
import {
  MCP_SETUP_HINT,
  buildMcpIntegrations,
  filterMcpIntegrationsForQuery,
  loadMcpServerLabels,
  lmStudioOrigin,
  mcpEnabled,
  resolveChatModel,
} from "@/lib/lmstudio";
import { describeToolRouting } from "@/lib/mcpRoute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Debug helper: MCP servers + optional ?q= preview of tool routing. */
export async function GET(request: Request) {
  const labels = await loadMcpServerLabels();
  const integrations = await buildMcpIntegrations();
  const q = new URL(request.url).searchParams.get("q")?.trim() || "";
  const routed = q ? filterMcpIntegrationsForQuery(q, integrations) : null;
  const routing = q ? describeToolRouting(q) : null;

  return NextResponse.json({
    enabled: mcpEnabled(),
    origin: lmStudioOrigin(),
    servers: labels,
    integrations,
    model: await resolveChatModel().catch(() => null),
    apiTokenConfigured: (() => {
      const t = process.env.LM_STUDIO_API_TOKEN?.trim() || "";
      return t.length > 12 && t !== "lm-studio";
    })(),
    sampleQuery: q || null,
    routing,
    routedIntegrations: routed,
    hint: q
      ? "Preview of tools for this query. Omit ?q= to only list configured servers."
      : labels.length === 0
        ? "No MCP servers found. Add them in LM Studio (~/.lmstudio/mcp.json) or set LM_STUDIO_MCP_SERVERS."
        : `${MCP_SETUP_HINT} Try /api/mcp?q=list%20files%20in%20Downloads`,
  });
}
