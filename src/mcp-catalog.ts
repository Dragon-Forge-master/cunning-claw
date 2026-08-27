/**
 * Known hosted MCP endpoints. This is a directory Chris can browse, not
 * discovery from the web — every URL is a vendor's published Streamable HTTP
 * address, the same ones Claude Code's `claude mcp add --transport http` uses.
 */
import type { ClaudeMcpEntry } from "./mcp-config.js";

export type CatalogueEntry = {
  id: string;
  label: string;
  blurb: string;
  category: string;
  popular: boolean;
  entry: ClaudeMcpEntry;
};

export const MCP_CATALOGUE: CatalogueEntry[] = [
  {
    id: "canva",
    label: "Canva",
    blurb: "Designs, exports, brand kit",
    category: "Create",
    popular: true,
    entry: { type: "http", url: "https://mcp.canva.com/mcp" },
  },
  {
    id: "github",
    label: "GitHub",
    blurb: "Repos, issues, pull requests",
    category: "Code",
    popular: true,
    entry: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
  },
  {
    id: "notion",
    label: "Notion",
    blurb: "Pages, databases, search",
    category: "Docs",
    popular: true,
    entry: { type: "http", url: "https://mcp.notion.com/mcp" },
  },
  {
    id: "figma",
    label: "Figma",
    blurb: "Files, components, comments",
    category: "Create",
    popular: true,
    entry: { type: "http", url: "https://mcp.figma.com/mcp" },
  },
  {
    id: "linear",
    label: "Linear",
    blurb: "Issues and projects",
    category: "Work",
    popular: false,
    entry: { type: "http", url: "https://mcp.linear.app/mcp" },
  },
];

export function catalogueById(id: string): CatalogueEntry | undefined {
  return MCP_CATALOGUE.find((c) => c.id === id);
}
