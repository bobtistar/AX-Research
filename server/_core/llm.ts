/**
 * Google Gemini, called directly over its REST API.
 *
 * Replaces the Manus Forge gateway. Two things the gateway could not give us and this can:
 * `temperature: 0`, which removes most of the run-to-run drift the evaluation loop had to
 * average away, and a per-user API key (BYOK), so a free user's inference is billed to
 * them rather than to the operator.
 *
 * The call surface (`invokeLLM`, `listLLMModels`) is deliberately unchanged, so the
 * inference service and the eval harness did not have to move with it.
 */
import { ENV } from "./env";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

export type Role = "system" | "user" | "assistant";

export type Message = { role: Role; content: string };

export type JsonSchema = {
  name?: string;
  strict?: boolean;
  schema: Record<string, unknown>;
};

export type ResponseFormat = {
  type: "json_schema";
  json_schema: JsonSchema;
};

export type InvokeParams = {
  messages: Message[];
  model?: string;
  maxTokens?: number;
  responseFormat?: ResponseFormat;
  /**
   * The caller's own Gemini key. When absent the shared operator key is used, and the call
   * counts against the operator's bill.
   */
  apiKey?: string;
  /**
   * Defaults to 0. Evidence extraction has one right answer, and a fixed value is what
   * makes two evaluation runs of the same prompt comparable.
   */
  temperature?: number;
};

export type InvokeResult = {
  choices: Array<{ message: { content: string } }>;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
};

export const DEFAULT_MODEL = "gemini-2.5-flash";

function resolveKey(apiKey?: string) {
  const key = apiKey || ENV.geminiApiKey;
  if (!key)
    throw new Error(
      "Gemini API 키가 없습니다. 설정에서 본인 키를 등록하거나 관리자에게 문의하세요."
    );
  return key;
}

/**
 * Gemini has no `system` role: instruction text goes in `systemInstruction`, and the rest
 * becomes alternating `user`/`model` turns.
 */
function toGeminiBody(params: InvokeParams) {
  const systemText = params.messages
    .filter(message => message.role === "system")
    .map(message => message.content)
    .join("\n\n");
  const contents = params.messages
    .filter(message => message.role !== "system")
    .map(message => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    }));

  const generationConfig: Record<string, unknown> = {
    temperature: params.temperature ?? 0,
    maxOutputTokens: params.maxTokens ?? 8_000,
  };
  if (params.responseFormat?.type === "json_schema") {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = toGeminiSchema(
      params.responseFormat.json_schema.schema
    );
  }

  return {
    ...(systemText
      ? { systemInstruction: { parts: [{ text: systemText }] } }
      : {}),
    contents,
    generationConfig,
  };
}

/**
 * Gemini accepts a subset of JSON Schema and rejects `additionalProperties`, so the
 * schema written for the strict-JSON gateway is trimmed rather than rewritten at the
 * call sites. `propertyOrdering` keeps generated fields in a stable order.
 */
function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  const source = schema as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "additionalProperties" || key === "strict") continue;
    output[key] = toGeminiSchema(value);
  }
  if (
    output.type === "object" &&
    output.properties &&
    typeof output.properties === "object"
  ) {
    output.propertyOrdering = Object.keys(
      output.properties as Record<string, unknown>
    );
  }
  return output;
}

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  error?: { message?: string; status?: string };
};

export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  const model = params.model || ENV.inferenceModel || DEFAULT_MODEL;
  const key = resolveKey(params.apiKey);

  const response = await fetch(
    `${API_BASE}/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": key,
      },
      body: JSON.stringify(toGeminiBody(params)),
    }
  );

  const payload = (await response.json().catch(() => ({}))) as GeminiResponse;
  if (!response.ok) {
    // The key itself must never reach a log or a user-facing message.
    const detail = payload.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`Gemini 호출 실패: ${detail}`);
  }

  const candidate = payload.candidates?.[0];
  // A response cut off by the token cap yields truncated JSON; failing loudly beats
  // handing the parser half an object.
  if (candidate?.finishReason && candidate.finishReason !== "STOP") {
    throw new Error(
      `Gemini 응답이 완료되지 않았습니다 (${candidate.finishReason}).`
    );
  }
  const content = (candidate?.content?.parts ?? [])
    .map(part => part.text ?? "")
    .join("");

  return {
    choices: [{ message: { content } }],
    model,
    usage: {
      inputTokens: payload.usageMetadata?.promptTokenCount,
      outputTokens: payload.usageMetadata?.candidatesTokenCount,
    },
  };
}

export type ModelInfo = { id: string; owned_by?: string };
export type ModelsResponse = { data: ModelInfo[] };

/** Lists the models this key may call, used to verify a configured model ID exists. */
export async function listLLMModels(apiKey?: string): Promise<ModelsResponse> {
  const response = await fetch(`${API_BASE}/models`, {
    headers: { "x-goog-api-key": resolveKey(apiKey) },
  });
  if (!response.ok)
    throw new Error(`Gemini 모델 목록 조회 실패 (HTTP ${response.status})`);
  const payload = (await response.json()) as {
    models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
  };
  return {
    data: (payload.models ?? [])
      .filter(model =>
        (model.supportedGenerationMethods ?? []).includes("generateContent")
      )
      .map(model => ({
        // The API returns "models/gemini-2.5-flash"; callers configure the bare ID.
        id: (model.name ?? "").replace(/^models\//, ""),
        owned_by: "google",
      }))
      .filter(model => model.id),
  };
}
