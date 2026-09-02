import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runChild } from "./child-runner.ts";
import { SLOT_COLOR_PALETTE, type ModelSlot, type ModelStack } from "./model-stack.ts";
import { contractSystemPrompt, opinionPrompt, synthesisPrompt } from "./prompt-library.ts";
import { CUSTOM_TYPE, newRun, READONLY_TOOLS, runError, runOk, shortModel, toStat, type HarnessDeps, type Role } from "./runtime.ts";

export type AskMode = "combine" | "separate";

export interface AskPayload {
	v: 1;
	mode: AskMode;
	models: string[];
	writer?: string;
	prompt: string;
}

const MODEL_RE = /^[^/\s]+\/[^\s]+$/;
const MAX_MODELS = 20;
const MAX_ENCODED_BYTES = 2_000_000;
const MAX_PROMPT_BYTES = 1_000_000;

function decodeBase64Url(value: string): string {
	const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
	const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
	return Buffer.from(normalized + padding, "base64").toString("utf8");
}

/** Decode and validate the private transport used by native clients. */
export function parseAskPayload(raw: string): AskPayload {
	const token = raw.trim();
	if (!token || Buffer.byteLength(token, "utf8") > MAX_ENCODED_BYTES) throw new Error("request payload is missing or too large");
	let value: unknown;
	try {
		value = JSON.parse(decodeBase64Url(token));
	} catch {
		throw new Error("request payload is not valid encoded JSON");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request payload must be an object");
	const input = value as Record<string, unknown>;
	if (input.v !== 1) throw new Error("request payload version is not supported");
	if (input.mode !== "combine" && input.mode !== "separate") throw new Error("answer mode must be combine or separate");
	if (!Array.isArray(input.models)) throw new Error("models must be a list");
	const models = input.models.map((model) => typeof model === "string" ? model.trim() : "");
	if (models.length < 2 || models.length > MAX_MODELS) throw new Error(`choose between 2 and ${MAX_MODELS} models`);
	if (models.some((model) => !MODEL_RE.test(model))) throw new Error("every model must be a fully qualified provider/model id");
	if (new Set(models).size !== models.length) throw new Error("the same model cannot be selected twice");
	const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
	if (!prompt || Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) throw new Error("prompt is missing or too large");
	const writer = typeof input.writer === "string" ? input.writer.trim() : undefined;
	if (input.mode === "combine" && (!writer || !models.includes(writer))) throw new Error("the combining model must be one of the selected models");
	return { v: 1, mode: input.mode, models, writer, prompt };
}

/** Build the runtime's internal slot shape without exposing roles to the client. */
export function stackForAsk(payload: AskPayload): ModelStack {
	const architectModel = payload.writer ?? payload.models[0];
	const ordered = [architectModel, ...payload.models.filter((model) => model !== architectModel)];
	const slots: ModelSlot[] = ordered.map((model, index) => ({
		id: `ask-${index + 1}`,
		name: shortModel(model).replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 16) || `model-${index + 1}`,
		model,
		thinking: "high",
		color: SLOT_COLOR_PALETTE[index % SLOT_COLOR_PALETTE.length],
		architect: index === 0,
		primary: index === 1,
		appendSystemPrompts: [],
	}));
	const architect = slots[0];
	const builders = slots.slice(1);
	return {
		codename: "native-ask",
		slots,
		architect,
		primaryBuilder: builders[0],
		builders,
	};
}

function clientAgent(slot: ModelSlot, role: Role = "BUILDER") {
	return {
		role,
		model: slot.model,
		slotId: slot.id,
		slotName: shortModel(slot.model),
		color: slot.color,
		primary: false,
		architect: false,
		thinking: slot.thinking,
	};
}

export function registerAskCommand(pi: ExtensionAPI, h: HarnessDeps): void {
	pi.registerCommand("fh-ask", {
		description: "Native multi-model request transport.",
		handler: async (raw, ctx) => {
			h.noteHost(ctx);
			let request: AskPayload;
			try {
				request = parseAskPayload(raw ?? "");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				h.panel({ kind: "error", command: "fh-ask", ok: false, error: message }, message);
				return;
			}

			let childModels: Set<string>;
			try {
				childModels = await h.childVisibleModels();
			} catch (error) {
				const message = `Could not read available models: ${error instanceof Error ? error.message : String(error)}`;
				h.panel({ kind: "error", command: "fh-ask", ok: false, error: message }, message);
				return;
			}
			const unavailable: string[] = [];
			for (const modelId of request.models) {
				const slash = modelId.indexOf("/");
				const model = slash > 0 ? ctx.modelRegistry.find(modelId.slice(0, slash), modelId.slice(slash + 1)) : undefined;
				if (!model) unavailable.push(`${modelId} is not registered`);
				else if (!ctx.modelRegistry.hasConfiguredAuth(model)) unavailable.push(`${modelId} is not signed in`);
				else if (!childModels.has(modelId)) unavailable.push(`${modelId} cannot run in an isolated worker`);
			}
			if (unavailable.length) {
				const message = unavailable.join("; ");
				h.panel({ kind: "error", command: "fh-ask", ok: false, error: message }, message);
				return;
			}

			const stack = stackForAsk(request);
			const slots = stack.slots;
			const runs = slots.map(h.newSlotRun);
			const synthesis = request.mode === "combine" ? newRun("FUSION", request.writer!) : undefined;
			const startedAt = Date.now();
			const artifactsDir = await h.mkArtifacts();
			await h.save(artifactsDir, "prompt.md", request.prompt);
			await h.save(artifactsDir, "request.json", JSON.stringify(request, null, 2));
			await fs.promises.mkdir(path.join(artifactsDir, "agents"), { recursive: true });
			h.panel({ kind: "prompt", command: "fh-ask", ok: true }, request.prompt);
			h.panel({
				kind: "banner",
				command: "fh-ask",
				ok: true,
				prompt: request.prompt,
				roles: slots.map((slot) => clientAgent(slot)),
				artifactsDir,
			}, "");
			const stopper = h.startStoppable(ctx, "fh-ask");
			const stopWidget = h.startGridWidget(ctx, "fh-ask", runs, synthesis, startedAt);
			ctx.ui.setStatus(CUSTOM_TYPE, `${runs.length} models answering read-only…`);
			try {
				await Promise.all(runs.map(async (run) => {
					const slot = run.slot!;
					const agentDir = path.join(artifactsDir, "agents", slot.id);
					await fs.promises.mkdir(agentDir, { recursive: true });
					const prompt = opinionPrompt(slot, stack, request.prompt);
					await runChild({ run, prompt, tools: READONLY_TOOLS, thinking: slot.thinking, ...h.slotInitialSpawn(slot, ctx, agentDir), cwd: ctx.cwd, timeoutMs: h.childTimeoutMs(), signal: stopper.signal });
					await h.save(agentDir, "answer.md", runOk(run) ? run.text : `FAILED: ${runError(run)}`);
				}));
				if (stopper.stopped()) {
					h.stoppedPanel("fh-ask", runs, artifactsDir, startedAt, "Completed answers remain available.");
					return;
				}
				const successful = runs.filter(runOk);
				const partial = successful.length > 0 && successful.length < runs.length;
				const answers = runs.map((run) => ({
					role: "BUILDER" as Role,
					model: run.model,
					text: runOk(run) ? run.text : `FAILED: ${runError(run)}`,
					slotId: run.slot!.id,
					slotName: shortModel(run.model),
					color: run.slot!.color,
					primary: false,
				}));
				h.panel({
					kind: "multi",
					command: "fh-ask",
					title: request.mode === "separate" ? "MODEL ANSWERS" : "SOURCE ANSWERS",
					ok: successful.length > 0,
					prompt: request.prompt,
					sources: runs.map(toStat),
					answers,
					artifactsDir,
					...h.totals(runs, startedAt),
				}, runs.map((run) => `## ${shortModel(run.model)}\n${runOk(run) ? run.text : `FAILED: ${runError(run)}`}`).join("\n\n"));
				if (request.mode === "separate") {
					await h.save(artifactsDir, "summary.json", JSON.stringify({ command: "fh-ask", mode: request.mode, ok: successful.length > 0, partial, agents: runs.map(toStat), ...h.totals(runs, startedAt) }, null, 2));
					return;
				}
				if (successful.length < 2 || !synthesis) {
					h.panel({ kind: "error", command: "fh-ask", ok: false, sources: runs.map(toStat), artifactsDir }, `A combined answer needs at least two successful responses; ${successful.length} completed.`);
					return;
				}
				ctx.ui.setStatus(CUSTOM_TYPE, `${shortModel(request.writer!)} is combining ${successful.length} responses…`);
				const writerSlot = stack.architect;
				await runChild({
					run: synthesis,
					prompt: synthesisPrompt(request.prompt, runs, synthesis.model, writerSlot.thinking, artifactsDir),
					systemPrompt: contractSystemPrompt(writerSlot.systemPrompt, "SYSTEM_PROMPT_SYNTHESIS.md"),
					appendSystemPrompts: writerSlot.appendSystemPrompts,
					tools: READONLY_TOOLS,
					thinking: writerSlot.thinking,
					sessionDir: path.join(artifactsDir, "synthesis"),
					cwd: ctx.cwd,
					timeoutMs: h.childTimeoutMs(),
					signal: stopper.signal,
				});
				if (stopper.stopped()) {
					h.stoppedPanel("fh-ask", [...runs, synthesis], artifactsDir, startedAt, "Source answers remain available.");
					return;
				}
				await h.save(artifactsDir, "answer.md", runOk(synthesis) ? synthesis.text : `FAILED: ${runError(synthesis)}`);
				if (!runOk(synthesis)) {
					h.panel({ kind: "error", command: "fh-ask", ok: false, agent: toStat(synthesis), sources: runs.map(toStat), artifactsDir }, `The source responses finished, but the combined answer failed: ${runError(synthesis)}`);
					return;
				}
				h.panel({ kind: "synthesized", command: "fh-ask", ok: true, agent: toStat(synthesis), sources: runs.map(toStat), artifactsDir, ...h.totals([...runs, synthesis], startedAt) }, synthesis.text);
				await h.save(artifactsDir, "summary.json", JSON.stringify({ command: "fh-ask", mode: request.mode, ok: true, partial, agents: [...runs, synthesis].map(toStat), ...h.totals([...runs, synthesis], startedAt) }, null, 2));
			} finally {
				await h.ensureSummary(artifactsDir, { command: "fh-ask", mode: request.mode, ok: false, stopped: stopper.stopped(), agents: [...runs, ...(synthesis ? [synthesis] : [])].map(toStat), ...h.totals([...runs, ...(synthesis ? [synthesis] : [])], startedAt) });
				stopper.release();
				stopWidget();
				ctx.ui.setStatus(CUSTOM_TYPE, undefined);
			}
		},
	});
}
