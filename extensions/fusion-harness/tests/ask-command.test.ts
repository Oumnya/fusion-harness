import { describe, expect, test } from "bun:test";
import { parseAskPayload, stackForAsk } from "../modules/cmd-ask.ts";

function encode(value: unknown): string {
	return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

const request = {
	v: 1,
	mode: "combine",
	models: [
		"anthropic/claude-opus-4-6",
		"google-vertex/gemini-3.1-pro-preview",
		"openai-codex/gpt-5.3-codex",
		"deepseek/deepseek-v3.2",
	],
	writer: "openai-codex/gpt-5.3-codex",
	prompt: "Find the root cause and recommend a fix.",
};

describe("native ask transport", () => {
	test("accepts a variable model list and preserves the prompt", () => {
		const parsed = parseAskPayload(encode(request));
		expect(parsed.models).toEqual(request.models);
		expect(parsed.writer).toBe(request.writer);
		expect(parsed.prompt).toBe(request.prompt);
	});

	test("makes the selected combining model the internal architect", () => {
		const stack = stackForAsk(parseAskPayload(encode(request)));
		expect(stack.slots).toHaveLength(4);
		expect(stack.architect.model).toBe(request.writer);
		expect(stack.primaryBuilder.model).toBe(request.models[0]);
		expect(stack.slots.every((slot) => slot.thinking === "high")).toBe(true);
	});

	test("accepts separate answers without a writer", () => {
		const parsed = parseAskPayload(encode({ ...request, mode: "separate", writer: undefined }));
		expect(parsed.mode).toBe("separate");
		expect(parsed.writer).toBeUndefined();
	});

	test.each([
		["one model", { ...request, models: [request.models[0]], writer: request.models[0] }],
		["duplicate model", { ...request, models: [request.models[0], request.models[0]], writer: request.models[0] }],
		["unknown mode", { ...request, mode: "debate" }],
		["writer outside selection", { ...request, writer: "anthropic/not-selected" }],
		["empty prompt", { ...request, prompt: "  " }],
	])("rejects %s", (_label, value) => {
		expect(() => parseAskPayload(encode(value))).toThrow();
	});
});
