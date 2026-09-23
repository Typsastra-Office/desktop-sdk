import type { ThreadMessageLike } from "@assistant-ui/react";

// Keep the conversation sent to the model bounded: the first user message (the
// task) plus the most recent messages. Tool results live inline in each
// assistant message, so whole messages are self-contained and safe to drop.
const MAX_HISTORY_MESSAGES = 14;

// Tool results in the history are shortened so a few large get_document_* calls
// cannot balloon the context (and slow down every following round).
const MAX_HISTORY_TOOL_RESULT = 1500;

type LoosePart = {
  type?: string;
  result?: unknown;
} & Record<string, unknown>;

const compactToolResults = (message: ThreadMessageLike): ThreadMessageLike => {
  if (typeof message.content === "string") return message;

  let changed = false;
  const content = message.content.map((part) => {
    const p = part as LoosePart;
    if (
      p &&
      p.type === "tool-call" &&
      typeof p.result === "string" &&
      p.result.length > MAX_HISTORY_TOOL_RESULT
    ) {
      changed = true;
      return {
        ...p,
        result: `${p.result.slice(0, MAX_HISTORY_TOOL_RESULT)}…[trimmed]`,
      } as unknown as (typeof message.content)[number];
    }
    return part;
  });

  return changed ? ({ ...message, content } as ThreadMessageLike) : message;
};

/**
 * Returns a compacted view of the conversation for the API request. It never
 * mutates the stored messages: it shortens large tool results and, when the
 * history is long, keeps the first message plus the most recent ones.
 */
export const trimConversationHistory = (
  messages: ThreadMessageLike[]
): ThreadMessageLike[] => {
  const compacted = messages.map(compactToolResults);

  if (compacted.length <= MAX_HISTORY_MESSAGES) return compacted;

  const first = compacted[0];
  const tail = compacted.slice(compacted.length - (MAX_HISTORY_MESSAGES - 1));
  return [first, ...tail];
};
