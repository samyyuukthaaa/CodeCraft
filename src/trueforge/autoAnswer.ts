// Non-interactive runs (scenario runner, probe): nobody can answer the agent's ask-user question, so it gets a
// fixed reply and the same turn resumes. Observed live (task2, 2026-11-22): without a responder the run ended as
// "unsupported" after 5 s, 0 files read. The interactive extension keeps its own responder (the panel asks the user).
import type { ClientToolCall, Responder } from './run';

export const AUTO_ANSWER = 'Proceed with your best judgment, make reasonable assumptions and do not ask again.';
/** The third question in one non-interactive run stops it (the first two are answered automatically). */
export const AUTO_ASK_LIMIT = 3;
export const ASK_LIMIT_MESSAGE = `Stopped: the agent asked the user ${AUTO_ASK_LIMIT} questions in one non-interactive run. Questions are answered automatically ("${AUTO_ANSWER}") only ${AUTO_ASK_LIMIT - 1} times; run it interactively to answer them yourself.`;

/** A responder that answers every ask-user question with AUTO_ANSWER and reports each one (for the run log). */
export function autoResponder(onAnswer?: (call: ClientToolCall, reply: string, n: number) => void): Responder {
  let asks = 0; // every question in this run (across retries and failover)
  let answered = 0;
  return {
    stopBeforeAnswer: () => (++asks >= AUTO_ASK_LIMIT ? ASK_LIMIT_MESSAGE : undefined),
    async answer(call) {
      answered++;
      onAnswer?.(call, AUTO_ANSWER, answered);
      return AUTO_ANSWER;
    },
  };
}
