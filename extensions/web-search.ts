import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

type SearchResult = {
	title: string;
	url: string;
	snippet: string;
	publishedDate?: string;
	sourceProvider: string;
};

type ProviderOutcome = {
	provider: string;
	ok: boolean;
	results?: SearchResult[];
	reason?: string;
};

const SEARCH_PARAMS = Type.Object({
	query: Type.String({ description: "Search query for current web information" }),
	maxResults: Type.Optional(Type.Number({ description: "Maximum results to return, clamped to 1-10" })),
});

type SearchParams = Static<typeof SEARCH_PARAMS>;

const TIMEOUT_MS = 8_000;
const MAX_SNIPPET_LENGTH = 1_000;

function clampMaxResults(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 5;
	return Math.max(1, Math.min(10, Math.floor(value)));
}

function withTimeout(parentSignal: AbortSignal | undefined): { signal: AbortSignal; cleanup: () => void } {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new Error("request timed out")), TIMEOUT_MS);

	const onAbort = () => controller.abort(parentSignal?.reason);
	parentSignal?.addEventListener("abort", onAbort, { once: true });

	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timeout);
			parentSignal?.removeEventListener("abort", onAbort);
		},
	};
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

async function fetchJson(url: string, init: RequestInit, signal: AbortSignal | undefined): Promise<unknown> {
	const timeout = withTimeout(signal);
	try {
		const response = await fetch(url, { ...init, signal: timeout.signal });
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			const suffix = body ? `: ${body.slice(0, 300)}` : "";
			throw new Error(`HTTP ${response.status}${suffix}`);
		}
		return await response.json();
	} finally {
		timeout.cleanup();
	}
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function truncate(value: string): string {
	return value.length > MAX_SNIPPET_LENGTH ? `${value.slice(0, MAX_SNIPPET_LENGTH)}...` : value;
}

async function searchTavily(query: string, maxResults: number, signal: AbortSignal | undefined): Promise<SearchResult[]> {
	const apiKey = process.env.TAVILY_API_KEY;
	if (!apiKey) throw new Error("TAVILY_API_KEY is not set");

	const json = await fetchJson(
		"https://api.tavily.com/search",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({ query, max_results: maxResults, search_depth: "basic" }),
		},
		signal,
	);

	const results = Array.isArray((json as { results?: unknown }).results) ? (json as { results: unknown[] }).results : [];
	return results.flatMap((item): SearchResult[] => {
		const record = item as Record<string, unknown>;
		const title = nonEmptyString(record.title);
		const url = nonEmptyString(record.url);
		const snippet = nonEmptyString(record.content) ?? nonEmptyString(record.snippet) ?? "";
		if (!title || !url) return [];
		return [{ title, url, snippet: truncate(snippet), sourceProvider: "tavily" }];
	});
}

async function searchExa(query: string, maxResults: number, signal: AbortSignal | undefined): Promise<SearchResult[]> {
	const apiKey = process.env.EXA_API_KEY;
	if (!apiKey) throw new Error("EXA_API_KEY is not set");

	const json = await fetchJson(
		"https://api.exa.ai/search",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": apiKey,
			},
			body: JSON.stringify({ query, numResults: maxResults, type: "auto" }),
		},
		signal,
	);

	const results = Array.isArray((json as { results?: unknown }).results) ? (json as { results: unknown[] }).results : [];
	return results.flatMap((item): SearchResult[] => {
		const record = item as Record<string, unknown>;
		const title = nonEmptyString(record.title) ?? nonEmptyString(record.url);
		const url = nonEmptyString(record.url);
		const snippet = nonEmptyString(record.text) ?? nonEmptyString(record.summary) ?? "";
		const publishedDate = nonEmptyString(record.publishedDate);
		if (!title || !url) return [];
		return [{ title, url, snippet: truncate(snippet), publishedDate, sourceProvider: "exa" }];
	});
}

async function searchFirecrawl(query: string, maxResults: number, signal: AbortSignal | undefined): Promise<SearchResult[]> {
	const apiKey = process.env.FIRECRAWL_API_KEY;
	if (!apiKey) throw new Error("FIRECRAWL_API_KEY is not set");

	const json = await fetchJson(
		"https://api.firecrawl.dev/v2/search",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({ query, limit: maxResults }),
		},
		signal,
	);

	const data = (json as { data?: { web?: unknown[] } }).data;
	const web = Array.isArray(data?.web) ? data.web : [];
	return web.flatMap((item): SearchResult[] => {
		const record = item as Record<string, unknown>;
		const title = nonEmptyString(record.title) ?? nonEmptyString(record.url);
		const url = nonEmptyString(record.url);
		const snippet = nonEmptyString(record.description) ?? nonEmptyString(record.markdown) ?? "";
		if (!title || !url) return [];
		return [{ title, url, snippet: truncate(snippet), sourceProvider: "firecrawl" }];
	});
}

export default function webSearchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: "Search the live web for current information. Falls back across Tavily, Exa, and Firecrawl when configured.",
		promptSnippet: "Search live web via Tavily, Exa, or Firecrawl with automatic fallback",
		promptGuidelines: [
			"Use web_search for current information, pricing, cloud docs, package versions, release dates, news, or anything likely to have changed after training.",
			"When using web_search, cite the returned source URLs in the final answer.",
		],
		parameters: SEARCH_PARAMS,
		async execute(_toolCallId: string, params: SearchParams, signal: AbortSignal | undefined) {
			const maxResults = clampMaxResults(params.maxResults);
			const query = params.query.trim();
			const providers: Array<[string, () => Promise<SearchResult[]>]> = [
				["tavily", () => searchTavily(query, maxResults, signal)],
				["exa", () => searchExa(query, maxResults, signal)],
				["firecrawl", () => searchFirecrawl(query, maxResults, signal)],
			];

			const attempts: ProviderOutcome[] = [];
			for (const [provider, search] of providers) {
				try {
					const results = await search();
					if (results.length === 0) {
						attempts.push({ provider, ok: false, reason: "no usable results" });
						continue;
					}

					attempts.push({ provider, ok: true, results });
					const failedAttempts = attempts.filter((attempt) => !attempt.ok);
					const fallbackNote = failedAttempts.length
						? `\n\nFallback notes:\n${failedAttempts.map((attempt) => `- ${attempt.provider}: ${attempt.reason}`).join("\n")}`
						: "";
					const text = [
						`Provider used: ${provider}`,
						`Query: ${query}`,
						"Results:",
						...results.map((result, index) => {
							const date = result.publishedDate ? ` (${result.publishedDate})` : "";
							return `${index + 1}. ${result.title}${date}\n   ${result.url}\n   ${result.snippet}`;
						}),
					].join("\n");

					return {
						content: [{ type: "text", text: `${text}${fallbackNote}` }],
						details: { provider, query, maxResults, results, attempts },
					};
				} catch (error) {
					attempts.push({ provider, ok: false, reason: getErrorMessage(error) });
				}
			}

			return {
				content: [
					{
						type: "text",
						text: `All configured web search providers failed or returned no results.\n${attempts
							.map((attempt) => `- ${attempt.provider}: ${attempt.reason}`)
							.join("\n")}`,
					},
				],
				details: { query, maxResults, attempts },
				isError: true,
			};
		},
	});
}
