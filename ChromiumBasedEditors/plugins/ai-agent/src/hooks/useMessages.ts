import type {
  AppendMessage,
  FileMessagePart,
  ImageMessagePart,
  ThreadMessageLike,
} from "@assistant-ui/react";
import { useEffect, useRef } from "react";
import { createMessage, updateMessage } from "@/database/messages";
import { getThread } from "@/database/metadata";
import type { Finding } from "@/lib/agentFindings";
import { provider, type SendMessageReturnType } from "@/providers";
import { createErrorResponse } from "@/providers/openai/constants";
import server from "@/servers";
import useAttachmentsStore from "@/store/useAttachmentsStore";
import useContextStore from "@/store/useContextStore";
import useFeedbackStore from "@/store/useFeedbackStore";
import useMessageStore from "@/store/useMessageStore";
import useModelsStore from "@/store/useModelsStore";
import useProviders from "@/store/useProviders";
import useServersStore from "@/store/useServersStore";
import useSkillsStore from "@/store/useSkillsStore";
import useThreadsStore from "@/store/useThreadsStore";

// Maximum number of self-review passes before the agent is allowed to finish.
const MAX_REVIEWS = 1;

// Hard cap on tool-call rounds per user message, so a model that keeps calling
// tools cannot loop forever and freeze the conversation.
const MAX_TOOL_ROUNDS = 20;

// Tool results (e.g. get_document_html) can be very large; truncate them so the
// conversation context does not balloon and degrade the model.
const MAX_TOOL_RESULT = 6000;

// Injected into the system prompt for a repair pass, together with the blocking
// findings collected from the document feedback snapshot.
const REVIEW_INSTRUCTION =
  "\n\n# Verify before finishing\nCall get_document_feedback and fix EVERY blocking finding by its nodeId (blocking codes: DOUBLE_NUMBERING, EMPTY_SECTION). Fix advisory findings (DIRECT_FORMAT_OVERRIDE, MISSING_CAPTION, TOC_MISSING) when reasonable. Fix problems IN PLACE with the editing tools; do NOT clear or rebuild the document. After fixing, call get_document_feedback again to confirm the blocking findings are gone. Then reply with a short summary and stop using tools.";

type UseMessagesProps = {
  isReady: boolean;
};

const useMessages = ({ isReady }: UseMessagesProps) => {
  const {
    messages,
    setIsStreamRunning,
    setIsRequestRunning,
    addMessage,

    updateLastMessage,
    fetchPrevMessages,
  } = useMessageStore();
  const { threadId, insertThread, insertNewMessageToThread } =
    useThreadsStore();
  const {
    manageToolData,
    callTools,
    checkAllowAlways,
    setAllowAlways,
    setManageToolData,
  } = useServersStore();
  const {
    attachmentFiles,
    clearAttachmentFiles,
    attachmentImages,
    clearAttachmentImages,
  } = useAttachmentsStore();
  const { items: contextItems, clearContext } = useContextStore();
  const { currentProvider } = useProviders();
  const { currentModel, extendedThinking } = useModelsStore();
  const { getActiveInstructions } = useSkillsStore();

  const threadIdRef = useRef(threadId);

  // Review-loop state: whether the agent made edits and how many reviews it did.
  const editsMadeRef = useRef(false);
  const reviewCountRef = useRef(0);
  const toolRoundsRef = useRef(0);

  useEffect(() => {
    if (!isReady) return;

    threadIdRef.current = threadId;

    fetchPrevMessages(threadId);
    clearAttachmentFiles();
  }, [threadId, isReady, fetchPrevMessages, clearAttachmentFiles]);

  const convertMessage = (message: ThreadMessageLike) => {
    return message;
  };

  const attachToolResult = (
    msg: ThreadMessageLike,
    idx: number,
    result: unknown
  ): ThreadMessageLike => {
    if (typeof msg.content === "string") return msg;

    const content = msg.content.map((item, index) =>
      index === idx ? { ...item, result } : item
    );

    return { ...msg, content };
  };

  const continueAfterTools = (
    msg: ThreadMessageLike,
    messageUID: string
  ) => {
    if (!provider) return;

    // Safety cap so a model that keeps calling tools cannot loop forever.
    toolRoundsRef.current += 1;
    if (toolRoundsRef.current > MAX_TOOL_ROUNDS) {
      setIsStreamRunning(false);
      setIsRequestRunning(false);
      return;
    }

    // Rebuild the API history from the full message list (which now contains
    // the assistant tool calls and their results) so it stays valid.
    provider.setCurrentProviderPrevMessages(useMessageStore.getState().messages);
    provider.setCurrentProviderInstructions(getActiveInstructions());

    const stream = provider.sendMessageAfterToolCall(msg, extendedThinking);
    if (stream) handleStream(stream, true, messageUID);
  };

  /**
   * Executes every pending tool call in order, pausing for approval when
   * needed, then continues the conversation once all results are attached.
   * The model may emit several tool calls in one turn; each must get a result
   * before the next request or the API rejects the continuation.
   */
  const runToolCalls = async (msg: ThreadMessageLike, messageUID: string) => {
    if (typeof msg.content === "string") return;

    let updated = msg;
    const total = (updated.content as unknown[]).length;

    for (let i = 0; i < total; i++) {
      const part = (updated.content as Array<Record<string, unknown>>)[i];

      if (part.type !== "tool-call" || part.result !== undefined) continue;

      const toolName = (part.toolName as string) ?? "";
      const type = server.getServerType(toolName);
      const name = toolName.replace(`${type}_`, "");

      // Track whether the agent modified the document (drives the review loop).
      if (!name.startsWith("get_")) {
        editsMadeRef.current = true;
      }

      if (!checkAllowAlways(type, name)) {
        updateLastMessage(updated);
        updateMessage(messageUID, updated);
        setManageToolData({ message: updated, idx: i, messageUID });
        return;
      }

      const rawResult = await callTools(
        toolName,
        (part.args as Record<string, unknown>) ?? {}
      );

      // Keep the "Document health" panel in sync when the agent reads feedback.
      if (name === "get_document_feedback" && typeof rawResult === "string") {
        try {
          const parsed = JSON.parse(rawResult) as { findings?: unknown };
          if (Array.isArray(parsed?.findings)) {
            useFeedbackStore
              .getState()
              .setFindings(parsed.findings as Finding[]);
          }
        } catch {
          // ignore malformed feedback
        }
      }

      const result =
        typeof rawResult === "string" && rawResult.length > MAX_TOOL_RESULT
          ? `${rawResult.slice(0, MAX_TOOL_RESULT)}…[truncated]`
          : (rawResult ?? "");

      updated = attachToolResult(updated, i, result);
      updateLastMessage(updated);
      updateMessage(messageUID, updated);
    }

    continueAfterTools(updated, messageUID);
  };

  const approveToolCall = (allowAlways: boolean) => {
    if (!manageToolData) return;

    const { message, idx, messageUID } = manageToolData;
    const part = (message.content as Array<Record<string, unknown>>)[idx];

    if (!part || part.type !== "tool-call") {
      setManageToolData(undefined);
      return;
    }

    const toolName = (part.toolName as string) ?? "";
    const type = server.getServerType(toolName);
    const name = toolName.replace(`${type}_`, "");

    if (allowAlways) {
      setAllowAlways(true, type, name);
    }

    setManageToolData(undefined);
    runToolCalls(message, messageUID);
  };

  const denyToolCall = () => {
    if (!manageToolData) return;

    const { message, idx, messageUID } = manageToolData;
    setManageToolData(undefined);

    const updated = attachToolResult(message, idx, "User denied tool call");
    updateLastMessage(updated);
    updateMessage(messageUID, updated);
    runToolCalls(updated, messageUID);
  };

  // Runs the document feedback snapshot and returns its findings. Used to
  // decide whether a repair pass is needed (findings-driven review).
  const evaluateDocument = async () => {
    try {
      const result = await server.callTools(
        "editor",
        "get_document_feedback",
        {}
      );
      const text =
        typeof result === "string" ? result : JSON.stringify(result ?? "");
      const parsed = JSON.parse(text) as {
        findings?: Array<{
          code: string;
          severity: string;
          nodeId: string;
          message: string;
        }>;
      };
      const findings = Array.isArray(parsed?.findings) ? parsed.findings : [];
      useFeedbackStore.getState().setFindings(findings);
      return findings;
    } catch {
      return [];
    }
  };

  const handleStream = async (
    stream: SendMessageReturnType,
    afterToolCall?: boolean,
    messageUIDProp?: string
  ) => {
    setIsStreamRunning(true);
    let initedMessage = !!afterToolCall;
    const messageUID =
      afterToolCall && messageUIDProp ? messageUIDProp : crypto.randomUUID();

    const failStream = (error: unknown) => {
      const errorMessage = createErrorResponse(error);

      if (!initedMessage) {
        addMessage(errorMessage);
        createMessage(threadId, messageUID, errorMessage);
        initedMessage = true;
      } else {
        updateMessage(messageUID, errorMessage);
        updateLastMessage(errorMessage);
      }

      setIsStreamRunning(false);
      setIsRequestRunning(false);
    };

    try {
      if (messages)
        for await (const message of stream) {
          if ("isEnd" in message) {
            if (threadIdRef.current !== threadId) {
              setIsStreamRunning(false);
              setIsRequestRunning(false);

              return;
            }
            if (message.responseMessage.status?.type === "incomplete") {
              addMessage(message.responseMessage);

              setIsStreamRunning(false);
              setIsRequestRunning(false);

              return;
            }
            const lastMessage = message.responseMessage;

            if (
              lastMessage?.role === "assistant" &&
              Array.isArray(lastMessage.content)
            ) {
              const toolCallIdx = lastMessage.content.findIndex(
                (c) => c.type === "tool-call" && c.result === undefined
              );

              if (toolCallIdx !== -1) {
                runToolCalls(lastMessage, messageUID);

                return;
              }
            }

            // Findings-driven repair loop: only continue if the document still
            // has blocking findings; otherwise finish without another round.
            if (editsMadeRef.current && reviewCountRef.current < MAX_REVIEWS) {
              const blocking = (await evaluateDocument()).filter(
                (f) => f.severity === "blocking"
              );

              if (blocking.length > 0) {
                reviewCountRef.current += 1;
                editsMadeRef.current = false;

                if (provider) {
                  provider.setCurrentProviderPrevMessages(
                    useMessageStore.getState().messages
                  );
                  provider.setCurrentProviderInstructions(
                    `${getActiveInstructions()}\n${REVIEW_INSTRUCTION}\n\n# Blocking findings to fix (by nodeId)\n${JSON.stringify(blocking, null, 2)}`
                  );

                  const reviewStream = provider.sendMessage(
                    [],
                    false,
                    undefined,
                    extendedThinking
                  );

                  if (reviewStream) {
                    handleStream(reviewStream, true, messageUID);
                    return;
                  }
                }
              }
            }

            setIsStreamRunning(false);
            setIsRequestRunning(false);

            return;
          }

          if (!initedMessage) {
            if (!afterToolCall) setIsRequestRunning(true);
            addMessage(message);
            createMessage(threadId, messageUID, message);
            initedMessage = true;
          } else {
            updateMessage(messageUID, message);

            if (threadIdRef.current === threadId) {
              updateLastMessage(message);
            }
          }
        }

      // The stream finished without an explicit end marker.
      setIsStreamRunning(false);
      setIsRequestRunning(false);
    } catch (error) {
      console.error("Message stream failed:", error);
      failStream(error);
    }
  };

  const onNew = async (message: AppendMessage) => {
    if (!provider) return;
    if (!currentProvider || !currentModel) return;
    if (message.content[0].type !== "text") return;

    editsMadeRef.current = false;
    reviewCountRef.current = 0;
    toolRoundsRef.current = 0;

    let fileContent: FileMessagePart[] = [];

    let imageContent: ImageMessagePart[] = [];

    if (attachmentFiles.length > 0) {
      fileContent = attachmentFiles.map((file) => ({
        type: "file",
        mimeType: JSON.stringify({ path: file.path, type: file.type }),
        data: file.content,
      }));

      clearAttachmentFiles();
    }

    if (attachmentImages.length > 0) {
      imageContent = attachmentImages.map((image) => ({
        type: "image",
        image: image.base64,
        name: image.name,
      }));

      clearAttachmentImages();
    }

    const contextText = contextItems
      .map((item) => `@${item.label}:\n${item.text}`)
      .join("\n\n");

    const userText = contextText
      ? `${contextText}\n\n${message.content[0].text}`
      : message.content[0].text;

    const content: ThreadMessageLike["content"] = [
      ...fileContent,
      ...imageContent,
      { type: "text", text: userText },
    ];

    clearContext();

    const userMessage: ThreadMessageLike = {
      role: "user",
      content,
      attachments: message.attachments,
    };

    const existingThread = await getThread(threadId);

    if (!existingThread) {
      let textForTitle = "";

      for (const msg of messages) {
        // Skip messages with errors
        if (msg.status?.type === "incomplete" && msg.status?.error) continue;

        textForTitle +=
          typeof msg.content === "string"
            ? msg.content
            : msg.content[0].type === "text"
              ? msg.content[0].text
              : "";

        textForTitle += "\n\n";
      }

      textForTitle += `\n\n${message.content[0].text}`;

      // Save all messages from the store to the database (skip error messages)
      for (const msg of messages) {
        // Skip messages with errors
        if (msg.status?.type === "incomplete" && msg.status?.error) continue;

        await createMessage(threadId, crypto.randomUUID(), msg);
      }

      // Save the new user message
      await createMessage(threadId, crypto.randomUUID(), userMessage);

      provider.createChatName(textForTitle).then(async (title) => {
        if (!title) return;

        insertThread(title, {
          provider: currentProvider,
          model: currentModel,
        });
      });
    } else {
      insertNewMessageToThread({
        provider: currentProvider,
        model: currentModel,
      });

      const createMessages = async () => {
        await createMessage(threadId, crypto.randomUUID(), userMessage);
      };

      createMessages();
    }

    provider.setCurrentProviderPrevMessages(useMessageStore.getState().messages);
    provider.setCurrentProviderInstructions(getActiveInstructions());

    addMessage(userMessage);

    const stream = provider.sendMessage([userMessage], extendedThinking);

    if (stream) handleStream(stream);
  };

  return {
    convertMessage,
    onNew,
    handleStream,
    approveToolCall,
    denyToolCall,
  };
};

export default useMessages;
