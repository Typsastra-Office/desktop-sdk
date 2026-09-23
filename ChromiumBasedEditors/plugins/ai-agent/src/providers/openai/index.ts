import type { ThreadMessageLike } from "@assistant-ui/react";
import cloneDeep from "lodash.clonedeep";
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionSystemMessageParam,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions";
import type { Model as OpenAIModel } from "openai/resources/models";
import type { Model, TMCPItem, TProvider } from "@/lib/types";
import { AbstractBaseProvider, type TData, type TErrorData } from "../base";
import { getErrorCode, ProviderErrors } from "../errors";
import { CREATE_TITLE_SYSTEM_PROMPT } from "../prompts";
import {
  createEmptyResponse,
  createErrorResponse,
  generateFallbackToolCallId,
} from "./constants";
import {
  type DeltaWithReasoning,
  finalizeReasoningPart,
  handleReasoningMessage,
  handleTextMessage,
  handleToolCall,
} from "./handlers";
import { openaiInfo } from "./info";
import {
  convertMessagesToModelFormat,
  convertToolsToModelFormat,
} from "./utils";

class OpenAIProvider extends AbstractBaseProvider<
  ChatCompletionTool,
  ChatCompletionMessageParam,
  OpenAI
> {
  // Abort controller for the in-flight stream, used to stop on demand.
  private activeStreamController?: AbortController;

  // Stop the current response: set the flag and abort the request so the
  // stream ends immediately even if the model is not producing chunks.
  stopMessage = (): void => {
    this.stopFlag = true;
    this.activeStreamController?.abort();
  };

  // ============================================
  // Private Helper Methods
  // ============================================

  /**
   * Creates a new OpenAI client with the given credentials.
   * Centralizes client creation to avoid duplication.
   * Protected to allow subclasses (e.g., OpenRouter) to reuse.
   */
  protected createClient(apiKey?: string, baseURL?: string): OpenAI {
    return new OpenAI({
      apiKey,
      baseURL,
      dangerouslyAllowBrowser: true,
    });
  }

  /**
   * Builds a system message in OpenAI format.
   */
  private buildSystemMessage(
    content: string
  ): ChatCompletionSystemMessageParam {
    return { role: "system", content };
  }

  /**
   * Creates the initial response object for streaming.
   * If continuing after a tool call, clones the existing message to preserve tool calls.
   */
  private createResponseShell(
    afterToolCall?: boolean,
    existingMessage?: ThreadMessageLike
  ): ThreadMessageLike {
    if (afterToolCall && existingMessage) {
      return cloneDeep(existingMessage);
    }
    return createEmptyResponse();
  }

  /**
   * Appends messages to the conversation history.
   */
  private pushHistory(messages: ChatCompletionMessageParam[]): void {
    this.prevMessages.push(...messages);
  }

  /**
   * Converts and appends a single message to history.
   */
  private pushSingleMessage(message: ThreadMessageLike): void {
    const providerMsg = convertMessagesToModelFormat([message]);
    this.pushHistory(providerMsg);
  }

  /**
   * Filters response content after a tool call to remove duplicated content.
   * Keeps all tool-calls and only new text content (content added after the original message).
   */
  private filterAfterToolCallContent(
    responseMessage: ThreadMessageLike,
    originalMessage?: ThreadMessageLike
  ): ThreadMessageLike {
    const currentContent = responseMessage.content;

    // Skip filtering for string content or missing original
    const shouldSkip =
      typeof currentContent === "string" ||
      !originalMessage ||
      typeof originalMessage.content === "string";

    if (shouldSkip) return responseMessage;

    const originalLength = originalMessage.content.length;
    const filtered = currentContent.filter((part, index) => {
      // Always keep tool-calls
      if (part.type === "tool-call") return true;
      // Only keep new content (added after original)
      return index >= originalLength;
    });

    return { ...responseMessage, content: filtered };
  }

  // ============================================
  // Public Configuration Methods
  // ============================================

  setProvider = (provider: TProvider): void => {
    this.provider = provider;
    this.client = this.createClient(provider.key, provider.baseUrl);

    if (provider.key) this.setApiKey(provider.key);
    if (provider.baseUrl) this.setUrl(provider.baseUrl);
  };

  setPrevMessages = (prevMessages: ThreadMessageLike[]): void => {
    this.prevMessages = convertMessagesToModelFormat(prevMessages);
  };

  setTools = (tools: TMCPItem[]): void => {
    this.tools = convertToolsToModelFormat(tools);
  };

  // ============================================
  // Chat Operations
  // ============================================

  async createChatName(message: string) {
    try {
      if (!this.client) return "";

      const systemMessage = this.buildSystemMessage(CREATE_TITLE_SYSTEM_PROMPT);

      const response = await this.client.chat.completions.create({
        messages: [systemMessage, { role: "user", content: message }],
        model: this.modelKey,
        stream: false,
      });

      const title = response.choices[0].message.content;

      return title ?? message.substring(0, 25);
    } catch {
      return "";
    }
  }

  async getStream(
    systemMessage: ChatCompletionSystemMessageParam,
    convertedMessages: ChatCompletionMessageParam[],
    withThinking?: boolean
  ) {
    if (!this.client) return;

    const modelThinking =
      this.isReasoning ||
      openaiInfo.reasoningModels.some((modelId) =>
        this.modelKey.includes(modelId)
      );

    const reasoning_effort =
      withThinking && modelThinking ? "medium" : undefined;

    const controller = new AbortController();
    this.activeStreamController = controller;

    const stream = await this.client.chat.completions.create({
      messages: [systemMessage, ...this.prevMessages, ...convertedMessages],
      model: this.modelKey,
      tools: this.tools,
      stream: true,
      reasoning_effort,
      signal: controller.signal,
    });

    return stream;
  }

  /**
   * Sends a message and streams the response.
   *
   * @param messages - New messages to send
   * @param afterToolCall - Whether this is a continuation after a tool call
   * @param previousMessage - The previous message (used when afterToolCall is true)
   */
  async *sendMessage(
    messages: ThreadMessageLike[],
    afterToolCall?: boolean,
    previousMessage?: ThreadMessageLike,
    withThinking?: boolean
  ): AsyncGenerator<
    ThreadMessageLike | { isEnd: true; responseMessage: ThreadMessageLike }
  > {
    if (!this.client) return;

    let responseMessage = this.createResponseShell(
      afterToolCall,
      previousMessage
    );

    try {
      const convertedMessages = convertMessagesToModelFormat(messages);
      const systemMessage = this.buildSystemMessage(this.systemPrompt);

      const stream = await this.getStream(
        systemMessage,
        convertedMessages,
        withThinking
      );

      if (!stream) return;

      this.pushHistory(convertedMessages);

      let isStreamComplete = false;
      let hasUnfinalizedReasoning = false;

      for await (const streamEvent of stream) {
        // Process each chunk in the stream event
        for (const chunk of streamEvent.choices) {
          if (isStreamComplete) break;

          const delta = chunk.delta as DeltaWithReasoning;

          // Handle stream completion
          if (chunk.finish_reason) {
            // Finalize reasoning if stream ends without text content
            if (hasUnfinalizedReasoning) {
              responseMessage = finalizeReasoningPart(responseMessage, true);
            }

            responseMessage = afterToolCall
              ? this.filterAfterToolCallContent(
                  responseMessage,
                  previousMessage
                )
              : responseMessage;

            this.pushSingleMessage(responseMessage);
            isStreamComplete = true;
            break;
          }

          // Handle reasoning content (e.g., DeepSeek thinking)
          if (delta.reasoning_content) {
            hasUnfinalizedReasoning = true;
            responseMessage = handleReasoningMessage(
              responseMessage,
              delta.reasoning_content
            );
          }

          // Handle text content
          if (delta.content) {
            // Finalize reasoning when regular content starts
            if (hasUnfinalizedReasoning) {
              responseMessage = finalizeReasoningPart(responseMessage);
              hasUnfinalizedReasoning = false;
            }
            responseMessage = handleTextMessage(
              responseMessage,
              chunk,
              afterToolCall
            );
          }

          // Handle tool calls
          if (delta.tool_calls && typeof responseMessage.content !== "string") {
            // Finalize reasoning when tool calls start
            if (hasUnfinalizedReasoning) {
              responseMessage = finalizeReasoningPart(responseMessage);
              hasUnfinalizedReasoning = false;
            }
            responseMessage = handleToolCall(responseMessage, chunk);
          }
        }

        // Handle user-initiated stop
        if (this.stopFlag) {
          // Finalize reasoning if user stops during reasoning
          if (hasUnfinalizedReasoning) {
            responseMessage = finalizeReasoningPart(responseMessage, true);
          }
          this.pushSingleMessage(responseMessage);
          stream.controller.abort();
          this.stopFlag = false;

          yield { isEnd: true, responseMessage };
          continue;
        }

        // Yield final response if stream is complete
        if (isStreamComplete) {
          yield { isEnd: true, responseMessage };
          return;
        }

        // Yield intermediate response for UI updates
        yield responseMessage;
      }
    } catch (error) {
      if ((error as { name?: string })?.name === "AbortError") {
        this.stopFlag = false;
        yield { isEnd: true, responseMessage };
        return;
      }

      console.error("OpenAI sendMessage error:", error);
      yield {
        isEnd: true,
        responseMessage: createErrorResponse(error),
      };
    }
  }

  /**
   * Continues the conversation after a tool call has been executed.
   * Extracts the tool result and sends it back to the model.
   */
  async *sendMessageAfterToolCall(
    message: ThreadMessageLike,
    withThinking?: boolean
  ): AsyncGenerator<
    ThreadMessageLike | { isEnd: true; responseMessage: ThreadMessageLike }
  > {
    if (typeof message.content === "string") return message;

    // A single assistant turn can contain several tool calls; every one needs
    // a matching tool message or the API rejects the next request.
    const toolResults: ChatCompletionToolMessageParam[] = [];

    for (const part of message.content) {
      if (part.type !== "tool-call" || part.result === undefined) continue;

      toolResults.push({
        role: "tool",
        content: part.result,
        tool_call_id: part.toolCallId ?? generateFallbackToolCallId(),
      });
    }

    if (!toolResults.length) return message;

    this.pushHistory(toolResults);
    yield* this.sendMessage([], true, message, withThinking);

    return message;
  }

  // ============================================
  // Provider Info Methods
  // ============================================

  getName = (): string => openaiInfo.name;

  getBaseUrl = (): string => openaiInfo.baseUrl;

  // ============================================
  // Provider Validation & Model Fetching
  // ============================================

  checkProvider = async (data: TData): Promise<boolean | TErrorData> => {
    const client = this.createClient(data.apiKey, data.url);

    try {
      await client.models.list();
      return true;
    } catch (error) {
      const errorCode = getErrorCode(error);
      const isInvalidKey = errorCode === "invalid_api_key";
      if (isInvalidKey) return ProviderErrors.invalidKey();

      if (errorCode === 404) {
        return ProviderErrors.invalidUrl();
      }

      return data.apiKey
        ? ProviderErrors.invalidKey()
        : ProviderErrors.emptyKey();
    }
  };

  getProviderModels = async (data: TData): Promise<Model[]> => {
    const client = this.createClient(data.apiKey, data.url);
    const response: OpenAIModel[] = (await client.models.list()).data;

    return response
      .filter((model) => openaiInfo.modelFilters.includes(model.id))
      .map((model) => {
        const baseName =
          openaiInfo.modelNames[model.id] || model.id.toUpperCase();

        return {
          id: `${model.id}`,
          name: baseName,
          provider: "openai" as const,
          reasoning: openaiInfo.reasoningModels.includes(model.id),
        };
      });
  };
}

const openaiProvider = new OpenAIProvider();

export { OpenAIProvider, openaiProvider };
