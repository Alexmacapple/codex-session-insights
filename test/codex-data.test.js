import test from 'node:test'
import assert from 'node:assert/strict'
import { filterSubstantiveThreads, summarizeThread } from '../lib/codex-data.js'

test('summarizeThread extracts tool, patch, git, and failure signals', () => {
  const thread = {
    id: 'thread-1',
    title: 'Fix rollout parser',
    firstUserMessage: 'Please fix the rollout parser and commit the change.',
    cwd: '/repo/project',
    model: 'gpt-5.4',
    modelProvider: 'openai',
    createdAt: Date.parse('2026-04-01T10:00:00Z') / 1000,
    updatedAt: Date.parse('2026-04-01T10:03:00Z') / 1000,
    tokensUsed: 999,
  }

  const patch = [
    '*** Begin Patch',
    '*** Update File: src/parser.js',
    '-const broken = true',
    '+const broken = false',
    '+export const fixed = true',
    '*** End Patch',
  ].join('\n')

  const events = [
    {
      timestamp: '2026-04-01T10:00:00Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Please fix the rollout parser.' },
    },
    {
      timestamp: '2026-04-01T10:00:10Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        content: [{ text: 'I am checking the parser flow.' }],
      },
    },
    {
      timestamp: '2026-04-01T10:00:20Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'apply_patch', arguments: patch },
    },
    {
      timestamp: '2026-04-01T10:00:30Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'spawn_agent', arguments: '{}' },
    },
    {
      timestamp: '2026-04-01T10:00:40Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'web.search_query', arguments: '{"q":"parser bug"}' },
    },
    {
      timestamp: '2026-04-01T10:01:00Z',
      type: 'event_msg',
      payload: {
        type: 'exec_command_end',
        parsed_cmd: [{ type: 'git_commit' }],
        command: ['git', 'commit', '-m', 'fix parser'],
        exit_code: 0,
        status: 'completed',
        duration: { secs: 1, nanos: 0 },
      },
    },
    {
      timestamp: '2026-04-01T10:02:00Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: 'Push it too if tests pass.',
      },
    },
    {
      timestamp: '2026-04-01T10:03:00Z',
      type: 'event_msg',
      payload: {
        type: 'exec_command_end',
        parsed_cmd: [{ type: 'git_push' }],
        command: ['git', 'push'],
        exit_code: 1,
        status: 'failed',
        aggregated_output: 'remote rejected the push',
        duration: { secs: 2, nanos: 0 },
      },
    },
    {
      timestamp: '2026-04-01T10:03:00Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 120,
            cached_input_tokens: 30,
            output_tokens: 20,
            reasoning_output_tokens: 5,
            total_tokens: 175,
          },
        },
      },
    },
  ]

  const summary = summarizeThread(thread, events)

  assert.equal(summary.userMessages, 2)
  assert.equal(summary.assistantMessages, 1)
  assert.equal(summary.totalToolCalls, 3)
  assert.equal(summary.totalCommandFailures, 1)
  assert.equal(summary.gitCommits, 1)
  assert.equal(summary.gitPushes, 1)
  assert.equal(summary.linesAdded, 2)
  assert.equal(summary.linesRemoved, 1)
  assert.equal(summary.filesModified, 1)
  assert.equal(summary.usesTaskAgent, true)
  assert.equal(summary.usesWebSearch, true)
  assert.deepEqual(summary.toolCounts, {
    apply_patch: 1,
    spawn_agent: 1,
    'web.search_query': 1,
  })
  assert.deepEqual(summary.toolFailures, { git_push: 1 })
  assert.match(summary.transcriptForAnalysis, /\[Tool: apply_patch\]/)
  assert.match(summary.transcriptForAnalysis, /\[Command failed: git_push\]/)
  assert.doesNotMatch(summary.transcriptForAnalysis, /I am checking the parser flow/)
  assert.deepEqual(summary.tokenUsage, {
    inputTokens: 120,
    cachedInputTokens: 30,
    outputTokens: 20,
    reasoningOutputTokens: 5,
    totalTokens: 175,
  })
})

test('filterSubstantiveThreads keeps only substantial threads and sorts by recency', () => {
  const threads = [
    { id: 'older', userMessages: 3, durationMinutes: 5, transcriptForAnalysis: 'ok', updatedAt: '2026-04-01T00:00:00.000Z' },
    { id: 'too-short', userMessages: 3, durationMinutes: 0.5, transcriptForAnalysis: 'ok', updatedAt: '2026-04-03T00:00:00.000Z' },
    { id: 'empty', userMessages: 3, durationMinutes: 5, transcriptForAnalysis: '   ', updatedAt: '2026-04-04T00:00:00.000Z' },
    { id: 'recent', userMessages: 2, durationMinutes: 1, transcriptForAnalysis: 'ok', updatedAt: '2026-04-05T00:00:00.000Z' },
  ]

  const filtered = filterSubstantiveThreads(threads)

  assert.deepEqual(
    filtered.map(thread => thread.id),
    ['recent', 'older'],
  )
})

test('summarizeThread compacts consecutive tool bursts in transcriptForAnalysis', () => {
  const thread = {
    id: 'thread-tools',
    title: 'Burst',
    firstUserMessage: 'Check the repo.',
    cwd: '/repo/project',
    model: 'gpt-5.4',
    modelProvider: 'openai',
    createdAt: Date.parse('2026-04-01T10:00:00Z') / 1000,
    updatedAt: Date.parse('2026-04-01T10:03:00Z') / 1000,
    tokensUsed: 100,
  }

  const events = [
    {
      timestamp: '2026-04-01T10:00:00Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Check the repo.' },
    },
    {
      timestamp: '2026-04-01T10:00:05Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'exec_command', arguments: '{}' },
    },
    {
      timestamp: '2026-04-01T10:00:06Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'apply_patch', arguments: '{}' },
    },
    {
      timestamp: '2026-04-01T10:00:07Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'web.search_query', arguments: '{}' },
    },
  ]

  const summary = summarizeThread(thread, events)

  assert.match(summary.transcriptForAnalysis, /\[Tool: exec_command\]/)
  assert.match(summary.transcriptForAnalysis, /\[Tool: apply_patch\]/)
  assert.match(summary.transcriptForAnalysis, /\[Tool activity truncated: 1 more tool calls\]/)
})

test('summarizeThread understands item_completed rollouts from newer Codex releases', () => {
  const thread = {
    id: 'thread-new',
    title: 'Add metering contract',
    firstUserMessage: 'Add the metering contract and commit it.',
    cwd: '/repo/project',
    model: 'gpt-5.6-sol',
    modelProvider: 'openai',
    createdAt: Date.parse('2026-09-12T12:44:00Z') / 1000,
    updatedAt: Date.parse('2026-09-12T12:50:00Z') / 1000,
    tokensUsed: 5000,
  }

  const item = (timestamp, item) => ({
    timestamp,
    type: 'event_msg',
    payload: { type: 'item_completed', thread_id: 'thread-new', turn_id: 'turn-1', item },
  })

  const events = [
    {
      timestamp: '2026-09-12T12:44:00Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '# AGENTS.md instructions (injected, not a user turn)' }],
      },
    },
    item('2026-09-12T12:44:01Z', {
      type: 'UserMessage',
      id: 'u1',
      content: [{ type: 'text', text: 'Add the metering contract and commit it.' }],
    }),
    {
      timestamp: '2026-09-12T12:44:05Z',
      type: 'response_item',
      payload: { type: 'reasoning', summary: [] },
    },
    item('2026-09-12T12:44:05Z', { type: 'Reasoning', id: 'r1', summary_text: [] }),
    {
      timestamp: '2026-09-12T12:44:06Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'output_text', text: 'Adding the contract now and wiring the test.' }],
      },
    },
    item('2026-09-12T12:44:06Z', {
      type: 'AgentMessage',
      id: 'm1',
      content: [{ type: 'Text', text: 'Adding the contract now and wiring the test.' }],
    }),
    {
      timestamp: '2026-09-12T12:44:07Z',
      type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'exec', status: 'completed', input: 'tools.exec_command(...)' },
    },
    item('2026-09-12T12:44:08Z', {
      type: 'CommandExecution',
      id: 'exec-1',
      command: ['/bin/zsh', '-lc', 'sed -n 1,40p docs/contract.md'],
      parsed_cmd: [{ type: 'read', cmd: 'sed -n 1,40p docs/contract.md' }],
      status: 'completed',
      exit_code: 0,
      duration: { secs: 0, nanos: 5000000 },
      aggregated_output: '...',
    }),
    item('2026-09-12T12:45:00Z', {
      type: 'FileChange',
      id: 'exec-2',
      status: 'completed',
      changes: {
        '/repo/project/docs/contract.md': {
          type: 'update',
          unified_diff: '@@ -1,2 +1,3 @@\n line\n+added one\n+added two\n-removed\n',
        },
        '/repo/project/tests/contract_test.cpp': { type: 'add', content: 'a\nb\nc\n' },
      },
    }),
    item('2026-09-12T12:45:30Z', {
      type: 'McpToolCall',
      id: 'mcp-1',
      server: 'node_repl',
      tool: 'js',
      status: 'completed',
    }),
    item('2026-09-12T12:45:40Z', {
      type: 'Extension',
      id: 'ext-1',
      kind: 'web.search',
      query: 'unified exec',
    }),
    item('2026-09-12T12:46:00Z', {
      type: 'CommandExecution',
      id: 'exec-3',
      command: ['/bin/zsh', '-lc', 'git commit -m "add contract"'],
      parsed_cmd: [{ type: 'unknown', cmd: 'git commit -m "add contract"' }],
      status: 'failed',
      exit_code: 1,
      duration: { secs: 1, nanos: 0 },
      aggregated_output: 'nothing to commit, working tree clean',
    }),
    {
      timestamp: '2026-09-12T12:46:05Z',
      type: 'event_msg',
      payload: { type: 'turn_aborted', turn_id: 'turn-1', reason: 'interrupted' },
    },
    item('2026-09-12T12:46:10Z', {
      type: 'UserMessage',
      id: 'u2',
      content: [{ type: 'text', text: 'Stop, stage the file first.' }],
    }),
    {
      timestamp: '2026-09-12T12:46:12Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'spawn_agent', namespace: 'collaboration', arguments: '{}' },
    },
    item('2026-09-12T12:46:12Z', {
      type: 'SubAgentActivity',
      id: 'call-1',
      kind: 'started',
      agent_thread_id: 'child',
      agent_path: '/root/helper',
    }),
    {
      timestamp: '2026-09-12T12:50:00Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 5000,
            cached_input_tokens: 4000,
            output_tokens: 300,
            reasoning_output_tokens: 50,
            total_tokens: 5300,
          },
        },
      },
    },
  ]

  const summary = summarizeThread(thread, events)

  assert.equal(summary.userMessages, 2)
  assert.equal(summary.assistantMessages, 1)
  assert.equal(summary.reasoningItems, 1)
  assert.equal(summary.durationMinutes, 6)
  assert.deepEqual(summary.toolCounts, {
    exec: 1,
    mcp__node_repl__js: 1,
    'web.search': 1,
    spawn_agent: 1,
  })
  assert.deepEqual(summary.commandKindCounts, { read: 1, unknown: 1 })
  assert.equal(summary.totalCommandFailures, 1)
  assert.equal(summary.commandFailures[0].output, 'nothing to commit, working tree clean')
  assert.equal(summary.gitCommits, 1)
  assert.equal(summary.linesAdded, 5)
  assert.equal(summary.linesRemoved, 1)
  assert.equal(summary.filesModified, 2)
  assert.equal(summary.userInterruptions, 1)
  assert.equal(summary.usesMcp, true)
  assert.equal(summary.usesWebSearch, true)
  assert.equal(summary.usesTaskAgent, true)
  assert.equal(summary.tokenUsage.totalTokens, 5300)
  assert.match(summary.transcriptForAnalysis, /^\[User\] Add the metering contract/)
  assert.match(summary.transcriptForAnalysis, /\[Command failed: unknown\] exit=1/)
  assert.doesNotMatch(summary.transcriptForAnalysis, /AGENTS\.md instructions/)
})
