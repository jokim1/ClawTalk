import { BUILTIN_ADDITIONAL_PROVIDERS } from '../agents/builtin-additional-providers.js';

export interface ModelCapabilities {
  supports_tools: boolean;
  supports_streaming: boolean;
  supports_vision: boolean;
  /**
   * Whether the model accepts native PDF document blocks on the user
   * turn (so the model sees both the text layer AND page imagery in
   * one shot). Distinct from `supports_vision` because a model can
   * accept image_url inputs without accepting PDF document inputs —
   * Codex Responses image-vision support shipped before its
   * `input_file` support, for example. Models without this flag fall
   * back to text-only via `unpdf`-extracted `extracted_text` on the
   * source row.
   */
  supports_pdf_documents: boolean;
  supports_json_schema: boolean;
  supports_long_context: boolean;
  extra?: Record<string, unknown>;
}

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  supports_tools: false,
  supports_streaming: true,
  supports_vision: false,
  supports_pdf_documents: false,
  supports_json_schema: false,
  supports_long_context: false,
};

export function normalizeCapabilities(
  value: Partial<ModelCapabilities> | undefined,
): ModelCapabilities {
  return {
    ...DEFAULT_CAPABILITIES,
    ...value,
  };
}

const BUILTIN_PROVIDER_MODEL_CAPABILITIES = new Map(
  BUILTIN_ADDITIONAL_PROVIDERS.flatMap((provider) =>
    provider.models.map((model) => [
      `${provider.id}:${model.modelId}`,
      normalizeCapabilities({
        supports_vision: model.supportsVision === true,
      }),
    ]),
  ),
);

export function resolveModelCapabilities(input: {
  providerId: string;
  modelId: string;
}): ModelCapabilities {
  if (input.providerId === 'provider.openai_codex') {
    return normalizeCapabilities({
      supports_tools: true,
      supports_vision: true,
      supports_pdf_documents: true,
      supports_long_context: true,
    });
  }

  if (
    input.providerId === 'provider.anthropic' &&
    input.modelId.startsWith('claude-')
  ) {
    return normalizeCapabilities({
      supports_tools: true,
      supports_vision: true,
      supports_pdf_documents: true,
      supports_long_context: true,
    });
  }

  return (
    BUILTIN_PROVIDER_MODEL_CAPABILITIES.get(
      `${input.providerId}:${input.modelId}`,
    ) || normalizeCapabilities(undefined)
  );
}

export function modelSupportsVision(
  providerId: string,
  modelId: string,
): boolean {
  return resolveModelCapabilities({ providerId, modelId }).supports_vision;
}

export function modelSupportsPdfDocuments(
  providerId: string,
  modelId: string,
): boolean {
  return resolveModelCapabilities({ providerId, modelId })
    .supports_pdf_documents;
}
