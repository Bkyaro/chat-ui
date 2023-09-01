import { authCondition } from "$lib/server/auth";
import { collections } from "$lib/server/database";
import { defaultModel } from "$lib/server/models";
import { searchWeb } from "$lib/server/websearch/searchWeb";
import type { Message } from "$lib/types/Message";
import { error } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { WebSearch } from "$lib/types/WebSearch";
import { generateQuery } from "$lib/server/websearch/generateQuery";
import { parseWeb } from "$lib/server/websearch/parseWeb";
import { chunk } from "$lib/utils/chunk.js";
import { summarizeWeb } from "$lib/server/websearch/summarizeWeb";

interface GenericObject {
	[key: string]: GenericObject | unknown;
}

function removeLinks(obj: GenericObject) {
	for (const prop in obj) {
		if (prop.endsWith("link")) delete obj[prop];
		else if (typeof obj[prop] === "object") removeLinks(obj[prop] as GenericObject);
	}
	return obj;
}
export async function GET({ params, locals, url }) {
	const model = defaultModel;
	const convId = new ObjectId(params.id);
	const searchId = new ObjectId();

	const conv = await collections.conversations.findOne({
		_id: convId,
		...authCondition(locals),
	});

	if (!conv) {
		throw error(404, "Conversation not found");
	}

	const prompt = z.string().trim().min(1).parse(url.searchParams.get("prompt"));

	const messages = (() => {
		return [...conv.messages, { content: prompt, from: "user", id: crypto.randomUUID() }];
	})() satisfies Message[];

	const stream = new ReadableStream({
		async start(controller) {
			const webSearch: WebSearch = {
				_id: searchId,
				convId: convId,
				prompt: prompt,
				searchQuery: "",
				knowledgeGraph: "",
				answerBox: "",
				results: [],
				summary: "",
				messages: [],
				createdAt: new Date(),
				updatedAt: new Date(),
			};

			function appendUpdate(message: string, args?: string[], type?: "error" | "update") {
				webSearch.messages.push({
					type: type ?? "update",
					message,
					args,
				});
				controller.enqueue(JSON.stringify({ messages: webSearch.messages }));
			}

			try {
				appendUpdate("Generating search query");
				webSearch.searchQuery = await generateQuery(messages);

				appendUpdate("Searching Google", [webSearch.searchQuery]);
				const results = await searchWeb(webSearch.searchQuery);
				webSearch.results = [
					...((results.top_stories && results.top_stories.map((el: { link: string }) => el.link)) ??
						[]),
					...((results.organic_results &&
						results.organic_results.map((el: { link: string }) => el.link)) ??
						[]),
				];
				webSearch.results = webSearch.results
					.filter((link) => !link.includes("youtube.com")) // filter out youtube links
					.slice(0, 5); // limit to first 5 links only

				if (webSearch.results.length > 0) {
					appendUpdate("Browsing results", [JSON.stringify(webSearch.results)]);
					const promises = webSearch.results.map(async (link) => {
						let text = "";
						try {
							text = await parseWeb(link);
						} catch (e) {
							console.error(`Error parsing webpage "${link}"`, e);
							appendUpdate("Error parsing webpage", [link], "error");
						}
						const CHUNK_CAR_LEN = 512;
						const chunks = chunk(text, CHUNK_CAR_LEN);
						return chunks;
					});
					const paragraphChunks = await Promise.all(promises);
					// todo:
					// if (!text) throw new Error("No text found on the first 5 results");
				} else {
					throw new Error("No results found for this search query");
				}

				appendUpdate("Creating summary");
				webSearch.summary = "Some placeholder text here";
				appendUpdate("Injecting summary", [JSON.stringify(webSearch.summary)]);
			} catch (searchError) {
				if (searchError instanceof Error) {
					webSearch.messages.push({
						type: "error",
						message: "An error occurred with the web search",
						args: [JSON.stringify(searchError.message)],
					});
				}
			}

			const res = await collections.webSearches.insertOne(webSearch);
			webSearch.messages.push({
				type: "result",
				id: res.insertedId.toString(),
			});
			controller.enqueue(JSON.stringify({ messages: webSearch.messages }));
		},
	});

	return new Response(stream, { headers: { "Content-Type": "application/json" } });
}
