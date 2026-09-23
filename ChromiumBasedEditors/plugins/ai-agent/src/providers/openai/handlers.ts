import type {
  ReasoningMessagePart,
  ThreadMessageLike,
  ToolCallMessagePart,
} from "@assistant-ui/react";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";

/**
 * Extended delta type that includes reasoning_content for models like DeepSeek.
 */
type DeltaWithReasoning = ChatCompletionChunk.Choice["delta"] & {
  reasoning_content?: string;
};

/**
 * Generates a unique ID for reasoning parts.
 */
const generateReasoningId = (): string =>
  `reasoning-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

/**
 * Handles incoming reasoning content from a streaming chunk.
 * Creates or appends to a reasoning part (type: "reasoning").
 *
 * @param responseMessage - The current response being built
 * @param reasoningContent - The reasoning content string
 */
export const handleReasoningMessage = (
  responseMessage: ThreadMessageLike,
  reasoningContent: string
): ThreadMessageLike => {
  if (!reasoningContent) return responseMessage;
  if (!Array.isArray(responseMessage.content)) return responseMessage;

  const content = [...responseMessage.content];
  const lastPart = content[content.length - 1];

  // Case 1: Empty content or last part is not reasoning - create new reasoning part
  if (!lastPart || lastPart.type !== "reasoning") {
    content.push({
      type: "reasoning",
      text: reasoningContent,
    } as ReasoningMessagePart);
  }
  // Case 2: Last part is reasoning - append to it
  else {
    content[content.length - 1] = {
      ...lastPart,
      text: lastPart.text + reasoningContent,
    };
  }

  return { ...responseMessage, content };
};

/**
 * Finalizes the reasoning part by setting parentId.
 * Called when reasoning is complete (when regular content starts).
 *
 * @param responseMessage - The current response being built
 * @param addEmptyText - If true, adds an empty text part after reasoning (for end of stream)
 */
export const finalizeReasoningPart = (
  responseMessage: ThreadMessageLike,
  addEmptyText = false
): ThreadMessageLike => {
  if (!Array.isArray(responseMessage.content)) return responseMessage;

  const content = [...responseMessage.content];

  // Find the reasoning part and set parentId if not already set
  for (let i = 0; i < content.length; i++) {
    const part = content[i];
    if (part.type === "reasoning" && !part.parentId) {
      content[i] = {
        ...part,
        parentId: generateReasoningId(),
      };
    }
  }

  // Add empty text part if requested and last part is reasoning
  if (addEmptyText) {
    const lastPart = content[content.length - 1];
    if (lastPart?.type === "reasoning") {
      content.push({ type: "text", text: "" });
    }
  }

  return { ...responseMessage, content };
};

/**
 * Handles incoming text content from a streaming chunk.
 * Appends or creates text parts in the response message.
 *
 * @param responseMessage - The current response being built
 * @param chunk - The streaming chunk containing new text
 * @param afterToolCall - If true, always creates a new text part after tool calls
 *                        (prevents appending to pre-tool-call text)
 */
export const handleTextMessage = (
  responseMessage: ThreadMessageLike,
  chunk: ChatCompletionChunk.Choice,
  afterToolCall?: boolean
): ThreadMessageLike => {
  const delta = chunk.delta.content;
  if (!delta) return responseMessage;
  if (!Array.isArray(responseMessage.content)) return responseMessage;

  const content = [...responseMessage.content];
  const lastPart = content[content.length - 1];

  // Case 1: Empty content - create first text part
  if (!lastPart) {
    content.push({ type: "text", text: delta });
  }
  // Case 2: Last part is text - append to it
  else if (lastPart.type === "text") {
    content[content.length - 1] = { ...lastPart, text: lastPart.text + delta };
  }
  // Case 3: After reasoning or tool call - create new text part
  else if (lastPart.type === "reasoning" || afterToolCall) {
    content.push({ type: "text", text: delta });
  }

  return { ...responseMessage, content };
};

export type { DeltaWithReasoning };

type ToolCallDelta = {
  id?: string;
  function?: { name?: string; arguments?: string };
};

/**
 * Creates a new tool-call message part from a streaming delta.
 */
const createToolCallPart = (toolCall?: ToolCallDelta): ToolCallMessagePart =>
  ({
    type: "tool-call",
    args: {},
    argsText: toolCall?.function?.arguments ?? "",
    toolName: toolCall?.function?.name ?? "",
    toolCallId: toolCall?.id ?? "",
  }) as ToolCallMessagePart;

/**
 * Merges new tool call data into an existing tool-call part.
 * Tool calls stream incrementally, so we accumulate the arguments text
 * and attempt to parse them as JSON when complete.
 */
const mergeToolCall = (
  existing: ToolCallMessagePart,
  toolCall?: ToolCallDelta
): ToolCallMessagePart => {
  const argsText = existing.argsText + (toolCall?.function?.arguments ?? "");

  // Attempt to parse accumulated arguments as JSON
  let parsedArgs = {};
  try {
    parsedArgs = JSON.parse(argsText || "{}");
  } catch {
    // Arguments still incomplete, keep empty args until fully received
  }

  return {
    ...existing,
    args: parsedArgs,
    argsText,
    toolName: existing.toolName || toolCall?.function?.name || "",
    toolCallId: existing.toolCallId || toolCall?.id || "",
  };
};

/**
 * Handles incoming tool call data from a streaming chunk.
 *
 * A chunk that carries a tool-call id starts a new tool call and is matched to
 * an existing part by id (or appended as a new part). Chunks without an id are
 * argument continuations for the most recently started tool call. This matters
 * after a tool call: the response shell is cloned from the previous message, so
 * blindly merging into the last part would concatenate the new call's arguments
 * onto the previous call.
 */
export const handleToolCall = (
  responseMessage: ThreadMessageLike,
  chunk: ChatCompletionChunk.Choice
): ThreadMessageLike => {
  const toolCalls = chunk.delta.tool_calls;
  if (
    !toolCalls ||
    !Array.isArray(toolCalls) ||
    !Array.isArray(responseMessage.content)
  ) {
    return responseMessage;
  }

  const content = [...responseMessage.content];

  for (const toolCall of toolCalls) {
    const id = toolCall.id ?? "";

    let position = -1;

    if (id) {
      position = content.findIndex(
        (part) => part.type === "tool-call" && part.toolCallId === id
      );

      // The first chunk of a tool call may arrive without an id (or the id
      // arrives a chunk later); backfill into the most recent id-less part.
      if (position === -1) {
        const lastIndex = content.length - 1;
        if (
          lastIndex >= 0 &&
          content[lastIndex].type === "tool-call" &&
          !content[lastIndex].toolCallId
        ) {
          position = lastIndex;
        }
      }
    } else {
      const lastIndex = content.length - 1;
      if (lastIndex >= 0 && content[lastIndex].type === "tool-call") {
        position = lastIndex;
      }
    }

    if (position === -1) {
      content.push(createToolCallPart(toolCall));
    } else {
      content[position] = mergeToolCall(content[position], toolCall);
    }
  }

  return { ...responseMessage, content };
};
