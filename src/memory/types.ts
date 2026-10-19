export type AnswerSource = "generated" | "exact" | "assisted";
export type KnowledgeState = "candidate" | "published" | "suspended" | "superseded" | "withdrawn";
export type FeedbackReason = "incorrect" | "outdated" | "irrelevant" | "presentation";

export interface SourceSnapshot {
  projectPath: string;
  projectId: string;
  branch: string;
  commit: string;
  key: string;
  clean: boolean;
  reason?: string;
}

export interface SourceEvidenceInput { path: string; startLine: number; endLine: number }
export interface SourceEvidence extends SourceEvidenceInput { blobHash: string; text: string }
export interface UsageReport {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  quality: "reported" | "estimated" | "unknown" | "no-model-call";
}

export interface AnswerRecord {
  id: string;
  version: string;
  requestId: string;
  historyId: string;
  question: string;
  answer: string;
  status: "completed" | "error" | "aborted" | "interrupted";
  source: AnswerSource;
  snapshot: SourceSnapshot;
  policyHash: string;
  knowledgeIds: string[];
  userEntryId?: string;
  assistantEntryIds: string[];
  usage: UsageReport;
  elapsedMs: number;
  createdAt: string;
}

export interface KnowledgeItem {
  id: string;
  versionId: string;
  revision: number;
  state: KnowledgeState;
  question: string;
  answer: string;
  conditions: string;
  snapshot: SourceSnapshot;
  policyHash: string;
  evidence: SourceEvidence[];
  sourceAnswerId: string;
  createdAt: string;
  updatedAt: string;
  up: number;
  down: number;
  applicable?: boolean;
  versions?: KnowledgeItem[];
  feedback?: Array<{ answerId: string; vote: "up" | "down"; reason?: FeedbackReason; comment?: string }>;
}

export interface FeedbackInput {
  clientId: string;
  vote: "up" | "down" | null;
  reason?: FeedbackReason;
  comment?: string;
}
export interface FeedbackResult {
  vote: "up" | "down" | null;
  up: number;
  down: number;
  knowledgeId?: string;
}
export interface ReviewInput {
  expectedRevision: number;
  action: "publish" | "revise" | "suspend" | "withdraw";
  question?: string;
  answer?: string;
  conditions?: string;
  evidence?: SourceEvidenceInput[];
  expectedSourceKey?: string;
  revalidate?: boolean;
}

export interface MemoryLibrary {
  projectPath: string;
  snapshot: SourceSnapshot;
  items: KnowledgeItem[];
  total: number;
  indexAvailable: boolean;
  indexError?: string;
}
export interface LookupInput { snapshot: SourceSnapshot; policyHash: string; question: string; limit?: number }
export interface KnowledgeIndexDocument {
  id: string;
  projectId: string;
  sourceKey: string;
  policyHash: string;
  text: string;
}
export interface IndexChange { seq: number; id: string; op: "upsert" | "delete"; document?: KnowledgeIndexDocument }
export interface KnowledgeIndex {
  sync(projectId: string, changes: IndexChange[]): Promise<void>;
  search(input: { projectId: string; sourceKey: string; policyHash: string; question: string; limit: number }): Promise<string[]>;
  close?(): Promise<void>;
  needsRebuild?(projectId: string): Promise<boolean>;
  rebuild?(projectId: string, documents: KnowledgeIndexDocument[]): Promise<void>;
}

export interface PendingReuse {
  requestId: string;
  historyId: string;
  question: string;
  originalLeaf: string | null;
  record: AnswerRecord;
}

/** All callers share this interface; native storage lives in a background worker. */
export interface MemoryService {
  snapshot(project: string): Promise<SourceSnapshot>;
  recordAnswer(record: AnswerRecord): Promise<void>;
  getAnswer(id: string): Promise<AnswerRecord | undefined>;
  findRequest(historyId: string, requestId: string): Promise<AnswerRecord | undefined>;
  list(project: string, options?: { state?: string; limit?: number; offset?: number }): Promise<MemoryLibrary>;
  getKnowledge(id: string): Promise<KnowledgeItem>;
  createCandidate(answerId: string): Promise<KnowledgeItem>;
  feedback(answerId: string, input: FeedbackInput): Promise<FeedbackResult>;
  getFeedback(answerId: string, clientId: string): Promise<FeedbackResult>;
  previewEvidence(id: string, input: { expectedRevision: number; expectedSourceKey: string; evidence: SourceEvidenceInput[] }): Promise<{ snapshot: SourceSnapshot; evidence: SourceEvidence[] }>;
  review(id: string, input: ReviewInput): Promise<KnowledgeItem>;
  lookupExact(input: LookupInput): Promise<KnowledgeItem | undefined>;
  search(input: LookupInput): Promise<KnowledgeItem[]>;
  validKnowledge(ids: string[]): Promise<boolean>;
  beginReuse(pending: PendingReuse): Promise<void>;
  finishReuse(requestId: string, historyId: string): Promise<void>;
  pendingReuses(historyId: string): Promise<PendingReuse[]>;
  interruptReuse(requestId: string, historyId: string): Promise<void>;
  close(): Promise<void>;
}

export interface AnswerMetadata {
  answerId: string;
  answerVersion: string;
  source: AnswerSource;
  knowledgeIds: string[];
  usage: UsageReport;
  stale?: boolean;
}
