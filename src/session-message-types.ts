export type PendingMessageMode = "steer" | "followUp";

export interface PendingSessionMessage {
  id: string;
  question: string;
  mode: PendingMessageMode;
  targetRequestId?: string;
  createdAt: number;
  status: "pending" | "unapplied";
  reuse?: "auto" | "bypass";
}

export interface SessionMessageState {
  revision: number;
  activeRequestId: string | null;
  pending: PendingSessionMessage[];
}

export interface SteeringApplied {
  requestId: string;
  question: string;
  targetRequestId: string;
}
