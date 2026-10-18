const CLOSED_LOOP_OUTCOMES = new Set(['fully_achieved', 'mostly_achieved'])
const OPEN_LOOP_OUTCOMES = new Set(['partially_achieved', 'not_achieved'])

function hasNoUnfinishedWork(value) {
  return /^(none|nothing|n\/a)$/i.test(String(value ?? '').trim())
}

function hasConcreteUnfinishedWork(value) {
  const text = String(value ?? '').trim()
  return Boolean(text) && !/^(none|nothing|unknown|unclear(_from_transcript)?|n\/a)$/i.test(text)
}

function normalizeEvidence(value) {
  return String(value ?? '').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}

function facetEvidenceText(facet) {
  return [
    facet?.underlying_goal,
    facet?.brief_summary,
    facet?.primary_success,
    facet?.unfinished_work,
    facet?.friction_detail,
  ]
    .map(normalizeEvidence)
    .filter(Boolean)
    .join('\n')
}

function isLaterFacetFromSameProject(facet, source, sourceTime) {
  if (!facet || facet.threadId === source.threadId) return false
  if (!String(source.cwd ?? '').trim() || String(facet.cwd ?? '') !== String(source.cwd)) return false
  const candidateTime = Date.parse(facet.updatedAt ?? '')
  return Number.isFinite(candidateTime) && candidateTime > sourceTime
}

/**
 * Reconciles model-proposed loop candidates against actual facet records.
 * A loop is never marked resolved unless a newer facet from the same project
 * is explicitly referenced, completed, and contains the cited exact evidence.
 */
export function reconcileOpenLoops(insights, facets = []) {
  if (!insights?.open_loops?.items?.length) return insights
  const facetsById = new Map(facets.map(facet => [String(facet.threadId), facet]))
  const items = insights.open_loops.items.map(item => {
    const sourceId = String(item.source_thread_id ?? '')
    const resolutionId = String(item.resolution_thread_id ?? '')
    const source = facetsById.get(sourceId)
    const resolution = facetsById.get(resolutionId)

    if (!source) {
      return {
        ...item,
        status: 'unverifiable',
        reconciliation_evidence: 'The source thread cannot be matched to an analyzed session facet.',
      }
    }

    const sourceTime = Date.parse(source.updatedAt ?? '')
    if (resolutionId) {
      const resolutionTime = Date.parse(resolution?.updatedAt ?? '')
      const sameProject =
        Boolean(String(source.cwd ?? '').trim()) && String(source.cwd) === String(resolution?.cwd ?? '')
      const newer = Number.isFinite(sourceTime) && Number.isFinite(resolutionTime) && resolutionTime > sourceTime
      const completed =
        resolution &&
        CLOSED_LOOP_OUTCOMES.has(String(resolution.outcome ?? '')) &&
        hasNoUnfinishedWork(resolution.unfinished_work)
      const resolutionEvidence = normalizeEvidence(item.resolution_evidence)
      const evidenceMatches =
        resolutionEvidence.length >= 12 && facetEvidenceText(resolution).includes(resolutionEvidence)

      if (resolution && sameProject && newer && completed && evidenceMatches) {
        return {
          ...item,
          status: 'resolved',
          reconciliation_evidence: `Later session ${resolutionId} is newer, belongs to the same project, records a completed outcome with no unfinished work, and contains the cited resolution evidence.`,
        }
      }
      return {
        ...item,
        status: 'unverifiable',
        reconciliation_evidence: 'The claimed resolution does not pass the newer-session, same-project, completed-outcome, and exact-evidence checks.',
      }
    }

    const hasLaterProjectActivity =
      Number.isFinite(sourceTime) &&
      facets.some(facet => isLaterFacetFromSameProject(facet, source, sourceTime))
    if (
      Number.isFinite(sourceTime) &&
      !hasLaterProjectActivity &&
      OPEN_LOOP_OUTCOMES.has(String(source.outcome ?? '')) &&
      hasConcreteUnfinishedWork(source.unfinished_work)
    ) {
      return {
        ...item,
        status: 'still_open',
        reconciliation_evidence: 'The latest analyzed session for this project remains incomplete and names concrete unfinished work.',
      }
    }

    return {
      ...item,
      status: 'unverifiable',
      reconciliation_evidence: hasLaterProjectActivity
        ? 'Later activity exists in the same project, but no exact resolution evidence was cited.'
        : 'The analyzed session does not provide enough evidence to prove either completion or remaining work.',
    }
  })

  return {
    ...insights,
    open_loops: {
      ...insights.open_loops,
      items,
    },
  }
}
