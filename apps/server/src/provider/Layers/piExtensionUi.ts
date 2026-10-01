import type {
  ProviderApprovalDecision,
  ProviderUserInputAnswers,
  UserInputQuestion,
} from "@t3tools/contracts";
import { piRecordString, type PiRpcRecord } from "./PiRpc.ts";

export type PiDialogMethod = "confirm" | "select" | "input" | "editor";
export function piDialogMethod(event: PiRpcRecord): PiDialogMethod | undefined {
  const method = event.method;
  return method === "confirm" || method === "select" || method === "input" || method === "editor"
    ? method
    : undefined;
}

export function piDialogQuestion(
  id: string,
  method: PiDialogMethod,
  event: PiRpcRecord,
): UserInputQuestion {
  const title = piRecordString(event, "title")?.trim() || method;
  const prefill = method === "editor" ? piRecordString(event, "prefill") : undefined;
  const question =
    piRecordString(event, "message")?.trim() ||
    piRecordString(event, "placeholder")?.trim() ||
    title;
  return {
    id,
    header: title,
    // v1 has no editor/prefill surface; preserve the value in the question.
    question: prefill ? `${question}\n\nCurrent value:\n${prefill}` : question,
    options:
      method === "select" && Array.isArray(event.options)
        ? event.options
            .filter(
              (value): value is string => typeof value === "string" && value.trim().length > 0,
            )
            .map((value) => ({ label: value.trim(), value, description: "" }))
        : [],
    allowCustomAnswer: method !== "select",
    multiSelect: false,
  };
}

export function piDialogResponse(
  method: PiDialogMethod,
  questionId: string,
  decision?: ProviderApprovalDecision,
  answers?: ProviderUserInputAnswers,
): PiRpcRecord {
  if (method === "confirm") {
    if (decision === "accept" || decision === "acceptForSession" || decision === "acceptAlways")
      return { confirmed: true };
    if (decision === "decline") return { confirmed: false };
    return { cancelled: true };
  }
  // Empty text is a valid Pi response, distinct from cancellation/undefined.
  const answer = answers?.[questionId];
  return typeof answer === "string" ? { value: answer } : { cancelled: true };
}
