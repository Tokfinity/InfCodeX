/**
 * Parse the auto-mode classifier's output — FEATURE_092 Phase 2b.3 (v0.7.33).
 *
 * Preferred format:
 *   <decision>allow|ask</decision><hazard>...</hazard><reason>...</reason>
 * Legacy `<block>` output remains parseable during the protocol rollout so a
 * valid decision from an older prompt/provider cache is not misreported as an
 * infrastructure failure.
 *
 * Robustness:
 *   - case-insensitive yes/no
 *   - whitespace inside / around tags tolerated
 *   - allow reason is optional; a blocking decision without a reason is a
 *     contract failure so the caller can retry instead of inventing a reason
 *   - inconsistent decision/hazard pairs → unparseable so the caller retries
 *   - reasons longer than 500 chars are truncated (defense against
 *     pathological model outputs)
 *   - both protocols require one complete, exclusive envelope; surrounding
 *     prose, duplicate decisions, mixed protocols, and nested contract tags
 *     are rejected so prompt-injection echoes cannot select an early allow
 */

export type ClassifierDecision =
  | {
    readonly kind: 'block'; readonly reason: string; readonly hazard?: ClassifierHazard;
    readonly protocol: ClassifierProtocol;
  }
  | {
    readonly kind: 'allow'; readonly reason: string; readonly hazard?: 'none';
    readonly protocol: ClassifierProtocol;
  }
  | {
    readonly kind: 'unparseable'; readonly raw: string;
    readonly failureCode: ClassifierParseFailureCode;
    readonly observedProtocol: ClassifierObservedProtocol;
  };

export type ClassifierProtocol = 'structured_v2' | 'legacy_v1';
export type ClassifierObservedProtocol = ClassifierProtocol | 'unknown';
export type ClassifierParseFailureCode =
  | 'missing_decision'
  | 'invalid_decision'
  | 'missing_hazard'
  | 'invalid_hazard'
  | 'decision_hazard_conflict'
  | 'missing_reason'
  | 'structured_format_violation'
  | 'legacy_format_violation';

export type ClassifierHazard =
  | 'none'
  | 'protected_read'
  | 'outside_write'
  | 'destructive_loss'
  | 'credential_exposure'
  | 'network_exfiltration'
  | 'remote_code_execution'
  | 'dependency_poisoning'
  | 'production_change'
  | 'privilege_change'
  | 'intent_conflict';

const BLOCK_RE = /<block>\s*([^<]+?)\s*<\/block>/i;
const LEGACY_CONTRACT_RE = /^\s*<block>\s*([^<]+?)\s*<\/block>(?:\s*<reason>\s*([^<]*?)\s*<\/reason>)?\s*$/i;
const STRUCTURED_CONTRACT_RE = /^\s*<decision>\s*([^<]+?)\s*<\/decision>\s*<hazard>\s*([^<]+?)\s*<\/hazard>\s*<reason>\s*([^<]*?)\s*<\/reason>\s*$/i;
const STRUCTURED_MARKER_RE = /<\s*\/?\s*(?:decision|hazard)\b/i;
const DECISION_RE = /<decision>\s*([^<]+?)\s*<\/decision>/i;
const HAZARD_RE = /<hazard>\s*([^<]+?)\s*<\/hazard>/i;
const REASON_RE = /<reason>\s*([\s\S]*?)\s*<\/reason>/i;
const MAX_REASON_LEN = 500;
const NO_HAZARD_REASON = /\b(?:blocking (?:this action )?is unnecessary|(?:this\s+action\s+)?should not be blocked|does not require (?:user )?(?:confirmation|approval|permission)|no (?:user )?(?:confirmation|approval|permission) (?:is )?(?:needed|required)|(?:proceed|continue) without (?:user )?(?:confirmation|approval|permission)|no (?:concrete |material )?(?:hazard|risk|danger)|(?:this|the)?\s*(?:action|operation|command|request|it)\s+(?:is|appears|seems|looks)\s+(?:safe|harmless)|not (?:dangerous|harmful))\b|(?:无需|不需要)(?:用户)?(?:确认|授权|许可)|没有(?:明确|具体|实质)?(?:危害|危险|风险)|(?:操作|动作|命令|请求)?(?:是|看起来)?(?:安全|无害)|并不危险/i;
const NEGATED_CONFIRMATION_REASON = /\b(?:(?:(?:does|do)\s+not|doesn't|don't)\s+(?:require|need)\s+(?:user\s+)?(?:confirmation|approval|permission)|(?:user\s+)?(?:confirmation|approval|permission)\s+is\s+not\s+required|no\s+(?:user\s+)?(?:confirmation|approval|permission)\s+(?:is\s+)?(?:needed|required))\b/gi;
const REQUIRES_CONFIRMATION_REASON = /\b(?:(?:requires?|needs?)\s+(?:user\s+)?(?:confirmation|approval|permission)|(?:should|must)\s+(?:be\s+)?(?:blocked|confirmed)|ask\s+(?:the\s+)?user(?:\s+first)?|(?:await|wait\s+for)\s+(?:the\s+)?(?:user(?:'s)?\s+)?(?:confirmation|approval|permission)|(?:request|obtain)\s+(?:the\s+)?(?:user(?:'s)?\s+)?(?:confirmation|approval|permission)|confirm\s+before\s+(?:proceeding|continuing)|(?:confirmation|approval|permission)\s+(?:is\s+recommended|(?:should|must|needs?\s+to)\s+(?:be\s+)?(?:requested|obtained|required|recommended)))\b|(?:需要|应当|必须)(?:用户)?(?:确认|授权|许可)|(?:询问|等待).{0,8}(?:用户)?(?:确认|授权|许可)/i;
const HAZARD_REASON = /\b(?:(?:this|it|the\s+(?:action|operation|command|request))\s+(?:is|appears|seems|looks)\s+(?!not\b)(?:(?:potentially\s+)?(?:dangerous|unsafe|hazardous|risky|harmful))|(?:could|may|might|can)\s+(?!not\b)(?:(?:be\s+)?(?:dangerous|unsafe|hazardous|risky|harmful|expose|leak|disclose)\b|(?:delete|destroy|overwrite|erase|remove|wipe|corrupt)\b[\s\S]{0,24}\b(?:data|files?|repository|repo|configuration|config)\b|cause\b[\s\S]{0,16}\bdata\s+loss\b|(?:send|transmit|upload|exfiltrate|leak|disclose|expose|reveal|publish)\b[\s\S]{0,32}\b(?:secrets?|credentials?|tokens?|keys?)\b)|(?:poses?|creates?|introduces?)\s+(?:a\s+)?(?:material\s+)?(?:hazard|risk|danger)|(?:risk|hazard|danger)\s+of)\b|(?:存在|造成|引入)(?:明确|具体|实质)?(?:危害|危险|风险)|(?:操作|动作|命令|请求)(?:很|是)?(?:危险|不安全)/i;

function reasonRequiresConfirmation(reason: string): boolean {
  return REQUIRES_CONFIRMATION_REASON.test(reason.replace(NEGATED_CONFIRMATION_REASON, ' '));
}
const CLASSIFIER_HAZARDS = new Set<ClassifierHazard>([
  'none',
  'protected_read',
  'outside_write',
  'destructive_loss',
  'credential_exposure',
  'network_exfiltration',
  'remote_code_execution',
  'dependency_poisoning',
  'production_change',
  'privilege_change',
  'intent_conflict',
]);

export function parseClassifierOutput(raw: string): ClassifierDecision {
  const contract = unwrapExclusiveMarkdownFence(raw);
  const decision = parseClassifierContract(contract);
  return decision.kind === 'unparseable' && contract !== raw
    ? { ...decision, raw }
    : decision;
}

function parseClassifierContract(raw: string): ClassifierDecision {
  const blockMatch = raw.match(BLOCK_RE);
  const hasStructuredMarker = STRUCTURED_MARKER_RE.test(raw);
  if (!hasStructuredMarker && blockMatch) {
    const legacyMatch = raw.match(LEGACY_CONTRACT_RE);
    return legacyMatch
      ? parseLegacyDecision(raw, legacyMatch)
      : unparseable(raw, 'legacy_format_violation', 'legacy_v1');
  }
  return parseStructuredDecision(raw, hasStructuredMarker ? 'structured_v2' : 'unknown');
}

function unwrapExclusiveMarkdownFence(raw: string): string {
  const match = /^\s*```(?:xml)?[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/i.exec(raw);
  return match?.[1] ?? raw;
}

function parseLegacyDecision(raw: string, blockMatch: RegExpMatchArray): ClassifierDecision {
  const verdict = blockMatch[1]!.toLowerCase();
  if (verdict !== 'yes' && verdict !== 'no') {
    return unparseable(raw, 'invalid_decision', 'legacy_v1');
  }

  const reason = truncateReason(blockMatch[2]?.trim() ?? '');

  if (verdict === 'yes') {
    return reason && !NO_HAZARD_REASON.test(reason)
      ? { kind: 'block', reason, protocol: 'legacy_v1' }
      : unparseable(
        raw,
        reason ? 'decision_hazard_conflict' : 'missing_reason',
        'legacy_v1',
      );
  }
  if (reasonRequiresConfirmation(reason) || HAZARD_REASON.test(reason)) {
    return unparseable(raw, 'decision_hazard_conflict', 'legacy_v1');
  }
  return { kind: 'allow', reason, protocol: 'legacy_v1' };
}

function parseStructuredDecision(
  raw: string,
  observedProtocol: ClassifierObservedProtocol,
): ClassifierDecision {
  const decisionMatch = raw.match(DECISION_RE);
  if (!decisionMatch) return unparseable(raw, 'missing_decision', observedProtocol);
  const decision = decisionMatch[1]?.trim().toLowerCase();
  if (decision !== 'allow' && decision !== 'ask') {
    return unparseable(raw, 'invalid_decision', 'structured_v2');
  }
  const hazardMatch = raw.match(HAZARD_RE);
  if (!hazardMatch) return unparseable(raw, 'missing_hazard', 'structured_v2');
  const hazardValue = hazardMatch[1]?.trim().toLowerCase();
  if (!hazardValue || !CLASSIFIER_HAZARDS.has(hazardValue as ClassifierHazard)) {
    return unparseable(raw, 'invalid_hazard', 'structured_v2');
  }
  if (!REASON_RE.test(raw)) return unparseable(raw, 'missing_reason', 'structured_v2');
  const contractMatch = raw.match(STRUCTURED_CONTRACT_RE);
  if (!contractMatch) {
    return unparseable(raw, 'structured_format_violation', 'structured_v2');
  }
  const hazard = hazardValue as ClassifierHazard;
  const reason = truncateReason(contractMatch[3]?.trim() ?? '');
  if (decision === 'allow') {
    const reasonConflictsWithAllow = reasonRequiresConfirmation(reason)
      || HAZARD_REASON.test(reason);
    return hazard === 'none' && !reasonConflictsWithAllow
      ? { kind: 'allow', reason, hazard, protocol: 'structured_v2' }
      : unparseable(raw, 'decision_hazard_conflict', 'structured_v2');
  }
  if (!reason) return unparseable(raw, 'missing_reason', 'structured_v2');
  return hazard !== 'none' && !NO_HAZARD_REASON.test(reason)
    ? { kind: 'block', reason, hazard, protocol: 'structured_v2' }
    : unparseable(raw, 'decision_hazard_conflict', 'structured_v2');
}

function unparseable(
  raw: string,
  failureCode: ClassifierParseFailureCode,
  observedProtocol: ClassifierObservedProtocol,
): ClassifierDecision {
  return { kind: 'unparseable', raw, failureCode, observedProtocol };
}

function truncateReason(reason: string): string {
  return reason.length > MAX_REASON_LEN
    ? `${reason.slice(0, MAX_REASON_LEN - 1)}…`
    : reason;
}
