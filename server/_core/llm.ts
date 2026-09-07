/**
 * The model call, over two providers.
 *
 * Muse Spark (Meta's OpenAI-compatible API) carries the operator's traffic. Google Gemini
 * stays for BYOK: the keys users have registered in settings are Gemini keys, so a call
 * that arrives with a user key must keep going to Gemini or it would fail against a
 * provider that never issued it.
 *
 * The call surface (`invokeLLM`, `listLLMModels`) is unchanged, as it was through the
 * Forge → Gemini move, so the inference service, the digest and the eval harness do not
 * move with it.
 *
 * A caveat the eval loop has to live with: two providers means two models can answer the
 * same prompt, and `pnpm eval` compares scores across runs. Every run already records its
 * model, and `InvokeResult` now also carries `provider`, so a mixed results.tsv can at
 * least be split apart afterwards. Scores from different providers are not comparable.
 */
import { ENV } from "./env";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

export type Provider = "musespark" | "gemini";

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
   * The caller's own Gemini key. When present the call is routed to Gemini and billed to
   * them; when absent it runs on the operator's Muse Spark key.
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
  /** Which provider actually answered. Recorded so a mixed eval set can be separated. */
  provider: Provider;
  usage?: { inputTokens?: number; outputTokens?: number };
};

export const DEFAULT_MODEL_BY_PROVIDER: Record<Provider, string> = {
  musespark: "muse-spark-1.3",
  gemini: "gemini-2.5-flash",
};

/** Retained for callers that still import it; the operator default is Muse Spark. */
export const DEFAULT_MODEL = DEFAULT_MODEL_BY_PROVIDER.musespark;

/**
 * A user-supplied key is by construction a Gemini key — that is what the settings screen
 * asks for and what `secrets.ts` encrypts. Routing by the presence of that key is
 * therefore the same decision as routing by who pays.
 */
export function resolveProvider(apiKey?: string): Provider {
  return apiKey ? "gemini" : "musespark";
}

/** The model this provider should use when the caller did not name one. */
export function defaultModelFor(provider: Provider): string {
  if (provider === "gemini")
    return ENV.geminiModel || DEFAULT_MODEL_BY_PROVIDER.gemini;
  return ENV.inferenceModel || DEFAULT_MODEL_BY_PROVIDER.musespark;
}

function resolveGeminiKey(apiKey?: string) {
  const key = apiKey || ENV.geminiApiKey;
  if (!key)
    throw new Error(
      "Gemini API 키가 없습니다. 설정에서 본인 키를 등록하거나 관리자에게 문의하세요."
    );
  return key;
}

function resolveMuseSparkKey() {
  if (!ENV.museSparkApiKey)
    throw new Error(
      "Muse Spark API 키가 설정되지 않았습니다. 관리자에게 문의하거나 설정에서 본인 Gemini 키를 등록해 주세요."
    );
  return ENV.museSparkApiKey;
}

// --- Muse Spark (OpenAI-compatible) ----------------------------------------

type OpenAIResponse = {
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string;
  }>;
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string };
};

async function invokeMuseSpark(
  params: InvokeParams,
  model: string
): Promise<InvokeResult> {
  const response = await fetch(`${ENV.museSparkBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${resolveMuseSparkKey()}`,
    },
    body: JSON.stringify({
      model,
      messages: params.messages,
      temperature: params.temperature ?? 0,
      max_tokens: params.maxTokens ?? 8_000,
      // The schemas at the call sites are already written in strict OpenAI form, with
      // `additionalProperties: false`; only the Gemini path has to trim them.
      ...(params.responseFormat ? { response_format: params.responseFormat } : {}),
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as OpenAIResponse;
  if (!response.ok) {
    // The key itself must never reach a log or a user-facing message.
    const detail = payload.error?.message ?? `HTTP ${response.status}`;
    if (response.status === 402)
      throw new Error(
        "Muse Spark 계정에 크레딧이 없습니다. 결제를 확인하거나 설정에서 본인 Gemini 키를 등록해 주세요."
      );
    throw new Error(`Muse Spark 호출 실패: ${detail}`);
  }

  const choice = payload.choices?.[0];
  // A response cut off by the token cap yields truncated JSON; failing loudly beats
  // handing the parser half an object.
  if (choice?.finish_reason && choice.finish_reason !== "stop")
    throw new Error(
      `Muse Spark 응답이 완료되지 않았습니다 (${choice.finish_reason}).`
    );

  return {
    choices: [{ message: { content: choice?.message?.content ?? "" } }],
    model: payload.model ?? model,
    provider: "musespark",
    usage: {
      inputTokens: payload.usage?.prompt_tokens,
      outputTokens: payload.usage?.completion_tokens,
    },
  };
}

// --- Gemini (BYOK) ---------------------------------------------------------

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
 * schema written for the strict-JSON call sites is trimmed rather than rewritten at those
 * sites. `propertyOrdering` keeps generated fields in a stable order.
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

async function invokeGemini(
  params: InvokeParams,
  model: string
): Promise<InvokeResult> {
  const key = resolveGeminiKey(params.apiKey);
  const response = await fetch(
    `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(toGeminiBody(params)),
    }
  );

  const payload = (await response.json().catch(() => ({}))) as GeminiResponse;
  if (!response.ok) {
    const detail = payload.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`Gemini 호출 실패: ${detail}`);
  }

  const candidate = payload.candidates?.[0];
  if (candidate?.finishReason && candidate.finishReason !== "STOP")
    throw new Error(
      `Gemini 응답이 완료되지 않았습니다 (${candidate.finishReason}).`
    );
  const content = (candidate?.content?.parts ?? [])
    .map(part => part.text ?? "")
    .join("");

  return {
    choices: [{ message: { content } }],
    model,
    provider: "gemini",
    usage: {
      inputTokens: payload.usageMetadata?.promptTokenCount,
      outputTokens: payload.usageMetadata?.candidatesTokenCount,
    },
  };
}

// --- Dispatch --------------------------------------------------------------

export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  const provider = resolveProvider(params.apiKey);
  const model = params.model || defaultModelFor(provider);
  return provider === "gemini"
    ? invokeGemini(params, model)
    : invokeMuseSpark(params, model);
}

export type ModelInfo = { id: string; owned_by?: string };
export type ModelsResponse = { data: ModelInfo[] };

async function listMuseSparkModels(): Promise<ModelsResponse> {
  const response = await fetch(`${ENV.museSparkBaseUrl}/models`, {
    headers: { authorization: `Bearer ${resolveMuseSparkKey()}` },
  });
  if (!response.ok)
    throw new Error(`Muse Spark 모델 목록 조회 실패 (HTTP ${response.status})`);
  const payload = (await response.json()) as {
    data?: Array<{ id?: string; owned_by?: string }>;
  };
  return {
    data: (payload.data ?? [])
      .filter((model): model is { id: string; owned_by?: string } =>
        Boolean(model.id)
      )
      .map(model => ({ id: model.id, owned_by: model.owned_by ?? "meta" })),
  };
}

async function listGeminiModels(apiKey?: string): Promise<ModelsResponse> {
  const response = await fetch(`${GEMINI_BASE}/models`, {
    headers: { "x-goog-api-key": resolveGeminiKey(apiKey) },
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

/** Lists the models this key may call, used to verify a configured model ID exists. */
export async function listLLMModels(apiKey?: string): Promise<ModelsResponse> {
  return resolveProvider(apiKey) === "gemini"
    ? listGeminiModels(apiKey)
    : listMuseSparkModels();
}
