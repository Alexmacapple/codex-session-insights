import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyCommandFailure,
  inferCommandKind,
  extractCommandHead,
  extractShellScript,
  filterExcludedThreads,
  filterSubstantiveThreads,
  summarizeThread,
} from '../lib/codex-data.js'

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
  assert.deepEqual(summary.toolFailures, { 'git push': 1 })
  assert.deepEqual(summary.toolErrorCategories, { git_error: 1 })
  assert.equal(summary.commandFailures[0].category, 'git_error')
  assert.match(summary.transcriptForAnalysis, /\[Tool: apply_patch\]/)
  assert.match(summary.transcriptForAnalysis, /\[Command failed: git push \(git_error\)\]/)
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

test('filterExcludedThreads removes the active report thread without changing other sessions', () => {
  const threads = [{ id: 'older' }, { id: 'current' }, { id: 'newer' }]

  assert.deepEqual(filterExcludedThreads(threads, ['current']).map(thread => thread.id), [
    'older',
    'newer',
  ])
  assert.deepEqual(filterExcludedThreads(threads, []).map(thread => thread.id), [
    'older',
    'current',
    'newer',
  ])
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
  assert.deepEqual(summary.commandKindCounts, { read: 1, git_commit: 1 })
  assert.deepEqual(summary.commandCounts, { sed: 1, 'git commit': 1 })
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
  assert.deepEqual(summary.toolFailures, { 'git commit': 1 })
  assert.deepEqual(summary.toolErrorCategories, { git_error: 1 })
  assert.match(summary.transcriptForAnalysis, /\[Command failed: git commit \(git_error\)\] exit=1/)
  assert.doesNotMatch(summary.transcriptForAnalysis, /AGENTS\.md instructions/)
})

test('extractCommandHead groups by the program that ran, not the shell wrapper', () => {
  assert.equal(extractShellScript(['/bin/zsh', '-lc', 'git status --short']), 'git status --short')
  assert.equal(extractShellScript(['git', 'push', 'origin']), 'git push origin')
  assert.equal(extractCommandHead('cd repo && CI=1 npx vitest run'), 'vitest')
  assert.equal(extractCommandHead('set -o pipefail\ndeps/mise/bin/mise exec -- bun scripts/ci/run.ts'), 'bun scripts/ci/run.ts')
  assert.equal(extractCommandHead('rg --files apps | rg vehicle'), 'rg')
  assert.equal(extractCommandHead('task content-import:m0-verify'), 'task content-import:m0-verify')
  assert.equal(extractCommandHead('export FOO=1'), 'shell')
  // The exit code of a chain comes from its last command, and read-only
  // commands rarely fail, so attribution goes to the last "real" command.
  assert.equal(extractCommandHead("sed -n '1,40p' a.md && rg -n foo docs"), 'rg')
  assert.equal(extractCommandHead('cmake --build build && ctest --test-dir build'), 'ctest')
  assert.equal(extractCommandHead('git add -- a.cpp\ntask content-import:m0-verify'), 'task content-import:m0-verify')
  assert.equal(
    extractCommandHead("cat > src/x.ts <<'EOF'\nexport const A = 1\nimport { B } from './b'\nEOF\nnpm test"),
    'npm test',
  )
  assert.equal(extractCommandHead("python3 - <<'PY'\nimport sys\nprint(1)\nPY"), 'python3')
  assert.equal(
    extractCommandHead("python3 -c 'value = 1\nfrom pathlib import Path'"),
    'python3',
  )
  assert.equal(extractCommandHead("node -e 'const one = 1\nconst two = 2'"), 'node')
})

test('inferCommandKind replaces Codex unknown types with stable command categories', () => {
  const infer = (script, parsedType = 'unknown') =>
    inferCommandKind({ script, parsedType, head: extractCommandHead(script) })

  assert.equal(infer('git commit -m "fix parser"'), 'git_commit')
  assert.equal(infer('git push origin main'), 'git_push')
  assert.equal(infer('rg -n parser lib'), 'search')
  assert.equal(infer("sed -n '1,40p' lib/parser.js"), 'read')
  assert.equal(infer('npm test'), 'test')
  assert.equal(infer("python3 - <<'PY'\nprint('ok')\nPY"), 'script')
  assert.equal(infer('pdftotext input.pdf output.txt'), 'document')
  assert.equal(infer('unzip bundle.zip'), 'archive')
  assert.equal(infer('ffmpeg -i input.mov output.mp4'), 'media')
  assert.equal(infer('vnu index.html'), 'validation')
  assert.equal(infer('sqlite3 state.sqlite .schema'), 'database')
  assert.equal(infer('codex exec --json prompt'), 'agent_tool')
  assert.equal(infer('mktemp -d'), 'system')
  assert.equal(infer('rsync -a source/ target/'), 'sync')
  assert.equal(infer('anything', 'list_files'), 'list_files')
  assert.equal(infer('python3 script.py', 'python3 script.py'), 'script')
})

test('classifyCommandFailure maps exit codes and output into causes', () => {
  const classify = (script, exitCode, output, parsedType = 'unknown') =>
    classifyCommandFailure({
      script,
      head: extractCommandHead(script),
      parsedType,
      exitCode,
      status: 'failed',
      output,
    })

  assert.equal(classify('rg -n foo src', 1, '', 'search'), 'no_match')
  assert.equal(classify("sed -n '1,40p' a.md && rg -n foo docs", 1, '# heading\nsome file content'), 'no_match')
  assert.equal(classify("sed -n '1,40p' a.md\nrg -n foo docs", 2, 'rg: docs: No such file or directory (os error 2)'), 'missing_file_or_module')
  assert.equal(classify('test -f missing.txt', 1, ''), 'no_match')
  assert.equal(classify('cmp expected.txt actual.txt', 1, ''), 'expected_difference')
  assert.equal(classify('git diff --quiet', 1, ''), 'expected_difference')
  assert.equal(classify('find missing-root -name "*.js"', 1, ''), 'unclassified')
  assert.equal(classify('ls nope', 1, 'ls: nope: No such file or directory', 'list_files'), 'missing_file_or_module')
  assert.equal(classify('git merge origin/main', 1, 'CONFLICT (content): Merge conflict in a.c'), 'git_error')
  assert.equal(classify('npm test', 1, 'FAIL src/a.test.js\n1 failed, 3 passed'), 'test_failed')
  assert.equal(classify('cmake --build build && ctest --test-dir build', 8, '1/3 Test #5: Foo ... (Failed)'), 'test_failed')
  assert.equal(classify('cargo build', 101, 'error[E0308]: mismatched types'), 'build_failed')
  assert.equal(classify('git diff --check', 2, 'docs/x.md:38: trailing whitespace.'), 'lint_failed')
  assert.equal(classify('task format-check', 200, 'task: Available tasks for this project:\n* ac'), 'usage_error')
  assert.equal(classify('foo --bar', 127, 'zsh: command not found: foo'), 'command_not_found')
  assert.equal(classify('sleep 100', 130, ''), 'interrupted')
  assert.equal(classify('curl https://example.invalid', 6, 'curl: (6) Could not resolve host'), 'network_error')
  assert.equal(classify('python3 -c "import x"', 1, 'Traceback\nModuleNotFoundError: No module named x'), 'missing_file_or_module')
  assert.equal(classify('./godot --path x', 1, 'ERROR: `--path` was specified but this binary lacks support'), 'runtime_error')
  assert.equal(classify('./run.sh', 3, ''), 'unclassified')
})

test('summarizeThread separates expected and recovered checks from operational errors', () => {
  const thread = {
    id: 'thread-turns',
    title: 'Turn timing',
    firstUserMessage: 'Find usages.',
    cwd: '/repo/project',
    model: 'gpt-5.4',
    modelProvider: 'openai',
    createdAt: Date.parse('2026-04-01T10:00:00Z') / 1000,
    updatedAt: Date.parse('2026-04-01T12:00:00Z') / 1000,
    tokensUsed: 100,
  }

  const exec = (timestamp, script, exitCode, output = '', parsedType = 'unknown') => ({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: {
        type: 'CommandExecution',
        command: ['/bin/zsh', '-lc', script],
        parsed_cmd: [{ type: parsedType, cmd: script }],
        status: exitCode === 0 ? 'completed' : 'failed',
        exit_code: exitCode,
        aggregated_output: output,
      },
    },
  })
  const assistant = (timestamp, phase, text) => ({
    timestamp,
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', phase, content: [{ type: 'output_text', text }] },
  })

  const events = [
    { timestamp: '2026-04-01T10:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: 'Find usages.' } },
    exec('2026-04-01T10:00:05Z', 'rg -n usages src', 1, '', 'search'),
    exec('2026-04-01T10:00:10Z', 'npm test', 1, '2 failed, 1 passed'),
    exec('2026-04-01T10:00:15Z', 'npm run lint', 1, 'lint error'),
    assistant('2026-04-01T10:01:00Z', 'final_answer', 'Nothing found; one test fails.'),
    // The user walks away for 90 minutes: idle time, not active time.
    { timestamp: '2026-04-01T11:31:00Z', type: 'event_msg', payload: { type: 'user_message', message: 'Fix the test.' } },
    exec('2026-04-01T11:31:30Z', 'npm test', 0),
    assistant('2026-04-01T11:33:00Z', 'final_answer', 'Fixed.'),
  ]

  const summary = summarizeThread(thread, events)

  assert.equal(summary.toolErrors, 1)
  assert.equal(summary.totalCommandFailures, 1)
  assert.equal(summary.benignCommandMisses, 1)
  assert.equal(summary.expectedCommandOutcomes, 2)
  assert.deepEqual(summary.expectedCommandOutcomeCategories, { no_match: 1, recovered_check: 1 })
  assert.deepEqual(summary.toolErrorCategories, { lint_failed: 1 })
  assert.deepEqual(summary.toolFailures, { 'npm run': 1 })
  assert.doesNotMatch(summary.transcriptForAnalysis, /Command failed: rg/)
  assert.match(summary.transcriptForAnalysis, /Command check recovered: npm test/)
  assert.deepEqual(summary.turnDurationsSeconds, [60, 120])
  assert.equal(summary.medianTurnSeconds, 120)
  assert.equal(summary.durationMinutes, 93)
  assert.equal(summary.activeMinutes, 3)
})
