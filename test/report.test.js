import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { buildReport, renderTerminalSummary, writeReportFiles } from '../lib/report.js'
import { createSampleReport } from './fixtures/sample-report.js'

function makeSummary(overrides = {}) {
  return {
    id: 'thread-1',
    title: 'Fix parser',
    firstUserMessage: 'Fix parser issue',
    cwd: '/repo/project-a',
    model: 'gpt-6-astra',
    modelProvider: 'openai',
    createdAt: '2026-04-01T10:00:00.000Z',
    updatedAt: '2026-04-02T10:00:00.000Z',
    durationMinutes: 30,
    userMessages: 4,
    assistantMessages: 3,
    commentaryMessages: 2,
    finalMessages: 1,
    reasoningItems: 1,
    toolCounts: { apply_patch: 2, exec_command: 1 },
    commandKindCounts: { git_commit: 1 },
    commandCounts: { 'git commit': 1 },
    toolFailures: { 'git push': 1 },
    totalToolCalls: 3,
    totalCommandFailures: 1,
    commandFailures: [],
    commandSamples: [],
    averageCommandDurationMs: 1200,
    activeMinutes: 20,
    benignCommandMisses: 3,
    expectedCommandOutcomes: 3,
    expectedCommandOutcomeCategories: { no_match: 3 },
    turnDurationsSeconds: [30, 90, 120],
    medianTurnSeconds: 90,
    medianUserReplyGapSeconds: 45,
    activeHours: [10, 11],
    userMessageTimestamps: ['2026-04-02T10:00:00.000Z'],
    transcriptForAnalysis: '[User] Fix parser',
    gitCommits: 1,
    gitPushes: 0,
    userInterruptions: 1,
    toolErrors: 1,
    toolErrorCategories: { git_error: 1 },
    usesTaskAgent: true,
    usesMcp: false,
    usesWebSearch: true,
    usesWebFetch: false,
    linesAdded: 12,
    linesRemoved: 4,
    filesModified: 2,
    tokenUsage: {
      inputTokens: 120,
      cachedInputTokens: 30,
      outputTokens: 22,
      reasoningOutputTokens: 5,
      totalTokens: 177,
    },
    ...overrides,
  }
}

test('buildReport aggregates summary metrics and terminal output', () => {
  const report = buildReport(
    [
      makeSummary(),
      makeSummary({
        id: 'thread-2',
        cwd: '/repo/project-b',
        model: 'gpt-5.6-luna',
        createdAt: '2026-04-03T10:00:00.000Z',
        updatedAt: '2026-04-04T10:00:00.000Z',
        totalCommandFailures: 0,
        toolFailures: {},
        toolErrorCategories: {},
        totalToolCalls: 1,
        toolCounts: { 'web.search_query': 1 },
        commandKindCounts: {},
        userMessageTimestamps: ['2026-04-04T10:00:00.000Z'],
        tokenUsage: {
          inputTokens: 80,
          cachedInputTokens: 0,
          outputTokens: 10,
          reasoningOutputTokens: 0,
          totalTokens: 90,
        },
      }),
    ],
    {
      codexHome: '/tmp/.codex',
      days: 30,
      threadPreviewLimit: 10,
      insightsOverride: {
        at_a_glance: {
          whats_working: 'Strong editing loops.',
          whats_hindering: 'A few failed pushes.',
          quick_wins: 'Add more repo memory.',
          ambitious_workflows: 'Try parallel agents.',
        },
      },
      facets: [],
    },
  )

  report.analysisUsage = {
    calls: 5,
    inputTokens: 1000,
    cachedInputTokens: 200,
    outputTokens: 100,
    totalTokens: 1300,
    byModel: [],
    byStage: [],
  }
  report.analysisEstimate = {
    estimatedTotalTokens: 1200,
    estimatedRange: { low: 1000, high: 1600 },
  }

  assert.equal(report.metadata.threadCount, 2)
  assert.deepEqual(report.metadata.facetCoverage, { labeledThreads: 0, totalThreads: 2, share: 0 })
  assert.equal(report.summary.totalUserMessages, 8)
  assert.equal(report.summary.totalActiveHours, 0.7)
  assert.equal(report.summary.totalDurationHours, 1)
  assert.equal(report.summary.totalBenignMisses, 6)
  assert.equal(report.summary.totalExpectedCommandOutcomes, 6)
  assert.equal(report.summary.turnCount, 6)
  assert.equal(report.summary.medianTurnSeconds, 90)
  assert.equal(report.summary.p90TurnSeconds, 120)
  assert.equal(report.summary.totalTokens, 267)
  assert.equal(report.summary.sessionsUsingTaskAgent, 2)
  assert.equal(report.charts.projects[0].value, 1)

  const terminal = renderTerminalSummary(report)
  assert.match(terminal, /Codex Insights/)
  assert.match(terminal, /0\.7h active/)
  assert.match(terminal, /Analysis cost: 1.3K tokens across 5 model calls/)
  assert.match(terminal, /Estimate vs Actual: 1.2K tokens -> 0.9K tokens \(fresh\)/)
  assert.match(terminal, /Top Projects:/)
  assert.match(terminal, /Model Mix:/)
})

test('buildReport reconciles historical loops as resolved, still open, or unverifiable', () => {
  const threads = [
    makeSummary({ id: 'source-resolved', updatedAt: '2026-04-01T10:00:00.000Z' }),
    makeSummary({ id: 'resolution', updatedAt: '2026-04-03T10:00:00.000Z' }),
    makeSummary({ id: 'source-open', updatedAt: '2026-04-04T10:00:00.000Z' }),
  ]
  const facets = [
    {
      threadId: 'source-resolved',
      cwd: '/repo/project-a',
      updatedAt: '2026-04-01T10:00:00.000Z',
      outcome: 'partially_achieved',
      unfinished_work: 'The report was not generated.',
    },
    {
      threadId: 'resolution',
      cwd: '/repo/project-a',
      updatedAt: '2026-04-03T10:00:00.000Z',
      outcome: 'fully_achieved',
      unfinished_work: 'none',
      brief_summary: 'The report was generated and checked.',
    },
    {
      threadId: 'source-open',
      cwd: '/repo/project-a',
      updatedAt: '2026-04-04T10:00:00.000Z',
      outcome: 'partially_achieved',
      unfinished_work: 'The parser coverage is still incomplete.',
    },
  ]
  const report = buildReport(threads, {
    facets,
    insightsOverride: {
      at_a_glance: {},
      open_loops: {
        intro: 'Historical unfinished work reconciled with later sessions.',
        items: [
          {
            title: 'Generate report',
            project: '/repo/project-a',
            thread_title: 'Initial report run',
            source_thread_id: 'source-resolved',
            resolution_thread_id: 'resolution',
            resolution_evidence: 'The report was generated and checked.',
            what_is_left: 'The report was not generated in the source session.',
            evidence: 'The source facet was partial.',
          },
          {
            title: 'Complete parser coverage',
            project: '/repo/project-a',
            thread_title: 'Parser follow-up',
            source_thread_id: 'source-open',
            resolution_thread_id: '',
            resolution_evidence: '',
            what_is_left: 'Coverage is incomplete.',
            evidence: 'The latest source facet remains partial.',
          },
          {
            title: 'External deployment',
            project: '/repo/elsewhere',
            thread_title: 'Missing source',
            source_thread_id: 'missing-thread',
            resolution_thread_id: '',
            resolution_evidence: '',
            what_is_left: 'Deployment state is unknown.',
            evidence: 'No local session can prove the state.',
          },
          {
            title: 'Unsupported resolution claim',
            project: '/repo/project-a',
            thread_title: 'Initial report run',
            source_thread_id: 'source-resolved',
            resolution_thread_id: 'resolution',
            resolution_evidence: 'A different task was completed.',
            what_is_left: 'The report was not generated in the source session.',
            evidence: 'The source facet was partial.',
          },
          {
            title: 'Later project activity without resolution proof',
            project: '/repo/project-a',
            thread_title: 'Initial report run',
            source_thread_id: 'source-resolved',
            resolution_thread_id: '',
            resolution_evidence: '',
            what_is_left: 'The report was not generated in the source session.',
            evidence: 'A later project session exists, but no exact resolution was cited.',
          },
        ],
      },
    },
  })

  assert.deepEqual(
    report.insights.open_loops.items.map(item => item.status),
    ['resolved', 'still_open', 'unverifiable', 'unverifiable', 'unverifiable'],
  )
  assert.match(report.insights.open_loops.items[0].reconciliation_evidence, /resolution/)
})

test('writeReportFiles writes JSON and HTML outputs', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-session-insights-test-'))
  const report = buildReport([makeSummary()], {
    insightsOverride: {
      at_a_glance: {
        whats_working: 'Strong editing loops.',
        whats_hindering: 'A few failed pushes.',
        quick_wins: 'Add more repo memory.',
        ambitious_workflows: 'Try parallel agents.',
      },
      project_areas: { areas: [] },
      interaction_style: { narrative: 'You iterate quickly.', key_pattern: 'Fast refinement' },
      what_works: { intro: 'Good flow.', impressive_workflows: [] },
      friction_analysis: { intro: 'Some friction.', categories: [] },
      suggestions: {
        agents_md_additions: [
          {
            addition: 'Capture repo release rules in AGENTS.md.',
            why: 'This removes repeated context restatement.',
            prompt_scaffold: 'Add under a Release section.',
          },
        ],
        features_to_try: [
          {
            feature: 'Skills',
            one_liner: 'Reusable repo workflows.',
            why_for_you: 'You repeat the same validation flow.',
            example_code: 'Create a release-readiness skill and run it before publish.',
          },
        ],
        usage_patterns: [
          {
            title: 'Scope-lock release changes',
            suggestion: 'Start by inspecting the publish boundary.',
            detail: 'This prevents late cleanup.',
            copyable_prompt: 'Inspect package.json, README, and publish files first.',
          },
        ],
      },
      on_the_horizon: {
        intro: 'More automation.',
        opportunities: [
          {
            title: 'Parallel release prep',
            whats_possible: 'Split docs and package validation.',
            how_to_try: 'Use sub-agents for bounded parallel passes.',
            copyable_prompt: 'Spawn one worker for docs and one for package metadata.',
          },
        ],
      },
      open_loops: {
        intro: 'One thread ended without confirmed completion.',
        items: [
          {
            title: 'envmap acceptance',
            project: '/repo/project-a',
            thread_title: 'Fix parser',
            what_is_left: 'Visual acceptance was never confirmed.',
            evidence: 'unfinished_work: visual acceptance not confirmed',
          },
        ],
      },
      fun_ending: { headline: 'A good save', detail: 'Recovered a broken patch.' },
    },
    facets: [
      {
        threadId: 'thread-1',
        outcome: 'partially_achieved',
        session_type: 'single_task',
        unfinished_work: 'visual acceptance not confirmed',
      },
    ],
  })
  report.analysisUsage = {
    calls: 3,
    inputTokens: 900,
    cachedInputTokens: 100,
    outputTokens: 80,
    totalTokens: 1080,
    byModel: [],
    byStage: [],
  }
  report.analysisEstimate = {
    estimatedTotalTokens: 1000,
    estimatedRange: { low: 800, high: 1350 },
  }

  const { jsonPath, htmlPath } = await writeReportFiles(report, { outDir: tempDir })
  const html = await fs.readFile(htmlPath, 'utf8')
  const json = JSON.parse(await fs.readFile(jsonPath, 'utf8'))

  assert.match(html, /At a Glance/)
  assert.match(html, /Strong editing loops\./)
  assert.match(html, /Median Turn/)
  assert.match(html, /1m 30s/)
  assert.match(html, /Based only on 1 of 1 labeled threads|Based on LLM labels for all 1 threads/)
  assert.match(html, /Git operation failed/)
  assert.match(html, /Top Commands/)
  assert.match(html, /git commit/)
  assert.match(html, /Expected Command Outcomes/)
  assert.match(html, /Open Loops/)
  assert.match(html, /envmap acceptance/)
  assert.match(html, /Unverifiable/)
  assert.match(html, /Reconciliation evidence/)
  assert.doesNotMatch(html, /Avg Response/)
  assert.match(html, /Copy All Checked/)
  assert.match(html, /Paste into Codex:/)
  assert.match(html, /Estimate vs Actual/)
  assert.equal(json.insights.at_a_glance.quick_wins, 'Add more repo memory.')
})

test('sample report fixture generates stable HTML output', async () => {
  const firstDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-session-insights-sample-a-'))
  const secondDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-session-insights-sample-b-'))

  const first = await writeReportFiles(createSampleReport(), { outDir: firstDir })
  const second = await writeReportFiles(createSampleReport(), { outDir: secondDir })

  const firstHtml = await fs.readFile(first.htmlPath, 'utf8')
  const secondHtml = await fs.readFile(second.htmlPath, 'utf8')

  assert.equal(firstHtml, secondHtml)
  assert.match(firstHtml, /The report started testing itself/)
  assert.match(firstHtml, /Snapshot report validation/)
  assert.match(firstHtml, /Existing Codex Features to Try/)
})
