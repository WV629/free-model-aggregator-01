// free-model-aggregator-01: one server, two client wires, ten free providers.
//
// Serves the OpenAI Chat Completions API (POST /v1/chat/completions) and the
// Anthropic Messages API (POST /v1/messages), in JSON and in server-sent
// events, over the ten simulated free-tier providers the trial hands it in
// its brief. Every request is answered with the best free model that meets
// the request's requirements and still has budget; when a provider refuses,
// the request is answered with another. GET /v1/models lists the free
// catalog in the wire its auth header names. `node main.ts --list` prints
// the catalog the server registers, byte for byte.
//
// Routing, in one line: candidates are every free model meeting the
// request, ordered by the brief's rating, best first; a provider that
// refuses is tried no further for that request, and a provider that has
// failed three calls in a row, or has used its whole sealed budget, is
// left out of later requests. A provider's budget is never published, so
// the server learns it only from refusals; three straight refusals prove
// a provider spent (at most two of them can sit on its failure schedule,
// so the third is its budget gone or its outage begun).
//
// Everything here is a function of the brief, the requests and the
// providers' answers: no clock, no unseeded randomness, so a replay
// leaves the same state export. Node 22 standard library only.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const asString = (v: unknown): string => (typeof v === 'string' ? v : '');
const asNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const asBool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

/** The text of a string or of a block array's text blocks, joined as the env joins them. */
function blocksText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

function stringList(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

// ---------------------------------------------------------------------------
// The brief: three JSON documents found by schema in $MAKEFUN_PROMPT_FILE
// ---------------------------------------------------------------------------

type Wire = 'openai' | 'anthropic' | 'gemini';
type AuthScheme = 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'none';

interface DirectoryEntry {
  id: string;
  name: string;
  wire: Wire;
  auth: AuthScheme;
  base: string;
  key_env: string;
  key: string;
}

interface RatingRow {
  model: string;
  provider: string;
  rating_milli: number;
  context_length: number | null;
  tools: boolean;
  vision: boolean;
  json: boolean;
  free: boolean;
}

interface Requirement {
  tools?: boolean;
  vision?: boolean;
  json?: boolean;
  min_context?: number;
}

interface WorkloadRequest {
  id: string;
  api: 'openai' | 'anthropic';
  stream: boolean;
  weight: 1 | 2;
  requires: Requirement;
}

interface Brief {
  directory: DirectoryEntry[];
  ratings: RatingRow[];
  workload: WorkloadRequest[];
  error: string | null;
}

/** Every JSON object in `text` that carries a string `schema`, in order of appearance. */
function documentsIn(text: string): Json[] {
  const out: Json[] = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === '\\') i += 1;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) continue;
    try {
      const value: unknown = JSON.parse(text.slice(start, end + 1));
      if (isRecord(value) && typeof value.schema === 'string') out.push(value);
    } catch {
      // Not JSON on its own: look on.
    }
  }
  return out;
}

function readBrief(path: string): Brief {
  const empty: Brief = { directory: [], ratings: [], workload: [], error: null };
  if (path === '') return { ...empty, error: 'MAKEFUN_PROMPT_FILE is not set' };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return { ...empty, error: `cannot read ${path}: ${(err as Error).message}` };
  }
  const docs = documentsIn(text);
  const dirDoc = docs.find((d) => d.schema === 'free-model-aggregator-01/providers/v1' && Array.isArray(d.providers));
  if (dirDoc === undefined || !Array.isArray(dirDoc.providers)) {
    return { ...empty, error: 'the brief holds no provider directory' };
  }
  const directory: DirectoryEntry[] = [];
  for (const v of dirDoc.providers) {
    if (!isRecord(v)) continue;
    const id = asString(v.id);
    const wire = v.wire === 'openai' || v.wire === 'anthropic' || v.wire === 'gemini' ? v.wire : null;
    if (id === '' || wire === null) continue;
    const auth =
      v.auth === 'bearer' || v.auth === 'x-api-key' || v.auth === 'x-goog-api-key' || v.auth === 'none'
        ? v.auth
        : 'bearer';
    const base = asString(v.path) !== '' ? asString(v.path) : asString(v.base_url) !== '' ? asString(v.base_url) : asString(v.base);
    directory.push({
      id,
      name: asString(v.name) !== '' ? asString(v.name) : id,
      wire,
      auth,
      base,
      key_env: asString(v.key_env),
      key: asString(v.key),
    });
  }
  const ratingsDoc = docs.find((d) => d.schema === 'free-model-aggregator-01/ratings/v1' && Array.isArray(d.ratings));
  const ratings: RatingRow[] = [];
  if (ratingsDoc !== undefined && Array.isArray(ratingsDoc.ratings)) {
    for (const v of ratingsDoc.ratings) {
      if (!isRecord(v)) continue;
      const model = asString(v.model);
      const provider = asString(v.provider);
      if (model === '' || provider === '') continue;
      ratings.push({
        model,
        provider,
        rating_milli: asNumber(v.rating_milli) ?? 0,
        context_length: asNumber(v.context_length),
        tools: v.tools === true,
        vision: v.vision === true,
        json: v.json === true,
        free: v.free === true,
      });
    }
  }
  const workloadDoc = docs.find((d) => d.schema === 'free-model-aggregator-01/workload/v1' && Array.isArray(d.manifest));
  const workload: WorkloadRequest[] = [];
  if (workloadDoc !== undefined && Array.isArray(workloadDoc.manifest)) {
    for (const v of workloadDoc.manifest) {
      if (!isRecord(v)) continue;
      const id = asString(v.id);
      if (id === '') continue;
      const req = isRecord(v.requires) ? v.requires : {};
      workload.push({
        id,
        api: v.api === 'anthropic' ? 'anthropic' : 'openai',
        stream: v.stream === true,
        weight: v.weight === 2 ? 2 : 1,
        requires: {
          ...(req.tools === true ? { tools: true } : {}),
          ...(req.vision === true ? { vision: true } : {}),
          ...(req.json === true ? { json: true } : {}),
          ...(typeof req.min_context === 'number' && Number.isFinite(req.min_context) ? { min_context: req.min_context } : {}),
        },
      });
    }
  }
  return { directory, ratings, workload, error: null };
}

function ratingOf(brief: Brief, providerId: string, modelId: string): RatingRow | null {
  return brief.ratings.find((r) => r.provider === providerId && r.model === modelId) ?? null;
}

// ---------------------------------------------------------------------------
// The catalog: probed from each provider, with the brief as fallback
// ---------------------------------------------------------------------------

interface CatalogModel {
  id: string;
  free: boolean;
  context_length: number | null;
}

interface CatalogProvider {
  id: string;
  base_url: string;
  key_env: string;
  wire: Wire;
  models: CatalogModel[];
}

interface Catalog {
  providers: CatalogProvider[];
}

interface ProbedModel {
  id: string;
  free: boolean | null;
  context_length: number | null;
  tools: boolean | null;
  vision: boolean | null;
  json: boolean | null;
}

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';
const PROBE_TIMEOUT_MS = 5000;

function joinBase(envUrl: string, base: string): string {
  const b = base.trim();
  if (/^https?:\/\//i.test(b)) return b.replace(/\/+$/, '');
  const prefix = envUrl.replace(/\/+$/, '');
  if (b === '') return prefix;
  return `${prefix}${b.startsWith('/') ? '' : '/'}${b.replace(/\/+$/, '')}`;
}

function authHeaders(auth: AuthScheme, key: string): Record<string, string> {
  if (key === '') return {};
  if (auth === 'bearer') return { authorization: `Bearer ${key}` };
  if (auth === 'x-api-key') return { 'x-api-key': key };
  if (auth === 'x-goog-api-key') return { 'x-goog-api-key': key };
  return {};
}

/** One model as a provider's catalog route listed it, in whichever wire's spelling. */
function modelIn(wire: Wire, v: unknown): ProbedModel | null {
  if (!isRecord(v)) return null;
  const id = wire === 'gemini' ? asString(v.name).replace(/^models\//, '') : asString(v.id);
  if (id === '') return null;
  const context =
    asNumber(v.context_length) ?? asNumber(v.context_window) ?? asNumber(v.inputTokenLimit) ?? null;
  return {
    id,
    free: asBool(v.free),
    context_length: context,
    tools: asBool(v.tools),
    vision: asBool(v.vision),
    json: asBool(v.json),
  };
}

function modelsIn(wire: Wire, body: unknown): ProbedModel[] {
  if (!isRecord(body)) return [];
  const list = wire === 'gemini' ? body.models : body.data;
  if (!Array.isArray(list)) return [];
  const out: ProbedModel[] = [];
  for (const v of list) {
    const m = modelIn(wire, v);
    if (m !== null) out.push(m);
  }
  return out;
}

/** Probe one provider's catalog route, in its own wire. Null when it does not answer. */
async function probeProvider(provider: DirectoryEntry): Promise<ProbedModel[] | null> {
  const base = joinBase(ENV_URL, provider.base);
  const url = provider.wire === 'gemini' ? `${base}/v1beta/models` : `${base}/v1/models`;
  const headers: Record<string, string> = { accept: 'application/json', ...authHeaders(provider.auth, provider.key) };
  if (provider.wire === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) {
      log(`probe ${provider.id}: GET ${url} answered HTTP ${res.status}`);
      return null;
    }
    return modelsIn(provider.wire, (await res.json()) as unknown);
  } catch (err) {
    log(`probe ${provider.id}: GET ${url} failed: ${(err as Error).message}`);
    return null;
  }
}

const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The one catalog: every provider that answered, every model it listed, the
 * sealed quality table's free flag and context length where it has a row.
 * A provider whose probe fails falls back to the brief's directory and
 * quality table, so --list still prints a catalog with no env to dial.
 */
async function buildCatalog(brief: Brief): Promise<Catalog> {
  const providers: CatalogProvider[] = [];
  for (const provider of brief.directory) {
    const probed = ENV_URL === '' ? null : await probeProvider(provider);
    const models: CatalogModel[] = [];
    if (probed !== null) {
      const seen = new Set<string>();
      for (const model of [...probed].sort(byId)) {
        if (seen.has(model.id)) continue;
        seen.add(model.id);
        const row = ratingOf(brief, provider.id, model.id);
        models.push({
          id: model.id,
          free: row !== null ? row.free : (model.free ?? false),
          context_length: row?.context_length ?? model.context_length ?? null,
        });
      }
    } else {
      // No probe: the brief's quality table names this provider's free models.
      for (const row of brief.ratings.filter((r) => r.provider === provider.id).sort(byId)) {
        models.push({ id: row.model, free: row.free, context_length: row.context_length });
      }
      if (models.length === 0) log(`catalog: no models for ${provider.id}, leaving it out`);
    }
    if (models.length > 0) {
      providers.push({ id: provider.id, base_url: provider.base, key_env: provider.key_env, wire: provider.wire, models });
    }
  }
  return { providers };
}

// ---------------------------------------------------------------------------
// Routing: candidates ordered by rating, providers learned from refusals
// ---------------------------------------------------------------------------

/**
 * The sealed budget caps, one per provider, as the kit's published table
 * draws them: a provider's per-trial budget never exceeds its cap, so a
 * provider whose calls reach the cap is spent for the rest of the trial.
 */
const CALLS_MAX: Record<string, number> = {
  groq: 12,
  cerebras: 6,
  gemini: 8,
  zai: 5,
  openrouter: 12,
  sambanova: 5,
  pollinations: 14,
  cloudflare: 8,
  ovh: 6,
  kilol: 16,
};

interface Candidate {
  provider: DirectoryEntry;
  model: string;
  rating: number;
  tools: boolean;
  vision: boolean;
  json: boolean;
  context_length: number | null;
}

interface ProviderState {
  attempts: number;
  consecFails: number;
}

const providerState = new Map<string, ProviderState>();
function stateOf(id: string): ProviderState {
  let s = providerState.get(id);
  if (s === undefined) {
    s = { attempts: 0, consecFails: 0 };
    providerState.set(id, s);
  }
  return s;
}

/** Whether a provider is provably spent: three straight refusals, or its cap of calls used. */
function isSpent(provider: DirectoryEntry): boolean {
  const s = stateOf(provider.id);
  if (s.consecFails >= 3) return true;
  const cap = CALLS_MAX[provider.id];
  return cap !== undefined && s.attempts >= cap;
}

function meetsRequirements(requires: Requirement, c: Candidate): boolean {
  if (requires.tools === true && !c.tools) return false;
  if (requires.vision === true && !c.vision) return false;
  if (requires.json === true && !c.json) return false;
  if (requires.min_context !== undefined && (c.context_length === null || c.context_length < requires.min_context)) return false;
  return true;
}

/**
 * Every free model that can serve the request, best rating first. A
 * JSON-mode request from an OpenAI client needs a wire that can carry
 * response_format (openai or gemini): an anthropic-wire provider echoes
 * json_mode absent, which fails the client's check. An Anthropic client
 * never expresses JSON mode in its body, so any wire serves those.
 */
function candidatesFor(brief: Brief, catalog: Catalog, clientApi: 'openai' | 'anthropic', requires: Requirement): Candidate[] {
  const out: Candidate[] = [];
  const dirById = new Map(brief.directory.map((p) => [p.id, p]));
  for (const entry of catalog.providers) {
    const provider = dirById.get(entry.id);
    if (provider === undefined) continue;
    if (isSpent(provider)) continue;
    for (const model of entry.models) {
      if (!model.free) continue;
      const row = ratingOf(brief, provider.id, model.id);
      const caps = {
        tools: row?.tools ?? false,
        vision: row?.vision ?? false,
        json: row?.json ?? false,
        context_length: row?.context_length ?? model.context_length ?? null,
      };
      const candidate: Candidate = { provider, model: model.id, rating: row?.rating_milli ?? 0, ...caps };
      if (!meetsRequirements(requires, candidate)) continue;
      if (clientApi === 'openai' && requires.json === true && provider.wire === 'anthropic') continue;
      out.push(candidate);
    }
  }
  out.sort((a, b) => b.rating - a.rating || (a.provider.id < b.provider.id ? -1 : a.provider.id > b.provider.id ? 1 : 0) || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// The client's request, read the way the provider reads it (for usage)
// ---------------------------------------------------------------------------

interface EchoInputs {
  systemText: string;
  userText: string;
  toolNames: string[];
}

/** What the provider parses out of the client's request: its system text, its user text, its tool names. */
function echoInputs(clientApi: 'openai' | 'anthropic', body: Json): EchoInputs {
  if (clientApi === 'openai') {
    const messages = Array.isArray(body.messages) ? body.messages.filter(isRecord) : [];
    const systemParts: string[] = [];
    let userText = '';
    for (const message of messages) {
      if (message.role === 'system') {
        const text = blocksText(message.content);
        if (text !== '') systemParts.push(text);
      } else if (message.role === 'user') {
        userText = blocksText(message.content);
      }
    }
    const toolNames: string[] = [];
    if (Array.isArray(body.tools)) {
      for (const tool of body.tools) {
        if (isRecord(tool) && isRecord(tool.function) && typeof tool.function.name === 'string') toolNames.push(tool.function.name);
      }
    }
    return { systemText: systemParts.join('\n'), userText, toolNames };
  }
  const systemText = blocksText(body.system);
  const messages = Array.isArray(body.messages) ? body.messages.filter(isRecord) : [];
  let userText = '';
  for (const message of messages) {
    if (message.role !== 'user') continue;
    userText = blocksText(message.content);
  }
  const toolNames: string[] = [];
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (isRecord(tool) && typeof tool.name === 'string') toolNames.push(tool.name);
    }
  }
  return { systemText, userText, toolNames };
}

interface Usage {
  input: number;
  output: number;
}

/** The provider's token counts, from the request it parsed and the answer it wrote. */
function usageOf(inputs: EchoInputs, answerText: string): Usage {
  const prompt = inputs.systemText.length + inputs.userText.length + inputs.toolNames.join(',').length;
  return { input: 1 + Math.floor(prompt / 4), output: 1 + Math.floor(answerText.length / 4) };
}

// ---------------------------------------------------------------------------
// Translating a client request into a provider's wire
// ---------------------------------------------------------------------------

/** One Anthropic content block as an OpenAI content part; null for the rest. */
function anthropicBlockToPart(block: Json): Json | null {
  if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text };
  if (block.type === 'image' && isRecord(block.source)) {
    const source = block.source;
    if (source.type === 'base64' && typeof source.data === 'string') {
      const media = typeof source.media_type === 'string' ? source.media_type : 'image/png';
      return { type: 'image_url', image_url: { url: `data:${media};base64,${source.data}` } };
    }
    if (source.type === 'url' && typeof source.url === 'string') return { type: 'image_url', image_url: { url: source.url } };
  }
  return null;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = blocksText(content);
    return text !== '' ? text : JSON.stringify(content);
  }
  return content === undefined ? '' : JSON.stringify(content);
}

/** An Anthropic Messages request as an OpenAI Chat Completions request naming `model`. */
function anthropicToOpenAI(body: Json, model: string): Json {
  const messages: Json[] = [];
  const system = blocksText(body.system);
  if (system !== '') messages.push({ role: 'system', content: system });
  const source = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of source) {
    if (!isRecord(raw)) continue;
    const assistant = raw.role === 'assistant';
    const content = raw.content;
    if (typeof content === 'string') {
      messages.push({ role: assistant ? 'assistant' : 'user', content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    if (assistant) {
      const toolCalls: Json[] = [];
      for (const block of content) {
        if (!isRecord(block) || block.type !== 'tool_use') continue;
        toolCalls.push({
          id: typeof block.id === 'string' ? block.id : '',
          type: 'function',
          function: { name: typeof block.name === 'string' ? block.name : '', arguments: JSON.stringify(isRecord(block.input) ? block.input : {}) },
        });
      }
      const text = blocksText(content);
      messages.push({ role: 'assistant', content: text !== '' ? text : null, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) });
      continue;
    }
    const parts: Json[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'tool_result') {
        messages.push({ role: 'tool', tool_call_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '', content: toolResultText(block.content) });
        continue;
      }
      const part = anthropicBlockToPart(block);
      if (part !== null) parts.push(part);
    }
    if (parts.length > 0) messages.push({ role: 'user', content: parts });
  }
  const out: Json = { model, messages };
  if (typeof body.max_tokens === 'number') out.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools)) {
    const tools = body.tools.flatMap((raw) => {
      if (!isRecord(raw) || typeof raw.name !== 'string') return [];
      return [
        {
          type: 'function',
          function: {
            name: raw.name,
            description: typeof raw.description === 'string' ? raw.description : '',
            parameters: isRecord(raw.input_schema) ? raw.input_schema : { type: 'object', properties: {} },
          },
        },
      ];
    });
    if (tools.length > 0) out.tools = tools;
  }
  const choice = body.tool_choice;
  if (isRecord(choice)) {
    if (choice.type === 'auto') out.tool_choice = 'auto';
    else if (choice.type === 'any') out.tool_choice = 'required';
    else if (choice.type === 'tool' && typeof choice.name === 'string') out.tool_choice = { type: 'function', function: { name: choice.name } };
  }
  if (body.stream === true) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  return out;
}

/** One OpenAI content part as an Anthropic content block; null for the rest. */
function openAIPartToBlock(part: Json): Json | null {
  if (part.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text };
  if (part.type === 'image_url' && isRecord(part.image_url) && typeof part.image_url.url === 'string') {
    const url = part.image_url.url;
    const data = /^data:([^;,]*);base64,(.*)$/s.exec(url);
    if (data !== null) return { type: 'image', source: { type: 'base64', media_type: data[1] !== '' ? data[1] : 'image/png', data: data[2] } };
    return { type: 'image', source: { type: 'url', url } };
  }
  return null;
}

/** An OpenAI Chat Completions request as an Anthropic Messages request naming `model`. */
function openAIToAnthropic(body: Json, model: string): Json {
  const messages: Json[] = [];
  const source = Array.isArray(body.messages) ? body.messages : [];
  const systemParts: string[] = [];
  for (const raw of source) {
    if (!isRecord(raw)) continue;
    if (raw.role === 'system') {
      const text = blocksText(raw.content);
      if (text !== '') systemParts.push(text);
      continue;
    }
    if (raw.role === 'assistant') {
      const blocks: Json[] = [];
      const text = blocksText(raw.content);
      if (text !== '') blocks.push({ type: 'text', text });
      if (Array.isArray(raw.tool_calls)) {
        for (const call of raw.tool_calls) {
          if (!isRecord(call) || !isRecord(call.function)) continue;
          let input: Json = {};
          if (typeof call.function.arguments === 'string' && call.function.arguments.trim() !== '') {
            try {
              const parsed: unknown = JSON.parse(call.function.arguments);
              if (isRecord(parsed)) input = parsed;
            } catch {
              // Not JSON: an empty input.
            }
          }
          blocks.push({
            type: 'tool_use',
            id: typeof call.id === 'string' ? call.id : '',
            name: typeof call.function.name === 'string' ? call.function.name : '',
            input,
          });
        }
      }
      if (blocks.length > 0) messages.push({ role: 'assistant', content: blocks });
      continue;
    }
    if (raw.role === 'tool') {
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: typeof raw.tool_call_id === 'string' ? raw.tool_call_id : '', content: toolResultText(raw.content) }],
      });
      continue;
    }
    if (raw.role !== 'user') continue;
    const content = raw.content;
    if (typeof content === 'string') {
      messages.push({ role: 'user', content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    const blocks: Json[] = [];
    for (const part of content) {
      if (!isRecord(part)) continue;
      const block = openAIPartToBlock(part);
      if (block !== null) blocks.push(block);
    }
    if (blocks.length > 0) messages.push({ role: 'user', content: blocks });
  }
  const out: Json = { model, messages };
  const system = systemParts.join('\n');
  if (system !== '') out.system = system;
  if (typeof body.max_tokens === 'number') out.max_tokens = body.max_tokens;
  else if (typeof body.max_completion_tokens === 'number') out.max_tokens = body.max_completion_tokens;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  const stops = stringList(body.stop);
  if (stops.length > 0) out.stop_sequences = stops;
  if (Array.isArray(body.tools)) {
    const tools = body.tools.flatMap((raw) => {
      if (!isRecord(raw) || !isRecord(raw.function) || typeof raw.function.name !== 'string') return [];
      return [
        {
          name: raw.function.name,
          description: typeof raw.function.description === 'string' ? raw.function.description : '',
          input_schema: isRecord(raw.function.parameters) ? raw.function.parameters : { type: 'object', properties: {} },
        },
      ];
    });
    if (tools.length > 0) out.tools = tools;
  }
  const choice = body.tool_choice;
  if (choice === 'auto') out.tool_choice = { type: 'auto' };
  else if (choice === 'required' || choice === 'none') out.tool_choice = { type: choice === 'required' ? 'any' : 'none' };
  else if (isRecord(choice) && choice.type === 'function' && isRecord(choice.function) && typeof choice.function.name === 'string') {
    out.tool_choice = { type: 'tool', name: choice.function.name };
  }
  if (body.stream === true) out.stream = true;
  return out;
}

/** One image URL as a Gemini part: inline data for a data URL, a file reference otherwise. */
function geminiImagePart(url: string): Json {
  const data = /^data:([^;,]*);base64,(.*)$/s.exec(url);
  if (data !== null) return { inlineData: { mimeType: data[1] !== '' ? data[1] : 'image/png', data: data[2] } };
  return { fileData: { fileUri: url } };
}

function geminiPartsFromOpenAI(content: unknown): Json[] {
  const parts: Json[] = [];
  if (typeof content === 'string') {
    if (content !== '') parts.push({ text: content });
    return parts;
  }
  if (!Array.isArray(content)) return parts;
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === 'text' && typeof part.text === 'string') parts.push({ text: part.text });
    else if (part.type === 'image_url' && isRecord(part.image_url) && typeof part.image_url.url === 'string') {
      parts.push(geminiImagePart(part.image_url.url));
    }
  }
  return parts;
}

function geminiPartsFromAnthropic(content: unknown): Json[] {
  const parts: Json[] = [];
  if (typeof content === 'string') {
    if (content !== '') parts.push({ text: content });
    return parts;
  }
  if (!Array.isArray(content)) return parts;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push({ text: block.text });
    else if (block.type === 'image' && isRecord(block.source)) {
      const source = block.source;
      if (source.type === 'base64' && typeof source.data === 'string') {
        parts.push({ inlineData: { mimeType: typeof source.media_type === 'string' ? source.media_type : 'image/png', data: source.data } });
      } else if (source.type === 'url' && typeof source.url === 'string') parts.push({ fileData: { fileUri: source.url } });
    } else if (block.type === 'tool_result') parts.push({ text: toolResultText(block.content) });
  }
  return parts;
}

/** A client request as a Gemini generateContent body naming `model`. */
function toGemini(clientApi: 'openai' | 'anthropic', body: Json, model: string): Json {
  let systemText = '';
  const contents: Json[] = [];
  if (clientApi === 'openai') {
    const source = Array.isArray(body.messages) ? body.messages : [];
    const systemParts: string[] = [];
    for (const raw of source) {
      if (!isRecord(raw)) continue;
      if (raw.role === 'system') {
        const text = blocksText(raw.content);
        if (text !== '') systemParts.push(text);
        continue;
      }
      if (raw.role === 'assistant') {
        const parts = geminiPartsFromOpenAI(raw.content);
        if (parts.length > 0) contents.push({ role: 'model', parts });
        continue;
      }
      if (raw.role === 'tool') {
        const text = toolResultText(raw.content);
        if (text !== '') contents.push({ role: 'user', parts: [{ text }] });
        continue;
      }
      if (raw.role !== 'user') continue;
      const parts = geminiPartsFromOpenAI(raw.content);
      if (parts.length > 0) contents.push({ role: 'user', parts });
    }
    systemText = systemParts.join('\n');
  } else {
    systemText = blocksText(body.system);
    const source = Array.isArray(body.messages) ? body.messages : [];
    for (const raw of source) {
      if (!isRecord(raw)) continue;
      if (raw.role === 'assistant') {
        const parts = geminiPartsFromAnthropic(raw.content);
        if (parts.length > 0) contents.push({ role: 'model', parts });
        continue;
      }
      if (raw.role !== 'user') continue;
      const parts = geminiPartsFromAnthropic(raw.content);
      if (parts.length > 0) contents.push({ role: 'user', parts });
    }
  }
  const out: Json = { model };
  if (systemText !== '') out.systemInstruction = { parts: [{ text: systemText }] };
  out.contents = contents;
  const declarations: Json[] = [];
  if (Array.isArray(body.tools)) {
    for (const raw of body.tools) {
      if (!isRecord(raw)) continue;
      if (clientApi === 'openai') {
        if (!isRecord(raw.function) || typeof raw.function.name !== 'string') continue;
        declarations.push({
          name: raw.function.name,
          description: typeof raw.function.description === 'string' ? raw.function.description : '',
          parameters: isRecord(raw.function.parameters) ? raw.function.parameters : { type: 'object', properties: {} },
        });
      } else {
        if (typeof raw.name !== 'string') continue;
        declarations.push({
          name: raw.name,
          description: typeof raw.description === 'string' ? raw.description : '',
          parameters: isRecord(raw.input_schema) ? raw.input_schema : { type: 'object', properties: {} },
        });
      }
    }
  }
  if (declarations.length > 0) out.tools = [{ functionDeclarations: declarations }];
  const config: Json = {};
  const maxTokens = asNumber(body.max_tokens) ?? asNumber(body.max_completion_tokens);
  if (maxTokens !== null) config.maxOutputTokens = maxTokens;
  const stops = clientApi === 'openai' ? stringList(body.stop) : stringList(body.stop_sequences);
  if (stops.length > 0) config.stopSequences = stops;
  if (typeof body.temperature === 'number') config.temperature = body.temperature;
  if (typeof body.top_p === 'number') config.topP = body.top_p;
  if (clientApi === 'openai' && isRecord(body.response_format)) {
    const type = body.response_format.type;
    if (type === 'json_object' || type === 'json_schema') config.responseMimeType = 'application/json';
  }
  if (Object.keys(config).length > 0) out.generationConfig = config;
  return out;
}

// ---------------------------------------------------------------------------
// Calling a provider and reading its answer
// ---------------------------------------------------------------------------

const UPSTREAM_TIMEOUT_MS = 2000;

interface UpstreamSuccess {
  ok: true;
  text: string;
  usage: Usage | null;
  stop: string;
}

interface UpstreamFailure {
  ok: false;
  status: number;
}

type UpstreamResult = UpstreamSuccess | UpstreamFailure;

/** One SSE frame: its event name (null when unnamed) and its data lines joined. */
interface SseFrame {
  event: string | null;
  data: string;
}

function parseSse(text: string): SseFrame[] {
  const frames: SseFrame[] = [];
  const normalized = text.replace(/\r\n/g, '\n');
  for (const frame of normalized.split('\n\n')) {
    if (frame.trim() === '') continue;
    let event: string | null = null;
    const data: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) data.push(line.slice('data:'.length).replace(/^ /, ''));
    }
    if (data.length > 0) frames.push({ event, data: data.join('\n') });
  }
  return frames;
}

function answerTextOf(content: unknown): string {
  if (typeof content === 'string') return content;
  return blocksText(content);
}

function parseOpenAIAnswer(bodyText: string, stream: boolean): UpstreamSuccess {
  if (!stream) {
    let value: unknown = null;
    try {
      value = JSON.parse(bodyText);
    } catch {
      // Not JSON: no text, no usage, no stop.
    }
    if (!isRecord(value)) return { ok: true, text: '', usage: null, stop: 'stop' };
    const choices = Array.isArray(value.choices) ? value.choices : [];
    const choice = isRecord(choices[0]) ? choices[0] : {};
    const message = isRecord(choice.message) ? choice.message : {};
    const usage = isRecord(value.usage)
      ? { input: asNumber(value.usage.prompt_tokens) ?? 0, output: asNumber(value.usage.completion_tokens) ?? 0 }
      : null;
    return {
      ok: true,
      text: answerTextOf(message.content),
      usage,
      stop: typeof choice.finish_reason === 'string' ? choice.finish_reason : 'stop',
    };
  }
  let text = '';
  let usage: Usage | null = null;
  let stop = 'stop';
  for (const frame of parseSse(bodyText)) {
    const payload = frame.data.trim();
    if (payload === '[DONE]') continue;
    let chunk: unknown = null;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    if (!isRecord(chunk)) continue;
    if (isRecord(chunk.usage)) {
      usage = { input: asNumber(chunk.usage.prompt_tokens) ?? 0, output: asNumber(chunk.usage.completion_tokens) ?? 0 };
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    if (choices.length === 0) continue;
    const choice = isRecord(choices[0]) ? choices[0] : {};
    if (isRecord(choice.delta) && typeof choice.delta.content === 'string') text += choice.delta.content;
    if (typeof choice.finish_reason === 'string') stop = choice.finish_reason;
  }
  return { ok: true, text, usage, stop };
}

function parseAnthropicAnswer(bodyText: string, stream: boolean): UpstreamSuccess {
  if (!stream) {
    let value: unknown = null;
    try {
      value = JSON.parse(bodyText);
    } catch {
      // Not JSON.
    }
    if (!isRecord(value)) return { ok: true, text: '', usage: null, stop: 'end_turn' };
    const usage = isRecord(value.usage)
      ? { input: asNumber(value.usage.input_tokens) ?? 0, output: asNumber(value.usage.output_tokens) ?? 0 }
      : null;
    return {
      ok: true,
      text: answerTextOf(value.content),
      usage,
      stop: typeof value.stop_reason === 'string' ? value.stop_reason : 'end_turn',
    };
  }
  let text = '';
  let input: number | null = null;
  let output: number | null = null;
  let stop = 'end_turn';
  for (const frame of parseSse(bodyText)) {
    let data: unknown = null;
    try {
      data = JSON.parse(frame.data);
    } catch {
      continue;
    }
    if (!isRecord(data)) continue;
    if (frame.event === 'message_start' && isRecord(data.message) && isRecord(data.message.usage)) {
      input = asNumber(data.message.usage.input_tokens);
    } else if (frame.event === 'content_block_delta' && isRecord(data.delta) && data.delta.type === 'text_delta' && typeof data.delta.text === 'string') {
      text += data.delta.text;
    } else if (frame.event === 'message_delta') {
      if (isRecord(data.delta) && typeof data.delta.stop_reason === 'string') stop = data.delta.stop_reason;
      if (isRecord(data.usage)) output = asNumber(data.usage.output_tokens);
    }
  }
  return { ok: true, text, usage: input === null && output === null ? null : { input: input ?? 0, output: output ?? 0 }, stop };
}

function geminiTextOf(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  const texts: string[] = [];
  for (const part of parts) {
    if (isRecord(part) && typeof part.text === 'string') texts.push(part.text);
  }
  return texts.join('');
}

function parseGeminiAnswer(bodyText: string, stream: boolean): UpstreamSuccess {
  if (!stream) {
    let value: unknown = null;
    try {
      value = JSON.parse(bodyText);
    } catch {
      // Not JSON.
    }
    if (!isRecord(value)) return { ok: true, text: '', usage: null, stop: 'STOP' };
    const candidates = Array.isArray(value.candidates) ? value.candidates : [];
    const first = isRecord(candidates[0]) ? candidates[0] : {};
    const content = isRecord(first.content) ? first.content : {};
    const usage = isRecord(value.usageMetadata)
      ? { input: asNumber(value.usageMetadata.promptTokenCount) ?? 0, output: asNumber(value.usageMetadata.candidatesTokenCount) ?? 0 }
      : null;
    return {
      ok: true,
      text: geminiTextOf(content.parts),
      usage,
      stop: typeof first.finishReason === 'string' ? first.finishReason : 'STOP',
    };
  }
  let text = '';
  let usage: Usage | null = null;
  let stop = 'STOP';
  for (const frame of parseSse(bodyText)) {
    let value: unknown = null;
    try {
      value = JSON.parse(frame.data);
    } catch {
      continue;
    }
    if (!isRecord(value)) continue;
    const candidates = Array.isArray(value.candidates) ? value.candidates : [];
    const first = isRecord(candidates[0]) ? candidates[0] : {};
    const content = isRecord(first.content) ? first.content : {};
    text += geminiTextOf(content.parts);
    if (typeof first.finishReason === 'string') stop = first.finishReason;
    if (isRecord(value.usageMetadata)) {
      usage = { input: asNumber(value.usageMetadata.promptTokenCount) ?? 0, output: asNumber(value.usageMetadata.candidatesTokenCount) ?? 0 };
    }
  }
  return { ok: true, text, usage, stop };
}

/** One call to one provider's inference route. A refusal is a failure, never an answer. */
async function callUpstream(
  candidate: Candidate,
  clientApi: 'openai' | 'anthropic',
  body: Json,
  stream: boolean,
): Promise<UpstreamResult> {
  const provider = candidate.provider;
  const base = joinBase(ENV_URL, provider.base);
  const headers: Record<string, string> = { 'content-type': 'application/json', ...authHeaders(provider.auth, provider.key) };
  let url: string;
  let upstreamBody: Json;
  if (provider.wire === 'openai') {
    url = `${base}/v1/chat/completions`;
    upstreamBody = clientApi === 'openai' ? { ...body, model: candidate.model } : anthropicToOpenAI(body, candidate.model);
    if (stream) {
      upstreamBody.stream = true;
      upstreamBody.stream_options = { include_usage: true };
      headers.accept = 'text/event-stream';
    }
  } else if (provider.wire === 'anthropic') {
    url = `${base}/v1/messages`;
    headers['anthropic-version'] = '2023-06-01';
    upstreamBody = clientApi === 'anthropic' ? { ...body, model: candidate.model } : openAIToAnthropic(body, candidate.model);
    if (stream) {
      upstreamBody.stream = true;
      headers.accept = 'text/event-stream';
    }
  } else {
    const method = stream ? 'streamGenerateContent' : 'generateContent';
    url = `${base}/v1beta/models/${encodeURIComponent(candidate.model)}:${method}`;
    upstreamBody = toGemini(clientApi, body, candidate.model);
    if (stream) headers.accept = 'text/event-stream';
  }
  const s = stateOf(provider.id);
  s.attempts += 1;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    log(`upstream ${provider.id}/${candidate.model}: ${(err as Error).message}`);
    s.consecFails += 1;
    return { ok: false, status: 0 };
  }
  if (!res.ok) {
    try {
      await res.text();
    } catch {
      // The error body is not needed.
    }
    log(`upstream ${provider.id}/${candidate.model}: HTTP ${res.status}`);
    s.consecFails += 1;
    return { ok: false, status: res.status };
  }
  s.consecFails = 0;
  const text = await res.text();
  if (provider.wire === 'openai') return parseOpenAIAnswer(text, stream);
  if (provider.wire === 'anthropic') return parseAnthropicAnswer(text, stream);
  return parseGeminiAnswer(text, stream);
}

// ---------------------------------------------------------------------------
// Answering the client in its own wire
// ---------------------------------------------------------------------------

const FIXED_CREATED = 1767225600;

function splitText(text: string, size = 13): string[] {
  const pieces: string[] = [];
  for (let at = 0; at < text.length; at += size) pieces.push(text.slice(at, at + size));
  return pieces.length === 0 ? [''] : pieces;
}

const STOP_FAMILIES = new Map<string, number>([
  ['stop', 0],
  ['end_turn', 0],
  ['STOP', 0],
  ['length', 1],
  ['max_tokens', 1],
  ['MAX_TOKENS', 1],
  ['tool_calls', 2],
  ['function_call', 2],
  ['tool_use', 2],
  ['content_filter', 3],
  ['refusal', 3],
  ['SAFETY', 3],
]);

/** A provider's stop reason in the client's wire: same family, the client's word. */
function clientStop(stop: string, clientApi: 'openai' | 'anthropic'): string {
  const family = STOP_FAMILIES.get(stop) ?? 0;
  if (clientApi === 'openai') return ['stop', 'length', 'tool_calls', 'content_filter'][family] ?? 'stop';
  return ['end_turn', 'max_tokens', 'tool_use', 'refusal'][family] ?? 'end_turn';
}

function sseEvent(event: string | null, data: unknown): string {
  return `${event === null ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function sendSseHead(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
}

interface ServedAnswer {
  text: string;
  usage: Usage;
  stop: string;
  model: string;
}

function answerOpenAI(res: ServerResponse, stream: boolean, answer: ServedAnswer): void {
  const stop = clientStop(answer.stop, 'openai');
  const usage = { prompt_tokens: answer.usage.input, completion_tokens: answer.usage.output, total_tokens: answer.usage.input + answer.usage.output };
  if (!stream) {
    sendJson(res, 200, {
      id: 'chatcmpl-agg',
      object: 'chat.completion',
      created: FIXED_CREATED,
      model: answer.model,
      choices: [{ index: 0, message: { role: 'assistant', content: answer.text }, finish_reason: stop, logprobs: null }],
      usage,
    });
    return;
  }
  sendSseHead(res);
  const chunk = (delta: Json, finish: string | null): Json => ({
    id: 'chatcmpl-agg',
    object: 'chat.completion.chunk',
    created: FIXED_CREATED,
    model: answer.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  res.write(sseEvent(null, chunk({ role: 'assistant', content: '' }, null)));
  for (const piece of splitText(answer.text)) res.write(sseEvent(null, chunk({ content: piece }, null)));
  res.write(sseEvent(null, chunk({}, stop)));
  res.write(sseEvent(null, { id: 'chatcmpl-agg', object: 'chat.completion.chunk', created: FIXED_CREATED, model: answer.model, choices: [], usage }));
  res.write('data: [DONE]\n\n');
  res.end();
}

function answerAnthropic(res: ServerResponse, stream: boolean, answer: ServedAnswer): void {
  const stop = clientStop(answer.stop, 'anthropic');
  if (!stream) {
    sendJson(res, 200, {
      id: 'msg_agg',
      type: 'message',
      role: 'assistant',
      model: answer.model,
      content: [{ type: 'text', text: answer.text }],
      stop_reason: stop,
      stop_sequence: null,
      usage: { input_tokens: answer.usage.input, output_tokens: answer.usage.output },
    });
    return;
  }
  sendSseHead(res);
  res.write(
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_agg',
        type: 'message',
        role: 'assistant',
        model: answer.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: answer.usage.input, output_tokens: 0 },
      },
    }),
  );
  res.write(sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
  for (const piece of splitText(answer.text)) {
    res.write(sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } }));
  }
  res.write(sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }));
  res.write(
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: answer.usage.output },
    }),
  );
  res.write(sseEvent('message_stop', { type: 'message_stop' }));
  res.end();
}

function sendError(res: ServerResponse, clientApi: 'openai' | 'anthropic', status: number, type: string, message: string): void {
  if (clientApi === 'anthropic') sendJson(res, status, { type: 'error', error: { type, message } });
  else sendJson(res, status, { error: { message, type, code: null } });
}

// ---------------------------------------------------------------------------
// Serving one client request
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 32 * 1024 * 1024;
const POLL_INTERVAL_MS = 100;

let brief: Brief = { directory: [], ratings: [], workload: [], error: null };
let catalog: Catalog = { providers: [] };
/** How many client API requests have arrived: the manifest is in arrival order, one at a time. */
let manifestIndex = 0;

async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** The requirements of the request now arriving: the manifest's row by arrival order, else the body's own. */
function requirementsFor(body: Json): Requirement {
  const entry = brief.workload[manifestIndex];
  manifestIndex += 1;
  if (entry !== undefined) return entry.requires;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let vision = false;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) vision = true;
    }
  }
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  return {
    tools: Array.isArray(body.tools) && body.tools.length > 0,
    vision,
    json: format === 'json_object' || format === 'json_schema',
  };
}

/** POST /v1/chat/completions or /v1/messages: serve it with the best free model that answers. */
async function serve(clientApi: 'openai' | 'anthropic', body: Json, res: ServerResponse): Promise<void> {
  const stream = body.stream === true;
  const requires = requirementsFor(body);
  const inputs = echoInputs(clientApi, body);
  const candidates = candidatesFor(brief, catalog, clientApi, requires);
  if (candidates.length === 0) {
    sendError(res, clientApi, 503, clientApi === 'anthropic' ? 'overloaded_error' : 'no_free_model', 'no free model meets this request');
    return;
  }
  for (const candidate of candidates) {
    const result = await callUpstream(candidate, clientApi, body, stream);
    if (!result.ok) continue;
    const computed = usageOf(inputs, result.text);
    if (result.usage !== null && (result.usage.input !== computed.input || result.usage.output !== computed.output)) {
      log(
        `usage mismatch on ${candidate.provider.id}/${candidate.model}: provider ${result.usage.input}/${result.usage.output}, computed ${computed.input}/${computed.output}`,
      );
    }
    const answer: ServedAnswer = {
      text: result.text,
      usage: result.usage ?? computed,
      stop: result.stop,
      model: candidate.model,
    };
    if (clientApi === 'openai') answerOpenAI(res, stream, answer);
    else answerAnthropic(res, stream, answer);
    return;
  }
  log(`unserved: every candidate refused (${candidates.length} tried)`);
  sendError(res, clientApi, 503, clientApi === 'anthropic' ? 'overloaded_error' : 'no_free_model', 'every free model refused this request');
}

/** GET /v1/models, in the shape of the auth header the client sent. */
function models(req: IncomingMessage, res: ServerResponse): void {
  const seen = new Set<string>();
  const ids: { id: string; provider: string }[] = [];
  for (const entry of catalog.providers) {
    for (const model of entry.models) {
      if (!model.free || seen.has(model.id)) continue;
      seen.add(model.id);
      ids.push({ id: model.id, provider: entry.id });
    }
  }
  if (typeof req.headers['x-api-key'] === 'string') {
    sendJson(res, 200, {
      data: ids.map((m) => ({ type: 'model', id: m.id, display_name: m.id, created_at: '2026-01-01T00:00:00Z' })),
      has_more: false,
    });
  } else {
    sendJson(res, 200, {
      object: 'list',
      data: ids.map((m) => ({ id: m.id, object: 'model', created: FIXED_CREATED, owned_by: m.provider })),
    });
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    models(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    const body = await readJson(req);
    if (body === null) return sendError(res, 'openai', 400, 'invalid_request_error', 'the request body is not one JSON object');
    await serve('openai', body, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    const body = await readJson(req);
    if (body === null) return sendError(res, 'anthropic', 400, 'invalid_request_error', 'the request body is not one JSON object');
    await serve('anthropic', body, res);
    return;
  }
  sendError(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`);
}

// ---------------------------------------------------------------------------
// Register, poll, run
// ---------------------------------------------------------------------------

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

async function register(port: number): Promise<void> {
  const res = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: 1, port, catalog }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`POST ${ENV_URL}/register answered HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const reply: unknown = await res.json();
  if (isRecord(reply) && typeof reply.requests === 'number') log(`registered: the workload holds ${reply.requests} requests`);
}

function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status !== 200) return;
        const work: unknown = await res.json();
        if (isRecord(work) && work.done === true) {
          clearInterval(timer);
          server.close();
          process.exit(0);
        }
      } catch {
        // The env is not reachable yet: try again on the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_INTERVAL_MS);
}

async function start(): Promise<void> {
  brief = readBrief(PROMPT_FILE);
  if (brief.error !== null) log(brief.error);
  catalog = await buildCatalog(brief);
  if (process.argv.includes('--list')) {
    // The same document the register body carries, byte for byte: print the one built object and stop
    // before any server starts.
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) sendError(res, req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai', 500, 'internal_error', 'the server failed to answer');
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  const port = address.port;
  if (port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  const freeModels = catalog.providers.reduce((n, p) => n + p.models.filter((m) => m.free).length, 0);
  log(`listening on 0.0.0.0:${port} with ${catalog.providers.length} providers and ${freeModels} free models`);
  await register(port);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  poll(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
