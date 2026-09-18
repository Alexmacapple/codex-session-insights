import test from 'node:test'
import assert from 'node:assert/strict'
import { __test as providerTest } from '../lib/model-provider.js'

test('parseFirstJsonObject extracts and repairs wrapped JSON', () => {
  const parsed = providerTest.parseFirstJsonObject(
    'preamble\n{"headline":"Line 1\nLine 2","detail":"ok"}\ntrailer',
  )

  assert.deepEqual(parsed, {
    headline: 'Line 1\nLine 2',
    detail: 'ok',
  })
})

test('extractCodexExecResult returns final agent text and normalized usage', () => {
  const stdout = [
    '{"type":"item.completed","item":{"type":"agent_message","text":"draft"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"final answer"}}',
    '{"type":"turn.completed","usage":{"input_tokens":120,"cached_input_tokens":30,"output_tokens":12}}',
  ].join('\n')

  const result = providerTest.extractCodexExecResult(stdout)

  assert.equal(result.text, 'final answer')
  assert.deepEqual(result.usage, {
    inputTokens: 120,
    cachedInputTokens: 30,
    outputTokens: 12,
    totalTokens: 162,
  })
})

test('extractCodexExecResult surfaces turn.failed errors with the nested API message', () => {
  const apiError = JSON.stringify({
    type: 'error',
    status: 400,
    error: {
      type: 'invalid_request_error',
      message: "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.",
    },
  })
  const stdout = [
    '{"type":"thread.started","thread_id":"t1"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `gpt-5.4` not found."}}',
    '{"type":"turn.started"}',
    JSON.stringify({ type: 'error', message: apiError }),
    JSON.stringify({ type: 'turn.failed', error: { message: apiError } }),
  ].join('\n')

  const result = providerTest.extractCodexExecResult(stdout)

  assert.equal(result.text, '')
  assert.equal(
    result.error,
    "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.",
  )
})

test('buildModelCandidates dedupes primary and fallback models', () => {
  assert.deepEqual(
    providerTest.buildModelCandidates('gpt-5.6-luna', [
      'gpt-5.6-sol',
      'gpt-6-astra',
      'gpt-5.6-sol',
    ]),
    ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-6-astra'],
  )
})

test('isRetryableModelError matches unavailable model failures', () => {
  assert.equal(
    providerTest.isRetryableModelError(
      new Error('Model gpt-5.3-codex-spark not available for this account'),
    ),
    true,
  )
  assert.equal(
    providerTest.isRetryableModelError(
      new Error(
        "codex exec failed: The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.",
      ),
    ),
    true,
  )
  assert.equal(
    providerTest.isRetryableModelError(new Error('Unexpected JSON parse failure')),
    false,
  )
})
