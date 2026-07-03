// halt-explainer unit tests (Dr. Kasky 2026-07-02). The Anthropic SDK + the key resolver are mocked so this
// exercises the mapping/contract WITHOUT a real model:
//   • a direct-framing-with-SC-upstream input reaches the model grounded with the direct theory + the upstream
//     SC condition (so the model CAN suggest reframing to secondary), and a secondary-suggesting tool result
//     passes straight through.
//   • an already-service-connected claimed condition reaches the model grounded so it can say "rating increase,
//     out of scope", and the rating-increase tool result passes through.
//   • anti-fabrication: the returned summary/what_to_do are EXACTLY the tool output — explainHalt adds nothing.
//   • it NEVER throws: an LLM error, a truncation, a malformed result, and a missing key all return null.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const createMock = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: (...args: unknown[]) => createMock(...args) };
  },
}));

const resolveKeyMock = vi.fn(async () => 'sk-test');
vi.mock('../letter-surgical-propose.js', () => ({ resolveAnthropicApiKey: () => resolveKeyMock() }));

// Import AFTER the mocks are registered.
const { explainHalt } = await import('../halt-explainer.js');

interface ToolInput {
  summary?: unknown;
  what_to_do?: unknown;
  confidence?: unknown;
}
function toolResp(input: ToolInput, stop_reason = 'end_turn') {
  return { stop_reason, content: [{ type: 'tool_use', name: 'explain_halt', input }] };
}

function directWithScUpstream() {
  return {
    phase: 'framing_gate',
    rawReason: 'framing declares DIRECT but names an SC condition as the upstream cause',
    claimedCondition: 'Obstructive sleep apnea',
    framing: { theory: 'direct', upstream: 'PTSD', cfr: '38 CFR 3.303' },
    grantedScConditions: [{ name: 'PTSD', ratingPct: 70 }],
    problemList: ['Obstructive sleep apnea', 'PTSD'],
    alreadyGrantedMatch: null,
  } as const;
}

/** The user prompt string sent to the model on the most recent call. */
function lastPrompt(): string {
  const call = createMock.mock.calls.at(-1)?.[0] as { messages?: Array<{ content?: unknown }> } | undefined;
  const content = call?.messages?.[0]?.content;
  return typeof content === 'string' ? content : '';
}

beforeEach(() => {
  createMock.mockReset();
  resolveKeyMock.mockReset();
  resolveKeyMock.mockResolvedValue('sk-test');
});

describe('explainHalt — mapping & grounding', () => {
  it('a DIRECT-with-SC-upstream halt is grounded (direct theory + upstream SC in the prompt) and a secondary-suggesting result passes through', async () => {
    createMock.mockResolvedValue(
      toolResp({
        summary: 'The draft paused because the claim is set up as direct, but the cause named is a service-connected condition. That makes it really a secondary claim.',
        what_to_do: 'Set the framing to Secondary and point it at PTSD.',
        confidence: 'high',
      }),
    );

    const res = await explainHalt(directWithScUpstream());

    expect(res).not.toBeNull();
    expect(res?.summary.toLowerCase()).toContain('secondary');
    expect(res?.what_to_do.toLowerCase()).toContain('secondary');
    expect(res?.confidence).toBe('high');

    // The model was actually given the grounding needed to make that mapping.
    const p = lastPrompt();
    expect(p).toContain('Obstructive sleep apnea');
    expect(p).toContain('PTSD');
    expect(p.toLowerCase()).toContain('direct');
  });

  it('an already-service-connected claimed condition is grounded so the model can call it a rating increase; the result passes through', async () => {
    createMock.mockResolvedValue(
      toolResp({
        summary: 'The condition being claimed is already service-connected, so there is nothing to write a nexus letter for — this would be a rating increase.',
        what_to_do: 'Re-route the case; do not reframe it.',
        confidence: 'high',
      }),
    );

    const res = await explainHalt({
      phase: 'plan_validity',
      rawReason: 'claimed condition already present on the granted SC list',
      claimedCondition: 'PTSD',
      framing: { theory: 'undetermined', upstream: null, cfr: null },
      grantedScConditions: [{ name: 'PTSD', ratingPct: 70 }],
      problemList: ['PTSD'],
      alreadyGrantedMatch: 'PTSD',
    });

    expect(res?.summary.toLowerCase()).toContain('rating increase');
    expect(res?.what_to_do.toLowerCase()).toContain('re-route');
    // Grounding: the claimed condition appears BOTH as the claim and on the SC list in the prompt, and the
    // deterministic already-granted determination is surfaced to the model as a stated fact.
    const p = lastPrompt();
    expect(p).toContain('PTSD');
    expect(p).toContain('<already_granted_match>PTSD</already_granted_match>');
  });

  it('anti-fabrication: the returned summary/what_to_do are EXACTLY the tool output (nothing added)', async () => {
    const summary = 'Plain summary with only provided facts.';
    const what_to_do = 'Do exactly this one step.';
    createMock.mockResolvedValue(toolResp({ summary, what_to_do, confidence: 'medium' }));

    const res = await explainHalt(directWithScUpstream());
    expect(res).toEqual({ summary, what_to_do, confidence: 'medium' });
  });

  it('normalizes an unknown/empty confidence to "medium"', async () => {
    createMock.mockResolvedValue(toolResp({ summary: 's', what_to_do: 'w', confidence: 'banana' }));
    const res = await explainHalt(directWithScUpstream());
    expect(res?.confidence).toBe('medium');
  });
});

describe('explainHalt — fail-open (never throws, returns null)', () => {
  it('returns null when the LLM call throws', async () => {
    createMock.mockRejectedValue(new Error('overloaded'));
    await expect(explainHalt(directWithScUpstream())).resolves.toBeNull();
  });

  it('returns null on a truncated (max_tokens) response', async () => {
    createMock.mockResolvedValue(toolResp({ summary: 's', what_to_do: 'w', confidence: 'low' }, 'max_tokens'));
    await expect(explainHalt(directWithScUpstream())).resolves.toBeNull();
  });

  it('returns null when the tool block is missing', async () => {
    createMock.mockResolvedValue({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'no tool' }] });
    await expect(explainHalt(directWithScUpstream())).resolves.toBeNull();
  });

  it('returns null when a required field is empty', async () => {
    createMock.mockResolvedValue(toolResp({ summary: '   ', what_to_do: 'w', confidence: 'high' }));
    await expect(explainHalt(directWithScUpstream())).resolves.toBeNull();
  });

  it('returns null (never throws) when the API key is unconfigured', async () => {
    resolveKeyMock.mockRejectedValue(new Error('ANTHROPIC_API_KEY or API_ANTHROPIC_KEY_SECRET_ARN is required'));
    await expect(explainHalt(directWithScUpstream())).resolves.toBeNull();
    expect(createMock).not.toHaveBeenCalled();
  });
});
