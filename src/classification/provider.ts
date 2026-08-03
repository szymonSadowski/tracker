/**
 * The classification provider (design.md D6).
 *
 * The one module in the codebase that imports `@anthropic-ai/sdk`. Everything above it talks to
 * the `ClassificationProvider` interface, which is what keeps the deterministic product working
 * with the provider unreachable — and what lets the tests run the whole classification path with
 * no network at all.
 *
 * Classification is high-volume, entirely latency-insensitive, and has a small closed output
 * space, so it runs through Message Batches: half the standard price, results keyed by
 * `custom_id`, and a shape that matches how the work actually arrives.
 */
import Anthropic from '@anthropic-ai/sdk';
import { CLASSIFICATION_MODEL, isWorkType, type WorkType } from './model';
import { INSTRUCTION_PREFIX, WORK_TYPE_SCHEMA } from './prompt';

export interface ClassificationRequest {
  /** The pull request id. Results arrive in any order and are matched back by this. */
  customId: string;
  content: string;
}

export interface ClassificationSuccess {
  customId: string;
  status: 'classified';
  workType: WorkType;
  confidence: number;
  rationale: string;
}

export interface ClassificationFailure {
  customId: string;
  status: 'failed';
  reason: string;
}

export type ClassificationOutcome = ClassificationSuccess | ClassificationFailure;

export interface ClassificationProvider {
  submit(requests: readonly ClassificationRequest[]): Promise<{ batchId: string }>;
  /** True once the batch has finished processing. */
  ended(batchId: string): Promise<boolean>;
  results(batchId: string): Promise<ClassificationOutcome[]>;
}

/** Tokens per request, generously bounded: the output is three short fields. */
export const MAX_TOKENS_PER_CLASSIFICATION = 512;

/**
 * Interpret one model result. An out-of-set type, a malformed payload, or a missing field is a
 * failure — never coerced into the nearest valid type (spec: "The model returns an unrecognized
 * type").
 */
export function interpretResult(customId: string, raw: unknown): ClassificationOutcome {
  if (raw === null || typeof raw !== 'object') {
    return { customId, status: 'failed', reason: 'Model returned no structured output' };
  }
  const value = raw as { type?: unknown; confidence?: unknown; rationale?: unknown };
  if (!isWorkType(value.type)) {
    return {
      customId,
      status: 'failed',
      reason: `Model returned work type outside the fixed set: ${String(value.type)}`,
    };
  }
  const confidence = typeof value.confidence === 'number' ? value.confidence : null;
  if (confidence === null || Number.isNaN(confidence)) {
    return { customId, status: 'failed', reason: 'Model returned no usable confidence' };
  }
  return {
    customId,
    status: 'classified',
    workType: value.type,
    confidence: Math.min(1, Math.max(0, confidence)),
    rationale: typeof value.rationale === 'string' ? value.rationale : '',
  };
}

export class AnthropicClassificationProvider implements ClassificationProvider {
  private readonly client: Anthropic;

  constructor(options: { apiKey?: string; client?: Anthropic } = {}) {
    this.client = options.client ?? new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});
  }

  async submit(requests: readonly ClassificationRequest[]): Promise<{ batchId: string }> {
    const batch = await this.client.messages.batches.create({
      requests: requests.map((request) => ({
        custom_id: request.customId,
        params: {
          model: CLASSIFICATION_MODEL,
          max_tokens: MAX_TOKENS_PER_CLASSIFICATION,
          // The instruction block is byte-identical across every request in every batch, and
          // carries the cache breakpoint. The per-pull-request content follows it, in the user
          // turn, where a change costs nothing already cached.
          system: [
            {
              type: 'text',
              text: INSTRUCTION_PREFIX,
              cache_control: { type: 'ephemeral' },
            },
          ],
          // A schema-constrained enum makes "the set is closed" the normal path rather than a
          // validation branch. Low effort: the judgement is a short one over a small space.
          output_config: {
            effort: 'low',
            format: { type: 'json_schema', schema: WORK_TYPE_SCHEMA },
          },
          messages: [{ role: 'user', content: request.content }],
        },
      })),
    });
    return { batchId: batch.id };
  }

  async ended(batchId: string): Promise<boolean> {
    const batch = await this.client.messages.batches.retrieve(batchId);
    return batch.processing_status === 'ended';
  }

  async results(batchId: string): Promise<ClassificationOutcome[]> {
    const outcomes: ClassificationOutcome[] = [];
    for await (const entry of await this.client.messages.batches.results(batchId)) {
      if (entry.result.type !== 'succeeded') {
        outcomes.push({
          customId: entry.custom_id,
          status: 'failed',
          reason: `Batch request ${entry.result.type}`,
        });
        continue;
      }
      const block = entry.result.message.content.find((item) => item.type === 'text');
      if (!block || block.type !== 'text') {
        outcomes.push({
          customId: entry.custom_id,
          status: 'failed',
          reason: 'Model returned no text content',
        });
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(block.text);
      } catch {
        outcomes.push({
          customId: entry.custom_id,
          status: 'failed',
          reason: 'Model output was not valid JSON',
        });
        continue;
      }
      outcomes.push(interpretResult(entry.custom_id, parsed));
    }
    return outcomes;
  }
}
