import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { resolveOmpBin, wrapWindowsScript } from "./omp/omp-cli";
import { imageMimeType } from "./media-cache";
import { isRecord } from "./type-guards";
import { createChildProcessEnvironment } from "./project-command-env";

export type ImageProvider = "openai" | "gemini";
export interface GeneratedImage { data: string; mimeType: string; }
export interface ImageGenerationRequest { provider: ImageProvider; model: string; prompt: string; cwd: string; }
interface ImageModel { id: string; name: string; }
export interface ImageProviderOption { id: ImageProvider; name: string; model: string; models: ImageModel[]; available: boolean; reason: string; }
interface CatalogModel { provider: string; id: string; kind: string; name: string; cost?: { input?: number }; }
export class ImageGenerationError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
const execute = promisify(execFile);
const IMAGE_INSTRUCTION = "You are an AI image generator. Generate images based on user descriptions. Focus on creating high-quality, visually appealing images that match the user's request.";

/** Credential refresh/account selection belongs to OMP; tokens never reach the UI or logs. */
async function omp(args: string[], signal?: AbortSignal): Promise<string> {
  const binary = resolveOmpBin();
  if (!binary) throw new ImageGenerationError("The OMP CLI was not found, so the subscriptions cannot be read.", 409);
  const command = wrapWindowsScript(binary, args);
  try {
    const { stdout } = await execute(command.file, command.args, { timeout: 90_000, maxBuffer: 8 * 1024 * 1024, signal, windowsHide: true, env: createChildProcessEnvironment() });
    return stdout.trim();
  } catch {
    signal?.throwIfAborted();
    // execFile errors contain stdout/stderr, potentially including OAuth secrets.
    throw new ImageGenerationError("OMP could not read the subscription data. Check the provider sign-in in the OMP settings.", 409);
  }
}

export async function imageProviderOptions(signal?: AbortSignal): Promise<ImageProviderOption[]> {
  let models: CatalogModel[] = [];
  let problem = "";
  try {
    const body: unknown = JSON.parse(await omp(["models", "--kind", "all", "--json", "--no-extensions"], signal));
    if (!isRecord(body) || !Array.isArray(body.models)) throw new Error("Invalid catalog");
    models = body.models.filter((model): model is CatalogModel => isRecord(model) && typeof model.id === "string" && typeof model.provider === "string" && typeof model.kind === "string" && typeof model.name === "string");
  } catch (error) {
    signal?.throwIfAborted();
    problem = error instanceof ImageGenerationError ? error.message : "Could not read the OMP model catalog.";
  }
  return (["openai", "gemini"] as const).map(id => {
    const choices = models.filter(model => id === "openai"
      ? model.provider === "openai-codex" && model.kind === "chat" && /^gpt-/.test(model.id)
      : model.provider === "google-antigravity" && model.kind === "image" && /^gemini-/.test(model.id));
    // Match native hosted-image selection: cheapest same-provider GPT carrier.
    choices.sort((a, b) => (a.cost?.input ?? Infinity) - (b.cost?.input ?? Infinity) || a.id.localeCompare(b.id));
    const listed = choices.map(model => ({ id: `${model.provider}/${model.id}`, name: model.name }));
    return {
      id, name: id === "openai" ? "GPT / ChatGPT — subscription" : "Gemini / Antigravity — subscription",
      model: listed[0]?.id ?? "", models: listed, available: listed.length > 0,
      reason: problem || (id === "openai" ? "Sign in to openai-codex in the OMP settings. Generation uses the GPT carrier model and your ChatGPT subscription quota." : "Sign in to google-antigravity in the OMP settings. The generation model is picked from your Gemini subscription catalog."),
    };
  });
}

export function validateImageGeneration(value: unknown): ImageGenerationRequest {
  if (!isRecord(value)) throw new ImageGenerationError("Invalid generation request.");
  if (value.provider !== "openai" && value.provider !== "gemini") throw new ImageGenerationError("Only the GPT/ChatGPT and Gemini/Antigravity subscriptions are allowed.");
  if (typeof value.prompt !== "string" || !value.prompt.trim() || value.prompt.length > 32_000) throw new ImageGenerationError("The description must contain 1 to 32000 characters.");
  if (typeof value.cwd !== "string" || !value.cwd) throw new ImageGenerationError("Choose a project to save the image in.");
  const model = typeof value.model === "string" ? value.model.trim() : "";
  const valid = value.provider === "openai" ? /^openai-codex\/gpt-[A-Za-z0-9.-]+$/.test(model) : /^google-antigravity\/gemini-[A-Za-z0-9.-]+$/.test(model);
  if (!valid) throw new ImageGenerationError("Choose a model from the selected subscription catalog.");
  return { provider: value.provider, model, prompt: value.prompt.trim(), cwd: value.cwd };
}

function image(data: unknown, mime: unknown): GeneratedImage | null {
  if (typeof data !== "string" || !data || data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  const mimeType = typeof mime === "string" ? mime : imageMimeType(Buffer.from(data.slice(0, 32), "base64"));
  if (mimeType !== "image/png" && mimeType !== "image/jpeg" && mimeType !== "image/webp") return null;
  return { data, mimeType };
}

function imagesFromPayload(provider: ImageProvider, value: unknown): GeneratedImage[] {
  if (!isRecord(value)) return [];
  const images: GeneratedImage[] = [];
  if (provider === "openai") {
    const outputs = Array.isArray(value.output) ? value.output : value.type === "image_generation_call" ? [value] : [];
    for (const output of outputs) {
      if (!isRecord(output) || output.type !== "image_generation_call") continue;
      const result = image(output.result, undefined);
      if (result) images.push(result);
    }
  } else {
    const payload = isRecord(value.response) ? value.response : value;
    if (Array.isArray(payload.candidates)) for (const candidate of payload.candidates) {
      if (!isRecord(candidate) || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) continue;
      for (const part of candidate.content.parts) {
        if (!isRecord(part) || !isRecord(part.inlineData)) continue;
        const result = image(part.inlineData.data, part.inlineData.mimeType);
        if (result) images.push(result);
      }
    }
  }
  return images;
}

/** Both native subscription transports return SSE; handle CRLF and multi-line data frames. */
export async function readSubscriptionImages(response: Response, provider: ImageProvider, signal: AbortSignal): Promise<GeneratedImage[]> {
  if (!response.body) throw new ImageGenerationError("The subscription returned an empty answer.", 502);
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "", lines: string[] = [];
  const images = new Map<string, GeneratedImage>();
  const consume = () => {
    const data = lines.join("\n"); lines = [];
    if (!data || data === "[DONE]") return;
    const event: unknown = JSON.parse(data);
    if (!isRecord(event)) return;
    if (event.type === "error" || event.type === "response.failed" || event.error) throw new ImageGenerationError("The subscription refused the image generation. Check the limits and the model access.", 422);
    const payload = provider === "openai" ? event.type === "response.output_item.done" ? event.item : event.response : event;
    if (provider === "openai" && (event.type === "response.completed" || event.type === "response.done") && isRecord(payload) && Array.isArray(payload.output) && payload.output.length) images.clear();
    for (const result of imagesFromPayload(provider, payload)) images.set(result.data, result);
  };
  const line = (text: string) => {
    if (!text) consume();
    else if (text.startsWith("data:")) lines.push(text.slice(5).replace(/^ /, ""));
  };
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) { line(pending.slice(0, end).replace(/\r$/, "")); pending = pending.slice(end + 1); }
    }
    pending += decoder.decode();
    if (pending) line(pending.replace(/\r$/, ""));
    if (lines.length) consume();
    signal.throwIfAborted();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  if (!images.size) throw new ImageGenerationError("The subscription returned no image. Check the model access and the content restrictions.", 422);
  return [...images.values()];
}

/** Request shapes mirror OMP 18.12.5 images/openai-hosted.ts and images/google-antigravity.ts. */
export async function generateImages(request: ImageGenerationRequest, signal: AbortSignal): Promise<GeneratedImage[]> {
  const options = await imageProviderOptions(signal);
  const provider = options.find(option => option.id === request.provider);
  if (!provider?.available) throw new ImageGenerationError(provider?.reason ?? "The subscription is unavailable.", 409);
  if (!provider.models.some(model => model.id === request.model)) throw new ImageGenerationError("The model is no longer available in this subscription. Refresh the list.", 409);
  const providerId = request.provider === "openai" ? "openai-codex" : "google-antigravity";
  const raw = await omp(["token", providerId, "--raw"], signal);
  let token = raw, projectId = "", accountId = "", residency = "";
  try {
    const credentials: unknown = JSON.parse(raw);
    if (isRecord(credentials) && typeof credentials.token === "string") {
      token = credentials.token;
      projectId = typeof credentials.projectId === "string" ? credentials.projectId : "";
    }
  } catch { /* Codex can return its raw JWT rather than structured credentials. */ }
  const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${token}`, Accept: "text/event-stream" };
  const model = request.model.slice(providerId.length + 1);
  let endpoint: string, body: object;
  if (request.provider === "openai") {
    try {
      const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))["https://api.openai.com/auth"];
      if (isRecord(claims)) {
        accountId = typeof claims.chatgpt_account_id === "string" ? claims.chatgpt_account_id : "";
        const region = claims.chatgpt_data_residency ?? claims.chatgpt_compute_residency;
        if (typeof region === "string" && region !== "no_constraint") residency = region;
      }
    } catch { /* No undocumented account/profile request as a fallback. */ }
    if (!accountId) throw new ImageGenerationError("The ChatGPT subscription returned no valid OAuth account id.", 409);
    const session = randomUUID();
    Object.assign(headers, { "chatgpt-account-id": accountId, "OpenAI-Beta": "responses=experimental", originator: "omp", "User-Agent": "ompweb", session_id: session, conversation_id: session });
    if (residency) headers["x-openai-internal-codex-residency"] = residency;
    endpoint = "https://chatgpt.com/backend-api/codex/responses";
    body = { model, input: [{ role: "user", content: [{ type: "input_text", text: request.prompt }] }], tools: [{ type: "image_generation", action: "generate", output_format: "webp" }], tool_choice: { type: "image_generation" }, store: false, instructions: IMAGE_INSTRUCTION, stream: true };
  } else {
    if (!projectId) throw new ImageGenerationError("The Gemini subscription returned no OAuth project id.", 409);
    headers["User-Agent"] = `antigravity/hub/${process.env.PI_AI_ANTIGRAVITY_VERSION || "2.19.1"} (aidev_client; os_type=${process.env.PI_AI_ANTIGRAVITY_OS || "darwin"}; arch=${process.env.PI_AI_ANTIGRAVITY_ARCH || "arm64"}; cl=${process.env.PI_AI_ANTIGRAVITY_CL || "963137146"})`;
    endpoint = "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";
    body = { project: projectId, model, request: { contents: [{ role: "user", parts: [{ text: request.prompt }] }], systemInstruction: { parts: [{ text: IMAGE_INSTRUCTION }] }, generationConfig: { responseModalities: ["IMAGE"], candidateCount: 1 } }, requestId: `agent-${randomUUID()}`, userAgent: "antigravity" };
  }
  signal.throwIfAborted();
  let response: Response;
  try { response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]), redirect: "error" }); }
  catch { signal.throwIfAborted(); throw new ImageGenerationError("The subscription service did not answer.", 502); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ImageGenerationError(response.status === 429 ? "The subscription's generation quota is spent. Try again after it recovers." : `The subscription service returned HTTP ${response.status}. Check the model's access and the OMP sign-in state.`, response.status === 429 ? 429 : 502);
  }
  return readSubscriptionImages(response, request.provider, signal);
}
