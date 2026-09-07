/**
 * Stage 1 of relationship-strength scoring: deterministic feature extraction.
 *
 * Pure CPU, no network, no model. Everything here is computed from rows that
 * were genuinely ingested, and every field is a fact you could verify by hand
 * against the export. The LLM (stage 2, `score.ts`) only ever sees the compact
 * struct produced here — never a dump of message bodies. That is what keeps the
 * pipeline cheap, reproducible, and free of "the model read something private
 * and repeated it" failure modes.
 *
 * WHY HYBRID AT ALL
 * -----------------
 * Counting messages is something code does perfectly and a model does badly.
 * Weighing "eleven messages two years ago" against "three messages last week,
 * one of which booked a call" is a judgement call, which is what the model is
 * for. So: code extracts, the model judges.
 */

/** One person's raw interaction evidence inside a single import batch. */
export type RelationshipFeatures = {
  /** Messages the connection sent to the account owner. */
  inboundMessages: number;
  /** Messages the account owner sent to the connection. */
  outboundMessages: number;
  /** Messages on their threads whose direction could not be determined. */
  undirectedMessages: number;
  totalMessages: number;
  /**
   * inbound / (inbound + outbound), rounded to 2dp, or `null` when direction is
   * unknown for every message. Null means "cannot say", never zero.
   */
  replyRatio: number | null;
  /** True when messages exist in BOTH directions. */
  twoWay: boolean;
  /** Distinct LinkedIn conversation threads. */
  threadCount: number;
  /** Whole days since the most recent message, or null if there are none. */
  daysSinceLastMessage: number | null;
  /** Whole days since the first message, or null if there are none. */
  daysSinceFirstMessage: number | null;
  /** Whole days since `Connection.connectedOn`, or null when the export omits it. */
  connectionTenureDays: number | null;
  hasInvitation: boolean;
  hasInvitationNote: boolean;
  /**
   * A message on this thread reads as scheduling a live conversation (a call,
   * a meeting, a demo, a calendar link). Detected by regex over message text —
   * see `CALL_PATTERNS`. Never inferred by a model.
   */
  callScheduled: boolean;
  /** Which pattern fired, for the audit trail. Null when none did. */
  callSignal: string | null;
};

export function emptyFeatures(): RelationshipFeatures {
  return {
    inboundMessages: 0,
    outboundMessages: 0,
    undirectedMessages: 0,
    totalMessages: 0,
    replyRatio: null,
    twoWay: false,
    threadCount: 0,
    daysSinceLastMessage: null,
    daysSinceFirstMessage: null,
    connectionTenureDays: null,
    hasInvitation: false,
    hasInvitationNote: false,
    callScheduled: false,
    callSignal: null,
  };
}

/**
 * Phrases that indicate a live conversation was arranged, paired with the label
 * recorded in `callSignal`.
 *
 * Deliberately narrow. "Let's chat sometime" is not a scheduled call, and a
 * false positive here inflates a score the user is asked to act on. Anything
 * ambiguous is left out and the model simply never learns about it.
 */
const CALL_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "calendar link shared", pattern: /\b(calendly\.com|cal\.com\/|savvycal|hubspot\.com\/meetings|meetings\.hubspot|zcal\.co)\b/i },
  { label: "meeting link shared", pattern: /\b(zoom\.us\/j\/|meet\.google\.com\/|teams\.microsoft\.com\/l\/meetup)\b/i },
  { label: "call or meeting booked", pattern: /\b(booked|scheduled|confirmed|set up|locked in)\b[^.!?]{0,40}\b(call|meeting|demo|chat|catch[- ]?up)\b/i },
  { label: "call or meeting proposed with a time", pattern: /\b(call|meeting|demo|catch[- ]?up)\b[^.!?]{0,40}\b(monday|tuesday|wednesday|thursday|friday|tomorrow|next week|\d{1,2}\s?(am|pm))\b/i },
  { label: "invited to a call", pattern: /\b(sent|sending|shared|sharing)\b[^.!?]{0,30}\b(invite|invitation|calendar)\b/i },
];

/** Runs the call detector over one message body. */
export function detectCallSignal(text: string | null | undefined): string | null {
  if (!text) return null;
  // Long bodies are truncated: the scheduling language is conversational and
  // near the top, and scanning megabytes of pasted content is wasted work.
  const sample = text.slice(0, 2_000);
  for (const { label, pattern } of CALL_PATTERNS) {
    if (pattern.test(sample)) return label;
  }
  return null;
}

/** One message row, reduced to what feature extraction needs. */
export type MessageFact = {
  senderIsUser: boolean | null;
  sentAt: Date | null;
  conversationId: string | null;
};

export function buildFeatures({
  messages,
  callSignal,
  hasInvitation,
  hasInvitationNote,
  connectedOn,
  now = new Date(),
}: {
  messages: MessageFact[];
  callSignal: string | null;
  hasInvitation: boolean;
  hasInvitationNote: boolean;
  connectedOn: Date | null;
  now?: Date;
}): RelationshipFeatures {
  const features = emptyFeatures();
  features.hasInvitation = hasInvitation;
  features.hasInvitationNote = hasInvitationNote;
  features.callScheduled = callSignal !== null;
  features.callSignal = callSignal;

  const threads = new Set<string>();
  let first: Date | null = null;
  let last: Date | null = null;

  for (const message of messages) {
    if (message.senderIsUser === true) features.outboundMessages += 1;
    else if (message.senderIsUser === false) features.inboundMessages += 1;
    else features.undirectedMessages += 1;

    if (message.conversationId) threads.add(message.conversationId);
    if (message.sentAt) {
      if (!first || message.sentAt < first) first = message.sentAt;
      if (!last || message.sentAt > last) last = message.sentAt;
    }
  }

  features.totalMessages =
    features.inboundMessages + features.outboundMessages + features.undirectedMessages;
  // A thread with no conversationId still happened; fall back to "one thread"
  // rather than reporting zero threads alongside a non-zero message count.
  features.threadCount = threads.size > 0 ? threads.size : features.totalMessages > 0 ? 1 : 0;

  const directed = features.inboundMessages + features.outboundMessages;
  features.replyRatio =
    directed > 0 ? Math.round((features.inboundMessages / directed) * 100) / 100 : null;
  features.twoWay = features.inboundMessages > 0 && features.outboundMessages > 0;

  features.daysSinceLastMessage = last ? wholeDaysBetween(last, now) : null;
  features.daysSinceFirstMessage = first ? wholeDaysBetween(first, now) : null;
  features.connectionTenureDays = connectedOn ? wholeDaysBetween(connectedOn, now) : null;

  return features;
}

/**
 * True when there is enough evidence to be worth scoring at all.
 *
 * This is the single biggest cost control in the pipeline: a connection with no
 * message and no invitation note gets NO row and no model call, and the UI
 * renders "not yet scored". Sending "zero of everything" to an LLM buys nothing
 * but a bill.
 */
export function hasMeaningfulSignal(features: RelationshipFeatures): boolean {
  return features.totalMessages > 0 || features.hasInvitationNote;
}

/**
 * Rough evidence weight, used ONLY to decide which connections make the capped
 * scoring shortlist when a user has more scorable people than the per-run
 * budget. Not a score, never persisted, never shown.
 */
export function evidenceWeight(features: RelationshipFeatures): number {
  let weight = features.totalMessages * 2;
  if (features.twoWay) weight += 10;
  if (features.callScheduled) weight += 15;
  if (features.hasInvitationNote) weight += 2;
  if (features.daysSinceLastMessage !== null && features.daysSinceLastMessage <= 180) weight += 8;
  return weight;
}

/**
 * The deterministic score, used when no model is available (or a batch
 * degrades). Same shape of judgement as the model's, expressed as arithmetic —
 * so the feature always works, just labelled `heuristic` rather than `ai`.
 */
export function heuristicScore(features: RelationshipFeatures): {
  score: number;
  reasons: string[];
} {
  const reasons: string[] = [];
  let score = 0;

  if (features.totalMessages > 0) {
    score += Math.min(35, features.totalMessages * 4);
    reasons.push(
      `${features.totalMessages} message${features.totalMessages === 1 ? "" : "s"} exchanged`,
    );
  }
  if (features.twoWay) {
    score += 22;
    reasons.push("Two-way conversation");
  } else if (features.inboundMessages > 0) {
    score += 10;
    reasons.push("They reached out");
  }
  if (features.callScheduled) {
    score += 18;
    reasons.push(`Live conversation arranged (${features.callSignal})`);
  }
  if (features.daysSinceLastMessage !== null) {
    if (features.daysSinceLastMessage <= 90) {
      score += 15;
      reasons.push("Messaged in the last 90 days");
    } else if (features.daysSinceLastMessage <= 365) {
      score += 8;
      reasons.push("Messaged in the last year");
    }
  }
  if (features.connectionTenureDays !== null) {
    if (features.connectionTenureDays >= 730) {
      score += 8;
      reasons.push("Connected for 2+ years");
    } else if (features.connectionTenureDays >= 365) {
      score += 4;
      reasons.push("Connected for 1+ year");
    }
  }
  if (features.hasInvitationNote) {
    score += 4;
    reasons.push("Invitation included a personal note");
  }

  if (reasons.length === 0) reasons.push("No interaction found in this import");
  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons };
}

function wholeDaysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor(Math.abs(to.getTime() - from.getTime()) / 86_400_000));
}
