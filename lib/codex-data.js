import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_TRANSCRIPT_CHARS = 30000
const USER_TRANSCRIPT_LIMIT = 500
const ASSISTANT_TRANSCRIPT_LIMIT = 300
const FAILURE_SUMMARY_LIMIT = 120
const MAX_TOOL_LINES_PER_BURST = 2
const LOW_SIGNAL_ASSISTANT_PATTERNS = [
  /^i('| a)?m\s+(checking|looking|reviewing|reading|investigating)\b/i,
  /^i('| wi)?ll\s+(check|look|review|inspect|read|investigate|start by)\b/i,
  /^let me\b/i,
  /^(checking|reviewing|reading|looking at|investigating)\b/i,
  /^(next|now)\b/i,
]
const TASK_AGENT_TOOLS = new Set([
  'spawn_agent',
  'send_input',
  'send_message',
  'wait_agent',
  'resume_agent',
  'close_agent',
  'list_agents',
  'interrupt_agent',
  'followup_task',
])
// Gaps between consecutive rollout events longer than this are treated as
// idle time (the user walked away, a thread was left open) and excluded
// from activeMinutes.
const IDLE_GAP_MS = 30 * 60 * 1000
// Tokens that wrap the real command and should be skipped when picking the
// command head used for failure hotspots.
const COMMAND_WRAPPERS = new Set([
  'sudo',
  'time',
  'env',
  'nohup',
  'nice',
  'command',
  'exec',
  'npx',
  'bunx',
  'pnpx',
  'mise',
  'uv',
  'uvx',
  'poetry',
  'pipx',
  'xvfb-run',
  'caffeinate',
  'timeout',
  'gtimeout',
  'run',
])
// Shell builtins and no-op heads that never explain a failure on their own.
const COMMAND_SKIP_HEADS = new Set([
  'cd',
  'set',
  'export',
  'unset',
  'echo',
  'printf',
  'true',
  'false',
  'pushd',
  'popd',
  'source',
  '.',
  '{',
  '(',
  'if',
  'then',
  'else',
  'fi',
  'for',
  'do',
  'done',
  'while',
  'ulimit',
  'trap',
  'shopt',
  'setopt',
  'local',
  'exit',
  'return',
  'sleep',
  'wait',
])
// Heads whose first sub-command is informative (git push vs git merge).
const COMMAND_SUBCOMMAND_HEADS = new Set([
  'git',
  'gh',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'cargo',
  'go',
  'task',
  'docker',
  'kubectl',
  'pip',
  'pip3',
  'brew',
  'make',
  'just',
])
// Probe-style commands where exit code 1 means "nothing found", not an error.
const PROBE_HEADS = new Set(['rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack', 'fd', 'test', '[', '[[', 'diff', 'cmp', 'which', 'type'])
const SEARCH_HEADS = new Set(['rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack', 'fd', 'find', 'locate'])
const LIST_HEADS = new Set(['ls', 'tree'])
const SCRIPT_HEADS = new Set([
  'bash',
  'dash',
  'fish',
  'ksh',
  'node',
  'osascript',
  'perl',
  'php',
  'python',
  'python3',
  'ruby',
  'sh',
  'zsh',
])
const FILE_CHANGE_HEADS = new Set(['apply_patch', 'cp', 'install', 'ln', 'mkdir', 'mv', 'rm', 'rmdir', 'touch'])
const NETWORK_HEADS = new Set(['curl', 'scp', 'sftp', 'ssh', 'wget'])
const DOCUMENT_HEADS = new Set(['pandoc', 'pdfinfo', 'pdftoppm', 'pdftotext', 'soffice'])
const ARCHIVE_HEADS = new Set(['tar', 'unzip', 'zip', 'zipinfo'])
const MEDIA_HEADS = new Set(['cwebp', 'ffmpeg', 'ffprobe', 'sips'])
const VALIDATION_HEADS = new Set(['vnu', 'xmllint'])
const DATABASE_HEADS = new Set(['psql', 'sqlite3'])
const AGENT_TOOL_HEADS = new Set(['claude', 'codegraph', 'codex'])
const SYSTEM_HEADS = new Set(['base64', 'lsof', 'mktemp', 'pbpaste', 'pgrep', 'ps'])
const SYNC_HEADS = new Set(['rsync'])
const INFORMATIVE_PARSED_TYPES = new Set(['read', 'search', 'list_files', 'git_commit', 'git_push'])
// Commands that only read or print. When a script chains several commands,
// the failure is attributed to the last command that is not one of these.
const READ_ONLY_HEADS = new Set([
  ...PROBE_HEADS,
  'sed',
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'ls',
  'wc',
  'sort',
  'uniq',
  'awk',
  'cut',
  'tr',
  'jq',
  'yq',
  'stat',
  'file',
  'du',
  'df',
  'tree',
  'pwd',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'date',
  'printenv',
  'xargs',
  'tee',
  'column',
  'nl',
  'od',
  'xxd',
  'strings',
  'shasum',
  'md5',
  'sha256sum',
  'git log',
  'git diff',
  'git show',
  'git status',
  'git blame',
  'git branch',
  'git rev-parse',
  'git ls-files',
  'git grep',
  'git remote',
  'git describe',
  'git rev-list',
  'git cat-file',
  'git worktree',
  'git stash',
])
const TEST_COMMAND_PATTERN =
  /\b(pytest|py\.test|jest|vitest|mocha|ava|tap|ctest|cargo (nextest|test)|go test|bun test|npm (run )?test|pnpm (run )?test|yarn (run )?test|node --test|deno test|phpunit|rspec|gradle(w)? test|mvn test|swift test|xcodebuild test|dotnet test|playwright test|cypress run|ctest|run_ctest|task [\w:./-]*(test|verify)\b)/
const TEST_OUTPUT_PATTERN =
  /\b(\d+ (tests?|specs?|examples?) failed|\d+ failed|FAILED\b|AssertionError|assert(ion)? failed|Tests? failed|test result: FAILED|not ok \d|FAIL:|✗|✘|\(Failed\)|\*\*\*Failed|Errors while running CTest|Expected .* to (equal|be)|expected .* but (got|received))/
const BUILD_OUTPUT_PATTERN =
  /(error\[E\d+\]|error TS\d+|compilation terminated|ninja: build stopped|ld(64)?(\.lld)?: error|undefined (reference|symbol)|CMake Error|Build FAILED|FAILED: .*\.(o|obj|a|so|dylib)\b|fatal error: .*\.(h|hpp)|SyntaxError|Cannot find module|Module not found|error: cannot find|error: could not compile|: error: .*(expected|undeclared|no member|use of undeclared))/
const BUILD_COMMAND_PATTERN =
  /\b(cmake|ninja|make|cargo (build|check|clippy|run)|tsc\b|go (build|vet|run)|npm run build|pnpm (run )?build|bun run build|yarn (run )?build|xcodebuild|gradle(w)?\b|mvn\b|swift build|dotnet build|esbuild|webpack|vite build|meson|bazel|buck2?)\b/
const LINT_COMMAND_PATTERN =
  /\b(eslint|prettier|ruff|black|isort|flake8|pylint|mypy|pyright|clang-format|clang-tidy|clippy|golangci-lint|gofmt|stylelint|biome|oxlint|shellcheck|markdownlint|yamllint|lint(er)?)\b|git diff --check|--check\b|task [\w:./-]*(fmt|format|lint)\b/
const LINT_OUTPUT_PATTERN =
  /(trailing whitespace|would reformat|would be reformatted|Code style issues|lint error|✖ \d+ problems?|warning: .*clippy|reformatted|formatting issues)/i
const GIT_OUTPUT_PATTERN =
  /(CONFLICT|Automatic merge failed|nothing to commit|not a git repository|rejected\]|! \[rejected|error: (pathspec|refusing|cannot|your local changes|failed to push)|fatal: (not a git|bad revision|ambiguous argument|couldn't find remote|cannot lock|unable to access|refusing|no upstream|The current branch|You are not currently on a branch|a branch named)|Please commit your changes or stash|You have unstaged changes|is not a commit and a branch)/
const NETWORK_OUTPUT_PATTERN =
  /(\bECONNREFUSED\b|\bENOTFOUND\b|\bECONNRESET\b|\bEAI_AGAIN\b|\bEHOSTUNREACH\b|Could not resolve host|Connection refused|Network is unreachable|getaddrinfo|fetch failed|502 Bad Gateway|503 Service|504 Gateway|429 Too Many|TLS handshake|certificate verify|SSL error|Temporary failure in name resolution|dial tcp)/i
const TIMEOUT_OUTPUT_PATTERN = /(timed out|time out\b|timeout(?! ?ms)|ETIMEDOUT|deadline exceeded|exceeded the timeout)/i
const CRASH_OUTPUT_PATTERN =
  /(panicked at|Segmentation fault|core dumped|Abort trap|SIGSEGV|SIGABRT|SIGBUS|stack overflow|out of memory|JavaScript heap out of memory|OOM|Bus error|Illegal instruction|UnhandledPromiseRejection|Unhandled exception)/
const COMMAND_NOT_FOUND_PATTERN =
  /(command not found|is not recognized as an internal|zsh: no such file or directory: \S+\s*$|bash: [^:\n]+: No such file or directory\s*$|not found: [\w.-]+\s*$|npm ERR! (404|could not determine executable)|No such command|Unknown command)/m
const PERMISSION_OUTPUT_PATTERN =
  /(Permission denied|EACCES|EPERM|Operation not permitted|permission denied|Read-only file system|EROFS|not allowed by sandbox|seatbelt|sandbox denied)/
const MISSING_PATH_PATTERN =
  /(No such file or directory|ENOENT|does not exist|cannot find (the )?(file|path|directory)|not found in|No module named|ModuleNotFoundError|ImportError|cannot access '|can't open|could not find|not a directory|is not a file)/
const USAGE_OUTPUT_PATTERN =
  /(^usage:|^Usage:|Available tasks for this project|task: Task ".*" (does not exist|not found)|unknown option|unrecognized (option|argument|subcommand)|invalid (option|argument|value|choice)|unexpected argument|required argument|the following (required )?arguments|No such option|unknown (flag|command|subcommand)|missing (required )?(argument|option)|too (many|few) arguments|Did you mean)/im
const INTERRUPTED_EXIT_CODES = new Set([129, 130, 137, 143])
const CRASH_EXIT_CODES = new Set([101, 132, 133, 134, 136, 139])
const RECOVERABLE_CHECK_CATEGORIES = new Set(['test_failed', 'lint_failed', 'build_failed'])
export const BENIGN_FAILURE_CATEGORIES = new Set(['no_match', 'expected_difference'])
// Bump whenever summarizeThread changes what it extracts, so cached
// per-thread summaries produced by an older parser are rebuilt.
const SUMMARY_PARSER_VERSION = 7

export function resolveCodexHome(explicitHome) {
  if (explicitHome) return path.resolve(explicitHome)
  if (process.env.CODEX_HOME) return path.resolve(process.env.CODEX_HOME)
  return path.join(os.homedir(), '.codex')
}

export async function findStateDatabase(codexHome) {
  const entries = await fs.readdir(codexHome, { withFileTypes: true })
  const matches = []

  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!/^state_\d+\.sqlite$/.test(entry.name)) continue
    const filePath = path.join(codexHome, entry.name)
    const stat = await fs.stat(filePath)
    matches.push({ filePath, mtimeMs: stat.mtimeMs })
  }

  matches.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return matches[0]?.filePath ?? null
}

export async function loadThreads({
  codexHome,
  sinceEpochSeconds,
  limit,
  offset,
  includeArchived,
  includeSubagents,
}) {
  const dbPath = await findStateDatabase(codexHome)
  if (!dbPath) {
    throw new Error(`No state_*.sqlite database found in ${codexHome}`)
  }

  const where = []
  if (!includeArchived) where.push('archived = 0')
  if (!includeSubagents) {
    // Older Codex versions tag sub-agent threads via agent_role; newer ones
    // encode the spawn metadata as a JSON object in the source column.
    where.push("(agent_role is null or agent_role = '')")
    where.push("source not like '{\"subagent\"%'")
  }
  if (sinceEpochSeconds) where.push(`updated_at >= ${Number(sinceEpochSeconds)}`)

  const sql = [
    'select',
    'id, rollout_path, created_at, updated_at, source, model_provider, cwd,',
    'title, tokens_used, archived, git_branch, cli_version,',
    'first_user_message, model, reasoning_effort, agent_role, agent_nickname, agent_path',
    'from threads',
    where.length ? `where ${where.join(' and ')}` : '',
    'order by updated_at desc',
    limit ? `limit ${Number(limit)}` : '',
    offset ? `offset ${Number(offset)}` : '',
    ';',
  ]
    .filter(Boolean)
    .join(' ')

  const { stdout } = await execFileAsync('sqlite3', ['-json', dbPath, sql], {
    maxBuffer: 16 * 1024 * 1024,
  })

  const rows = stdout.trim() ? JSON.parse(stdout) : []
  return rows.map(row => ({
    id: String(row.id),
    rolloutPath: String(row.rollout_path),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    source: String(row.source ?? ''),
    modelProvider: String(row.model_provider ?? ''),
    cwd: String(row.cwd ?? ''),
    title: String(row.title ?? ''),
    tokensUsed: Number(row.tokens_used ?? 0),
    archived: Number(row.archived ?? 0) === 1,
    gitBranch: row.git_branch ? String(row.git_branch) : '',
    cliVersion: row.cli_version ? String(row.cli_version) : '',
    firstUserMessage: row.first_user_message ? String(row.first_user_message) : '',
    model: row.model ? String(row.model) : '',
    reasoningEffort: row.reasoning_effort ? String(row.reasoning_effort) : '',
    agentRole: row.agent_role ? String(row.agent_role) : '',
    agentNickname: row.agent_nickname ? String(row.agent_nickname) : '',
    agentPath: row.agent_path ? String(row.agent_path) : '',
  }))
}

export async function loadRolloutEvents(rolloutPath) {
  const raw = await fs.readFile(rolloutPath, 'utf8')
  const lines = raw.split('\n')
  const events = []

  for (const line of lines) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // Ignore malformed lines and keep processing the rest of the rollout.
    }
  }

  return events
}

export function isSubstantiveThread(thread) {
  if (thread.userMessages < 2) return false
  if (thread.durationMinutes < 1) return false
  return Boolean(String(thread.transcriptForAnalysis || '').trim())
}

export function filterSubstantiveThreads(threadSummaries) {
  return [...threadSummaries]
    .filter(isSubstantiveThread)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
}

export function filterExcludedThreads(threadSummaries, excludedThreadIds = []) {
  const excluded = new Set(excludedThreadIds.filter(Boolean).map(String))
  if (!excluded.size) return [...threadSummaries]
  return threadSummaries.filter(thread => !excluded.has(String(thread.id)))
}

function extractAssistantText(messagePayload) {
  return extractContentText(messagePayload?.content)
}

function extractContentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => {
      if (typeof part?.text === 'string') return part.text
      if (typeof part?.content === 'string') return part.content
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function durationToMs(duration) {
  if (!duration) return 0
  if (typeof duration === 'number') return duration
  return Number(duration.secs ?? 0) * 1000 + Number(duration.nanos ?? 0) / 1e6
}

function extractTokenSnapshot(payload) {
  const total = payload?.info?.total_token_usage
  if (!total) return null
  return {
    inputTokens: Number(total.input_tokens ?? 0),
    cachedInputTokens: Number(total.cached_input_tokens ?? 0),
    outputTokens: Number(total.output_tokens ?? 0),
    reasoningOutputTokens: Number(total.reasoning_output_tokens ?? 0),
    totalTokens: Number(total.total_tokens ?? 0),
  }
}

/**
 * Returns the shell script that actually ran. Newer Codex rollouts wrap
 * every command as ["/bin/zsh", "-lc", "<script>"]; older ones store argv.
 */
export function extractShellScript(command) {
  if (Array.isArray(command)) {
    const [bin, flag, script] = command
    if (
      command.length >= 3 &&
      /(^|\/)(zsh|bash|sh|dash|fish|ksh)$/.test(String(bin)) &&
      /^-[a-zA-Z]*c[a-zA-Z]*$/.test(String(flag)) &&
      typeof script === 'string'
    ) {
      return script
    }
    return command.map(value => String(value ?? '')).join(' ')
  }
  return String(command ?? '')
}

/**
 * Removes heredoc bodies (cat > file <<'EOF' ... EOF) so their content is
 * never mistaken for commands.
 */
export function stripHeredocs(script) {
  return String(script ?? '').replace(
    /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2(?=\s*(?:\n|$))/g,
    '',
  )
}

/**
 * Splits a shell script on control operators without treating newlines and
 * separators inside quoted `python -c` / `node -e` programs as shell syntax.
 */
export function splitShellSegments(script) {
  const text = stripHeredocs(script)
  const segments = []
  let start = 0
  let quote = null
  let escaped = false

  const push = end => {
    const segment = text.slice(start, end).trim()
    if (segment) segments.push(segment)
  }

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      continue
    }
    const isDoubleOperator =
      (char === '&' && text[index + 1] === '&') ||
      (char === '|' && text[index + 1] === '|')
    if (char === '\n' || char === ';' || char === '|' || isDoubleOperator) {
      push(index)
      if (isDoubleOperator) index += 1
      start = index + 1
    }
  }
  push(text.length)
  return segments
}

function extractSegmentHead(segment) {
  let tokens = segment
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(token => token.replace(/^['"]|['"]$/g, ''))
  let skippedWrapper = false
  while (tokens.length) {
    const token = tokens[0]
    const isAssignment = /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
    const isWrapperFlag = skippedWrapper && (token === '--' || token.startsWith('-'))
    const base = path.basename(token)
    if (isAssignment || isWrapperFlag) {
      tokens.shift()
      continue
    }
    if (COMMAND_WRAPPERS.has(base)) {
      skippedWrapper = true
      tokens.shift()
      continue
    }
    break
  }
  if (!tokens.length) return null
  const head = path.basename(tokens[0])
  if (COMMAND_SKIP_HEADS.has(head)) return null
  if (!/^[\w.+-]+$/.test(head)) return null
  if (COMMAND_SUBCOMMAND_HEADS.has(head)) {
    const sub = tokens.slice(1).find(token => !token.startsWith('-'))
    if (sub && /^[\w:./+-]+$/.test(sub)) return `${head} ${sub}`.slice(0, 48)
  }
  return head.slice(0, 40)
}

/**
 * Lists the programs a shell script runs, in order ("git add", "task verify").
 * Wrappers, env assignments, shell builtins, and heredoc bodies are skipped.
 */
export function extractCommandHeads(script) {
  const segments = splitShellSegments(script)
  const heads = []
  for (const segment of segments) {
    const head = extractSegmentHead(segment)
    if (head) heads.push(head)
  }
  return heads
}

/**
 * Returns a stable semantic category for the command that actually ran.
 * Codex currently labels most compound shell commands `unknown`, so that
 * parser value is kept only when it is already informative.
 */
export function inferCommandKind({ script, parsedType, head }) {
  const supplied = String(parsedType ?? '').trim()
  if (INFORMATIVE_PARSED_TYPES.has(supplied)) return supplied

  const text = String(script ?? '')
  const commandHead = String(head || extractCommandHead(text))
  const [program, subcommand = ''] = commandHead.split(' ')
  if (program === 'git') {
    if (subcommand === 'commit') return 'git_commit'
    if (subcommand === 'push') return 'git_push'
    return 'git'
  }
  if (TEST_COMMAND_PATTERN.test(text)) return 'test'
  if (LINT_COMMAND_PATTERN.test(text)) return 'lint'
  if (BUILD_COMMAND_PATTERN.test(text)) return 'build'
  if (SEARCH_HEADS.has(program)) return 'search'
  if (LIST_HEADS.has(program)) return 'list_files'
  if (isReadOnlyHead(commandHead)) return 'read'
  if (SCRIPT_HEADS.has(program)) return 'script'
  if (FILE_CHANGE_HEADS.has(program)) return 'file_change'
  if (NETWORK_HEADS.has(program)) return 'network'
  if (DOCUMENT_HEADS.has(program)) return 'document'
  if (ARCHIVE_HEADS.has(program)) return 'archive'
  if (MEDIA_HEADS.has(program)) return 'media'
  if (VALIDATION_HEADS.has(program)) return 'validation'
  if (DATABASE_HEADS.has(program)) return 'database'
  if (AGENT_TOOL_HEADS.has(program)) return 'agent_tool'
  if (SYSTEM_HEADS.has(program)) return 'system'
  if (SYNC_HEADS.has(program)) return 'sync'
  if (program === 'agent-browser' || program === 'open' || program === 'screencapture') return 'browser'
  if (program === 'gh') return 'git_hosting'
  if (program === 'docker' || program === 'kubectl') return 'runtime'
  if (program === 'shell') return 'shell'
  return 'other'
}

function isReadOnlyHead(head) {
  return READ_ONLY_HEADS.has(head) || READ_ONLY_HEADS.has(String(head).split(' ')[0])
}

/**
 * Picks the program a failure should be attributed to. A script's exit code
 * comes from its last command, and read-only commands (sed, cat, rg) rarely
 * fail on their own, so the last non-read-only command wins; if every command
 * is read-only, the last one does.
 */
export function extractCommandHead(script) {
  const heads = extractCommandHeads(script)
  if (!heads.length) return 'shell'
  for (let index = heads.length - 1; index >= 0; index -= 1) {
    if (!isReadOnlyHead(heads[index])) return heads[index]
  }
  return heads[heads.length - 1]
}

/**
 * Heuristic classification of a failed command into a cause. Order matters:
 * strong exit-code signals first, then command intent, then output patterns.
 * Returns 'no_match' for probe-style commands (rg, grep, test) whose exit
 * code 1 only means "nothing found"; callers treat that as benign.
 */
export function classifyCommandFailure({ script, head, parsedType, exitCode, status, output }) {
  const code = Number.isFinite(Number(exitCode)) ? Number(exitCode) : null
  const text = String(script ?? '')
  const headName = String(head ?? '').split(' ')[0]
  const fullOutput = String(output ?? '')
  const out =
    fullOutput.length > 12000 ? `${fullOutput.slice(0, 4000)}\n${fullOutput.slice(-8000)}` : fullOutput
  const statusText = String(status ?? '').toLowerCase()

  const heads = extractCommandHeads(text)
  const lastHead = String(heads[heads.length - 1] ?? '').split(' ')[0]
  const allReadOnly = heads.length > 0 && heads.every(isReadOnlyHead)
  const anyProbe = heads.some(item => PROBE_HEADS.has(String(item).split(' ')[0]))
  const isProbe =
    parsedType === 'search' || PROBE_HEADS.has(headName) || PROBE_HEADS.has(lastHead) || (allReadOnly && anyProbe)
  const isExpectedDifference =
    code === 1 &&
    (headName === 'cmp' ||
      headName === 'diff' ||
      /(?:^|[;&|]\s*)git\s+diff\b[^\n;&|]*(?:--quiet|--exit-code)\b/.test(text))
  if (
    isExpectedDifference &&
    !MISSING_PATH_PATTERN.test(out) &&
    !PERMISSION_OUTPUT_PATTERN.test(out)
  ) {
    return 'expected_difference'
  }
  if (
    isProbe &&
    code === 1 &&
    !TEST_OUTPUT_PATTERN.test(out) &&
    !MISSING_PATH_PATTERN.test(out) &&
    !PERMISSION_OUTPUT_PATTERN.test(out)
  ) {
    return 'no_match'
  }
  if (/Available tasks for this project|task: Task ".*" (does not exist|not found)/.test(out)) {
    return 'usage_error'
  }

  if (
    (code !== null && INTERRUPTED_EXIT_CODES.has(code)) ||
    statusText === 'interrupted' ||
    statusText === 'aborted' ||
    /(^|\n)(zsh|bash): .*(interrupt|terminated|killed)/i.test(out)
  ) {
    return 'interrupted'
  }
  if (code === 127 || COMMAND_NOT_FOUND_PATTERN.test(out)) return 'command_not_found'
  if (PERMISSION_OUTPUT_PATTERN.test(out)) return 'permission_denied'
  if (statusText === 'timeout' || statusText === 'timed_out') return 'timeout'

  const looksLikeTest = TEST_COMMAND_PATTERN.test(text)
  const looksLikeBuild = BUILD_COMMAND_PATTERN.test(text)
  const looksLikeLint = LINT_COMMAND_PATTERN.test(text)
  if (BUILD_OUTPUT_PATTERN.test(out) && !(looksLikeTest && TEST_OUTPUT_PATTERN.test(out))) {
    return 'build_failed'
  }
  if (looksLikeTest || TEST_OUTPUT_PATTERN.test(out)) return 'test_failed'
  if (looksLikeLint && (LINT_OUTPUT_PATTERN.test(out) || code === 1)) return 'lint_failed'
  if (looksLikeBuild) return 'build_failed'
  if (LINT_OUTPUT_PATTERN.test(out)) return 'lint_failed'
  if (headName === 'git' || headName === 'gh' || GIT_OUTPUT_PATTERN.test(out)) return 'git_error'
  if (NETWORK_OUTPUT_PATTERN.test(out)) return 'network_error'
  if (TIMEOUT_OUTPUT_PATTERN.test(out)) return 'timeout'
  if ((code !== null && CRASH_EXIT_CODES.has(code)) || CRASH_OUTPUT_PATTERN.test(out)) return 'crash'
  if (MISSING_PATH_PATTERN.test(out)) return 'missing_file_or_module'
  if (USAGE_OUTPUT_PATTERN.test(out) || code === 2) return 'usage_error'
  if (/\b(error|exception|traceback|fatal|failed|aborting)\b/i.test(out)) return 'runtime_error'
  return 'unclassified'
}

export function summarizeThread(thread, events) {
  const toolCounts = {}
  const commandKindCounts = {}
  const commandCounts = {}
  const toolFailures = {}
  const toolErrorCategories = {}
  const userMessageTimestamps = []
  const userReplyGapsSeconds = []
  const turnDurationsSeconds = []
  const commandFailures = []
  const commandDurationsMs = []
  const commandSamples = []
  const pendingCheckFailures = new Map()
  const transcriptLines = []
  const filesModified = new Set()
  let userMessages = 0
  let assistantMessages = 0
  let reasoningItems = 0
  let commentaryMessages = 0
  let finalMessages = 0
  let heuristicInterruptions = 0
  let abortedTurns = 0
  let toolErrors = 0
  let usesTaskAgent = false
  let usesMcp = false
  let usesWebSearch = false
  let usesWebFetch = false
  let gitCommits = 0
  let gitPushes = 0
  let linesAdded = 0
  let linesRemoved = 0
  let lastAssistantTimestampMs = null
  let latestTokenSnapshot = null
  let activeToolRun = false
  let lastTranscriptLine = ''
  let benignCommandMisses = 0
  let expectedCommandOutcomes = 0
  const expectedCommandOutcomeCategories = {}
  let activeMs = 0
  let previousEventMs = null
  let lastActivityMs = null
  let openTurnStartMs = null

  const closeTurn = endMs => {
    if (openTurnStartMs === null) return
    if (Number.isFinite(endMs) && endMs > openTurnStartMs) {
      turnDurationsSeconds.push(Math.round((endMs - openTurnStartMs) / 1000))
    }
    openTurnStartMs = null
  }

  const pushTranscript = line => {
    appendTranscriptLine(
      transcriptLines,
      line,
      value => {
        lastTranscriptLine = value
      },
      lastTranscriptLine,
    )
  }

  const usageSetters = {
    usesTaskAgent: value => {
      if (value) usesTaskAgent = true
    },
    usesMcp: value => {
      if (value) usesMcp = true
    },
    usesWebSearch: value => {
      if (value) usesWebSearch = true
    },
    usesWebFetch: value => {
      if (value) usesWebFetch = true
    },
  }

  const recordUserMessage = (text, ts) => {
    userMessages += 1
    pushTranscript(`[User] ${sanitizeTranscriptText(text, USER_TRANSCRIPT_LIMIT)}`)
    if (Number.isFinite(ts)) {
      userMessageTimestamps.push(ts)
      const gapSeconds =
        lastAssistantTimestampMs === null ? null : (ts - lastAssistantTimestampMs) / 1000
      if (gapSeconds !== null && gapSeconds > 2 && gapSeconds < 3600) {
        userReplyGapsSeconds.push(gapSeconds)
      }
      if (activeToolRun && gapSeconds !== null && gapSeconds < 180) {
        heuristicInterruptions += 1
      }
      // A new user message ends whatever turn was still open; the turn's
      // work stopped at the assistant's last activity before this message.
      closeTurn(lastActivityMs)
      openTurnStartMs = ts
    }
    activeToolRun = false
  }

  const recordToolCall = name => {
    toolCounts[name] = (toolCounts[name] || 0) + 1
    markToolUsage(name, usageSetters)
    pushTranscript(`[Tool: ${name}]`)
    activeToolRun = true
  }

  const recordToolFailure = (name, status, category) => {
    toolFailures[name] = (toolFailures[name] || 0) + 1
    toolErrorCategories[category] = (toolErrorCategories[category] || 0) + 1
    toolErrors += 1
    pushTranscript(`[Tool failed: ${name}] status=${sanitizeTranscriptText(status, 40)}`)
  }

  const recordPatchStats = stats => {
    linesAdded += stats.linesAdded
    linesRemoved += stats.linesRemoved
    for (const filePath of stats.filesModified) {
      filesModified.add(filePath)
    }
  }

  const recordCommandExecution = ({ command, parsedCmd, exitCode, status, output, durationMs }) => {
    const parsed = Array.isArray(parsedCmd) ? parsedCmd[0] : null
    const parsedType = typeof parsed?.type === 'string' ? parsed.type : 'exec_command'
    const commandText = extractShellScript(command)
    const head = extractCommandHead(commandText)
    const fingerprint = commandText.replace(/\s+/g, ' ').trim()
    const key = inferCommandKind({ script: commandText, parsedType, head })
    const failed = exitCode !== 0 || status === 'failed'
    commandKindCounts[key] = (commandKindCounts[key] || 0) + 1
    commandCounts[head] = (commandCounts[head] || 0) + 1
    if (/\bgit\s+commit\b/.test(commandText)) gitCommits += 1
    if (/\bgit\s+push\b/.test(commandText)) gitPushes += 1
    let category = null
    if (failed) {
      category = classifyCommandFailure({
        script: commandText,
        head,
        parsedType,
        exitCode,
        status,
        output,
      })
    }
    const benign = category !== null && BENIGN_FAILURE_CATEGORIES.has(category)
    if (benign) {
      benignCommandMisses += 1
      expectedCommandOutcomes += 1
      expectedCommandOutcomeCategories[category] =
        (expectedCommandOutcomeCategories[category] || 0) + 1
    } else if (failed) {
      toolFailures[head] = (toolFailures[head] || 0) + 1
      toolErrorCategories[category] = (toolErrorCategories[category] || 0) + 1
      toolErrors += 1
      const failureRecord = {
        command: commandText,
        head,
        category,
        exitCode,
        output:
          sanitizeTranscriptText(output, FAILURE_SUMMARY_LIMIT) ||
          sanitizeTranscriptText(commandText, FAILURE_SUMMARY_LIMIT),
      }
      commandFailures.push(failureRecord)
      if (RECOVERABLE_CHECK_CATEGORIES.has(category) && fingerprint) {
        const pending = pendingCheckFailures.get(fingerprint) || []
        pending.push(failureRecord)
        pendingCheckFailures.set(fingerprint, pending)
      }
    } else if (!failed && fingerprint && pendingCheckFailures.has(fingerprint)) {
      const recovered = pendingCheckFailures.get(fingerprint)
      pendingCheckFailures.delete(fingerprint)
      for (const failureRecord of recovered) {
        failureRecord.recovered = true
        toolErrors = Math.max(0, toolErrors - 1)
        toolFailures[failureRecord.head] -= 1
        if (toolFailures[failureRecord.head] <= 0) delete toolFailures[failureRecord.head]
        toolErrorCategories[failureRecord.category] -= 1
        if (toolErrorCategories[failureRecord.category] <= 0) {
          delete toolErrorCategories[failureRecord.category]
        }
        expectedCommandOutcomes += 1
        expectedCommandOutcomeCategories.recovered_check =
          (expectedCommandOutcomeCategories.recovered_check || 0) + 1
      }
      pushTranscript(`[Command check recovered: ${head}]`)
    }
    if (durationMs > 0) commandDurationsMs.push(durationMs)
    if (commandSamples.length < 8) {
      commandSamples.push({
        command: commandText,
        status: String(status ?? ''),
        exitCode,
      })
    }
    if (failed && !benign) {
      pushTranscript(`[Command failed: ${head} (${category})] exit=${exitCode}`)
    }
    activeToolRun = true
  }

  // Newer Codex rollouts (0.15x+) wrap most activity in event_msg/item_completed.
  const recordCompletedItem = (item, ts) => {
    const type = String(item?.type ?? '')

    if (type === 'UserMessage') {
      recordUserMessage(extractContentText(item.content), ts)
      return
    }
    if (type === 'CommandExecution') {
      const status = String(item.status ?? '')
      recordCommandExecution({
        command: item.command,
        parsedCmd: item.parsed_cmd,
        exitCode: Number(item.exit_code ?? (status === 'failed' ? 1 : 0)),
        status,
        output: item.aggregated_output ?? item.stderr ?? item.stdout,
        durationMs: durationToMs(item.duration),
      })
      return
    }
    if (type === 'FileChange') {
      recordPatchStats(parseFileChangeStats(item.changes))
      if (item.status && item.status !== 'completed') {
        recordToolFailure('file_change', item.status, 'patch_failed')
      }
      activeToolRun = true
      return
    }
    if (type === 'McpToolCall') {
      const name = `mcp__${item.server ?? 'unknown'}__${item.tool ?? 'tool'}`
      recordToolCall(name)
      if (item.status && item.status !== 'completed') {
        recordToolFailure(name, item.status, 'mcp_tool_error')
      }
      return
    }
    if (type === 'WebSearch') {
      recordToolCall('web.search')
      return
    }
    if (type === 'Extension') {
      recordToolCall(String(item.kind ?? 'extension'))
      return
    }
    if (type === 'ImageView') {
      recordToolCall('image_view')
      return
    }
    if (type === 'SubAgentActivity' || type === 'CollabAgentToolCall') {
      // The collaboration function_call items are already counted as tool calls.
      usesTaskAgent = true
      activeToolRun = true
    }
    // AgentMessage and Reasoning items are mirrored as response_item entries,
    // which are counted below, so they are intentionally ignored here.
  }

  for (const event of events) {
    const ts = Date.parse(event.timestamp)
    const payload = event.payload

    if (Number.isFinite(ts)) {
      if (previousEventMs !== null) {
        const gapMs = ts - previousEventMs
        if (gapMs > 0 && gapMs <= IDLE_GAP_MS) activeMs += gapMs
      }
      // lastActivityMs is the timestamp of the event *before* this one, so
      // a user message can close the previous turn at the assistant's last
      // real activity instead of at the moment the user typed.
      lastActivityMs = previousEventMs
      previousEventMs = ts
    }

    if (event.type === 'event_msg') {
      const kind = payload?.type
      if (kind === 'user_message') {
        recordUserMessage(payload.message, ts)
        continue
      }
      if (kind === 'token_count') {
        const snapshot = extractTokenSnapshot(payload)
        if (snapshot) latestTokenSnapshot = snapshot
        continue
      }
      if (kind === 'exec_command_end') {
        recordCommandExecution({
          command: payload.command,
          parsedCmd: payload.parsed_cmd,
          exitCode: Number(payload.exit_code ?? 0),
          status: payload.status,
          output: payload.aggregated_output,
          durationMs: durationToMs(payload.duration),
        })
        continue
      }
      if (kind === 'turn_aborted') {
        if (String(payload.reason ?? '') === 'interrupted') abortedTurns += 1
        activeToolRun = false
        closeTurn(ts)
        continue
      }
      if (kind === 'item_completed') {
        recordCompletedItem(payload.item, ts)
      }
      continue
    }

    if (event.type !== 'response_item') continue

    if (payload?.type === 'function_call') {
      const name = String(payload.name ?? 'function_call')
      recordToolCall(name)
      if (name === 'apply_patch') {
        recordPatchStats(parseApplyPatchStats(payload.arguments))
      }
      continue
    }

    if (payload?.type === 'custom_tool_call') {
      const name = String(payload.name ?? 'custom_tool_call')
      recordToolCall(name)
      if (payload.status && payload.status !== 'completed') {
        recordToolFailure(name, payload.status)
      }
      if (name === 'apply_patch') {
        recordPatchStats(parseApplyPatchStats(payload.input))
      }
      continue
    }

    if (payload?.type === 'function_call_output' || payload?.type === 'custom_tool_call_output') {
      activeToolRun = true
      continue
    }

    if (payload?.type === 'reasoning') {
      reasoningItems += 1
      continue
    }

    if (payload?.type === 'message' && payload.role === 'assistant') {
      assistantMessages += 1
      const phase = String(payload.phase ?? 'assistant')
      if (phase === 'commentary') commentaryMessages += 1
      if (phase === 'final_answer') finalMessages += 1
      if (Number.isFinite(ts)) {
        lastAssistantTimestampMs = ts
        if (phase === 'final_answer') closeTurn(ts)
      }
      const text = extractAssistantText(payload)
      if (text) {
        pushTranscript(`[Assistant] ${sanitizeTranscriptText(text, ASSISTANT_TRANSCRIPT_LIMIT)}`)
      }
      activeToolRun = phase !== 'final_answer'
    }
  }

  closeTurn(previousEventMs)

  const startedAtMs = events.length ? Date.parse(events[0].timestamp) : thread.createdAt * 1000
  const endedAtMs = events.length
    ? Date.parse(events[events.length - 1].timestamp)
    : thread.updatedAt * 1000
  const durationMinutes = Math.max(
    0,
    Math.round(((endedAtMs - startedAtMs) / 1000 / 60) * 10) / 10,
  )

  const sortedUserTs = [...userMessageTimestamps].sort((a, b) => a - b)
  const activeHours = sortedUserTs.map(tsMs => new Date(tsMs).getHours())
  // Explicit turn_aborted events are authoritative when present; otherwise
  // fall back to the timing heuristic used for older rollouts.
  const userInterruptions = abortedTurns > 0 ? abortedTurns : heuristicInterruptions

  const operationalCommandFailures = commandFailures.filter(item => !item.recovered)

  return {
    id: thread.id,
    title: thread.title,
    firstUserMessage: sanitizeTranscriptText(thread.firstUserMessage, 1200),
    cwd: thread.cwd,
    model: thread.model,
    modelProvider: thread.modelProvider,
    createdAt: new Date(thread.createdAt * 1000).toISOString(),
    updatedAt: new Date(thread.updatedAt * 1000).toISOString(),
    durationMinutes,
    activeMinutes: Math.round((activeMs / 1000 / 60) * 10) / 10,
    userMessages,
    assistantMessages,
    commentaryMessages,
    finalMessages,
    reasoningItems,
    toolCounts,
    commandKindCounts,
    commandCounts,
    toolFailures,
    totalToolCalls: Object.values(toolCounts).reduce((sum, count) => sum + count, 0),
    totalCommandFailures: operationalCommandFailures.length,
    benignCommandMisses,
    expectedCommandOutcomes,
    expectedCommandOutcomeCategories,
    commandFailures: operationalCommandFailures.slice(0, 8),
    commandSamples,
    averageCommandDurationMs: average(commandDurationsMs),
    turnDurationsSeconds,
    medianTurnSeconds: median(turnDurationsSeconds),
    medianUserReplyGapSeconds: median(userReplyGapsSeconds),
    activeHours,
    userMessageTimestamps: sortedUserTs.map(tsMs => new Date(tsMs).toISOString()),
    transcriptForAnalysis: clampTranscript(compactTranscriptLines(transcriptLines).join('\n')),
    gitCommits,
    gitPushes,
    userInterruptions,
    toolErrors,
    toolErrorCategories,
    usesTaskAgent,
    usesMcp,
    usesWebSearch,
    usesWebFetch,
    linesAdded,
    linesRemoved,
    filesModified: filesModified.size,
    tokenUsage: latestTokenSnapshot ?? {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: thread.tokensUsed,
    },
  }
}

export async function collectThreadSummaries(options) {
  const cacheDir = resolveSessionMetaCacheDir(options.cacheDir)
  await fs.mkdir(cacheDir, { recursive: true })

  const substantiveTarget = Number(options.limit ?? 0)
  const pageSize = substantiveTarget > 0 ? substantiveTarget : 200
  const summaries = []
  let offset = 0
  let substantiveCount = 0
  const excludedThreadIds = options.excludeThreadIds ?? [
    process.env.CODEX_THREAD_ID,
    process.env.CODEX_SESSION_ID,
  ]

  while (true) {
    const threads = await loadThreads({
      ...options,
      limit: pageSize,
      offset,
    })
    if (!threads.length) break

    for (const thread of filterExcludedThreads(threads, excludedThreadIds)) {
      const summary = await loadCachedOrFreshSummary(thread, cacheDir)
      summaries.push(summary)
      if (isSubstantiveThread(summary)) {
        substantiveCount += 1
      }
    }

    if (substantiveTarget > 0 && substantiveCount >= substantiveTarget) {
      break
    }
    if (threads.length < pageSize) {
      break
    }

    offset += threads.length
  }

  if (substantiveTarget > 0) {
    return filterSubstantiveThreads(summaries).slice(0, substantiveTarget)
  }
  return summaries
}

async function loadCachedOrFreshSummary(thread, cacheDir) {
  const cachePath = path.join(cacheDir, `${thread.id}.json`)
  const versionKey = hashObject({
    parserVersion: SUMMARY_PARSER_VERSION,
    id: thread.id,
    rolloutPath: thread.rolloutPath,
    updatedAt: thread.updatedAt,
    tokensUsed: thread.tokensUsed,
    model: thread.model,
    firstUserMessage: thread.firstUserMessage,
  })
  const cached = await readJson(cachePath)
  if (cached?.versionKey === versionKey && cached?.summary) {
    return cached.summary
  }

  let summary
  try {
    const events = await loadRolloutEvents(thread.rolloutPath)
    summary = summarizeThread(thread, events)
  } catch (error) {
    summary = buildFallbackSummary(thread, error)
  }

  await fs.writeFile(cachePath, JSON.stringify({ versionKey, summary }, null, 2), 'utf8')
  return summary
}

function buildFallbackSummary(thread, error) {
  return {
    id: thread.id,
    title: thread.title,
    firstUserMessage: sanitizeTranscriptText(thread.firstUserMessage, 1200),
    cwd: thread.cwd,
    model: thread.model,
    modelProvider: thread.modelProvider,
    createdAt: new Date(thread.createdAt * 1000).toISOString(),
    updatedAt: new Date(thread.updatedAt * 1000).toISOString(),
    durationMinutes: 0,
    activeMinutes: 0,
    userMessages: 0,
    assistantMessages: 0,
    commentaryMessages: 0,
    finalMessages: 0,
    reasoningItems: 0,
    toolCounts: {},
    commandKindCounts: {},
    commandCounts: {},
    toolFailures: { rollout_read: 1 },
    totalToolCalls: 0,
    totalCommandFailures: 0,
    benignCommandMisses: 0,
    expectedCommandOutcomes: 0,
    expectedCommandOutcomeCategories: {},
    commandFailures: [
      {
        command: 'rollout_read',
        head: 'rollout_read',
        category: 'rollout_read_error',
        exitCode: 1,
        output: error instanceof Error ? error.message : String(error),
      },
    ],
    commandSamples: [],
    averageCommandDurationMs: 0,
    turnDurationsSeconds: [],
    medianTurnSeconds: 0,
    medianUserReplyGapSeconds: 0,
    activeHours: [],
    userMessageTimestamps: [],
    transcriptForAnalysis: '',
    gitCommits: 0,
    gitPushes: 0,
    userInterruptions: 0,
    toolErrors: 1,
    toolErrorCategories: { rollout_read_error: 1 },
    usesTaskAgent: false,
    usesMcp: false,
    usesWebSearch: false,
    usesWebFetch: false,
    linesAdded: 0,
    linesRemoved: 0,
    filesModified: 0,
    tokenUsage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: thread.tokensUsed,
    },
  }
}

function parseApplyPatchStats(rawPatch) {
  const filesModified = new Set()
  let linesAdded = 0
  let linesRemoved = 0

  const patch = String(rawPatch ?? '')
  for (const line of patch.split('\n')) {
    if (
      line.startsWith('*** Update File: ') ||
      line.startsWith('*** Add File: ') ||
      line.startsWith('*** Delete File: ')
    ) {
      const filePath = line.replace(/^\*\*\* (?:Update|Add|Delete) File: /, '').trim()
      if (filePath) filesModified.add(filePath)
      continue
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      linesAdded += 1
      continue
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      linesRemoved += 1
    }
  }

  return { filesModified, linesAdded, linesRemoved }
}

function parseFileChangeStats(changes) {
  const filesModified = new Set()
  let linesAdded = 0
  let linesRemoved = 0

  if (!changes || typeof changes !== 'object') {
    return { filesModified, linesAdded, linesRemoved }
  }

  for (const [filePath, change] of Object.entries(changes)) {
    if (filePath) filesModified.add(filePath)
    const kind = String(change?.type ?? '')
    const content = typeof change?.content === 'string' ? change.content : ''
    if (kind === 'add' && content) {
      linesAdded += countLines(content)
      continue
    }
    if (kind === 'delete' && content) {
      linesRemoved += countLines(content)
      continue
    }
    for (const line of String(change?.unified_diff ?? '').split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        linesAdded += 1
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        linesRemoved += 1
      }
    }
  }

  return { filesModified, linesAdded, linesRemoved }
}

function countLines(text) {
  const clean = String(text ?? '')
  if (!clean) return 0
  return clean.replace(/\n$/, '').split('\n').length
}

function markToolUsage(name, setters) {
  if (TASK_AGENT_TOOLS.has(name)) {
    setters.usesTaskAgent(true)
  }
  if (name.startsWith('mcp__')) {
    setters.usesMcp(true)
  }
  if (name.startsWith('web.')) {
    if (name.includes('search') || name.includes('image_query')) {
      setters.usesWebSearch(true)
    }
    if (
      name.includes('open') ||
      name.includes('click') ||
      name.includes('find') ||
      name.includes('screenshot')
    ) {
      setters.usesWebFetch(true)
    }
  }
}

function clampTranscript(text) {
  const clean = String(text).trim()
  if (clean.length <= MAX_TRANSCRIPT_CHARS) return clean
  return `${clean.slice(0, MAX_TRANSCRIPT_CHARS)}\n[Transcript truncated]`
}

function compactTranscriptLines(lines) {
  const compacted = []
  let pendingToolBurst = []

  const flushToolBurst = () => {
    if (!pendingToolBurst.length) return
    compacted.push(...pendingToolBurst.slice(0, MAX_TOOL_LINES_PER_BURST))
    const remaining = pendingToolBurst.length - MAX_TOOL_LINES_PER_BURST
    if (remaining > 0) {
      compacted.push(`[Tool activity truncated: ${remaining} more tool calls]`)
    }
    pendingToolBurst = []
  }

  for (const line of lines) {
    if (isLowSignalAssistantLine(line)) continue

    if (isToolLine(line)) {
      pendingToolBurst.push(line)
      continue
    }

    flushToolBurst()
    if (!compacted.length || compacted[compacted.length - 1] !== line) {
      compacted.push(line)
    }
  }

  flushToolBurst()
  return compacted
}

function appendTranscriptLine(lines, line, setLastLine, lastLine) {
  const clean = String(line ?? '').trim()
  if (!clean || clean === lastLine) return
  lines.push(clean)
  setLastLine(clean)
}

function isToolLine(line) {
  const text = String(line || '')
  return text.startsWith('[Tool: ')
}

function isLowSignalAssistantLine(line) {
  const text = String(line || '')
  if (!text.startsWith('[Assistant] ')) return false
  const body = text.slice('[Assistant] '.length).trim()
  if (!body) return true
  if (body.length > 60) return false
  return LOW_SIGNAL_ASSISTANT_PATTERNS.some(pattern => pattern.test(body))
}

function sanitizeTranscriptText(value, limit) {
  const text = String(value ?? '')
    .replace(/<system_instruction>[\s\S]*?<\/system_instruction>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return ''
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}...`
}

function resolveSessionMetaCacheDir(explicitRoot) {
  const root = explicitRoot
    ? path.resolve(explicitRoot)
    : path.join(os.homedir(), '.codex-insights-cache')
  return path.join(root, 'session-meta')
}

function hashObject(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch {
    return null
  }
}

function average(values) {
  if (!values.length) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function median(values) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}
