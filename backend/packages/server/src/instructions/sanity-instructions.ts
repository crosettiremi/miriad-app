import { instructions } from './content/instructions.js';
/**
 * Sanity Instructions Client
 *
 * Fetches instruction articles from Sanity for the read_instructions MCP tool.
 * Caches instructions with a configurable TTL to avoid excessive API calls.
 */

const SANITY_PROJECT_ID = process.env.SANITY_PROJECT_ID || 'z6gp2g0b';
const SANITY_DATASET = process.env.SANITY_DATASET || 'production';
const SANITY_API_VERSION = '2024-01-01';

// Cache TTL in milliseconds (5 minutes)
const CACHE_TTL = 5 * 60 * 1000;

export interface Instruction {
  id: string;
  summary: string;
  content: string;
}

interface SanityInstruction {
  _id: string;
  slug: { current: string };
  summary: string;
  content: string;
}

// Module-level cache
let instructionCache: Map<string, Instruction> = new Map();
let cacheTimestamp = 0;

/**
 * GROQ query for fetching all instructions.
 */
const INSTRUCTIONS_QUERY = `*[_type == "instruction"]{
  _id,
  slug,
  summary,
  content
}`;

/**
 * Fetch instructions from Sanity API.
 */
async function fetchFromSanity(): Promise<SanityInstruction[]> {
  const url = new URL(
    `https://${SANITY_PROJECT_ID}.api.sanity.io/v${SANITY_API_VERSION}/data/query/${SANITY_DATASET}`
  );
  url.searchParams.set('query', INSTRUCTIONS_QUERY);

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`Sanity query failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { result: SanityInstruction[] };
  return data.result;
}

/**
 * Transform Sanity documents to Instruction format.
 */
function transformInstructions(docs: SanityInstruction[]): Map<string, Instruction> {
  const map = new Map<string, Instruction>();
  for (const doc of docs) {
    map.set(doc.slug.current, {
      id: doc.slug.current,
      summary: doc.summary,
      content: doc.content,
    });
  }
  return map;
}

/**
 * Check if cache is still valid.
 */
function isCacheValid(): boolean {
  return Date.now() - cacheTimestamp < CACHE_TTL && instructionCache.size > 0;
}

/**
 * Get all instructions, using cache if available.
 * Refreshes cache in background if expired.
 */
export async function getInstructions(): Promise<Map<string, Instruction>> {
  if (process.env.CONTENT_SOURCE === 'bundled') return new Map(instructions.map(i => [i.slug,{id:i.slug,summary:i.summary,content:i.content}]));
  if (isCacheValid()) {
    return instructionCache;
  }

  try {
    const docs = await fetchFromSanity();
    instructionCache = transformInstructions(docs);
    cacheTimestamp = Date.now();
    console.log(
      `[Instructions] Loaded ${instructionCache.size} instruction articles from Sanity:`,
      Array.from(instructionCache.keys()).join(', ')
    );
  } catch (error) {
    console.error('[Instructions] Failed to fetch from Sanity:', error);
    // If we have stale cache, return it rather than failing
    if (instructionCache.size > 0) {
      console.log('[Instructions] Using stale cache');
      return instructionCache;
    }
    // Return empty map if no cache available
    return new Map();
  }

  return instructionCache;
}

/**
 * Get a single instruction by ID.
 */
export async function getInstruction(id: string): Promise<Instruction | undefined> {
  const instructions = await getInstructions();
  return instructions.get(id);
}

/**
 * Force refresh the cache.
 */
export async function refreshInstructions(): Promise<Map<string, Instruction>> {
  cacheTimestamp = 0; // Invalidate cache
  return getInstructions();
}

/**
 * Build the description for read_instructions tool.
 * This fetches instructions to build the list dynamically.
 */
export async function buildReadInstructionsDescription(): Promise<string> {
  const instructions = await getInstructions();
  const articleList = Array.from(instructions.values())
    .map((i) => `- ${i.id}: ${i.summary}`)
    .join('\n');

  return `Read documentation for special artifact types and capabilities.

Available articles:
${articleList || '(no instructions available)'}`;
}
