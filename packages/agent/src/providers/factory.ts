import type { ChatProvider } from '../types.ts';
import { AnthropicProvider, type AnthropicProviderOptions } from './anthropic.ts';
import { OpenAICompatProvider, type OpenAICompatProviderOptions } from './openai-compat.ts';

export type ProviderConfig =
  | ({ kind: 'anthropic' } & AnthropicProviderOptions)
  | ({ kind: 'openai-compat' } & OpenAICompatProviderOptions);

/**
 * Creates a provider from plain config (e.g. editor settings):
 * `{ kind: 'anthropic', model: 'claude-opus-5', effort: 'high' }` or
 * `{ kind: 'openai-compat', baseURL: 'http://localhost:11434/v1', model: 'qwen3.8:27b' }`.
 */
export function createProvider(config: ProviderConfig): ChatProvider {
  switch (config.kind) {
    case 'anthropic': {
      const { kind: _kind, ...opts } = config;
      return new AnthropicProvider(opts);
    }
    case 'openai-compat': {
      const { kind: _kind, ...opts } = config;
      return new OpenAICompatProvider(opts);
    }
    default:
      throw new Error(`Unknown provider kind '${(config as { kind: string }).kind}'.`);
  }
}
