import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { PromptPayload, ToolCall, ApiConfig, Message } from './types.js';
import { getToolDefinitions, executeTool } from './tools.js';

export async function runAgent(
  payload: PromptPayload,
  onStream?: (text: string) => void
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  try {
    console.error(`[DEBUG] Running agent with provider: ${payload.apiConfig.provider}`);
    console.error(`[DEBUG] Model: ${payload.apiConfig.model}`);
    console.error(`[DEBUG] API Key exists: ${!!payload.apiConfig.apiKey}`);

    const { provider } = payload.apiConfig;

    if (provider === 'anthropic') {
      return await runAnthropicAgent(payload, onStream);
    } else {
      return await runOpenAIAgent(payload, onStream);
    }
  } catch (err: any) {
    console.error(`[ERROR] runAgent failed: ${err.message}`);
    console.error(err.stack);
    throw err;
  }
}

async function runAnthropicAgent(
  payload: PromptPayload,
  onStream?: (text: string) => void
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const { apiKey, model, maxTokens, baseUrl } = payload.apiConfig;
  const client = new Anthropic({
    apiKey,
    baseURL: baseUrl,
  });

  const messages = buildAnthropicMessages(payload);
  const tools = getToolDefinitions();

  const toolCalls: ToolCall[] = [];
  let finalContent = '';

  // 循环处理工具调用
  let continueLoop = true;
  let iterations = 0;
  const maxIterations = 10;

  while (continueLoop && iterations < maxIterations) {
    iterations++;

    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: payload.session.systemPrompt,
      messages,
      tools: tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      })),
      stream: !!onStream,
    });

    if (onStream) {
      // 流式处理
      for await (const chunk of response as AsyncIterable<Anthropic.MessageStreamEvent>) {
        if (chunk.type === 'content_block_delta') {
          const text = (chunk.delta as any).text || '';
          finalContent += text;
          onStream(text);
        } else if (chunk.type === 'content_block_stop') {
          // 内容块结束
        }
      }

      // 流式模式下重新获取完整响应以检查工具调用
      const fullResponse = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: payload.session.systemPrompt,
        messages,
        tools: tools.map(t => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        })),
      });

      const toolUseBlocks = fullResponse.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
      );

      if (toolUseBlocks.length > 0) {
        // 处理工具调用
        for (const block of toolUseBlocks) {
          const toolCall: ToolCall = {
            id: block.id,
            name: block.name,
            arguments: block.input as Record<string, unknown>,
          };

          try {
            const result = await executeTool(block.name, block.input as Record<string, unknown>);
            toolCall.result = result;

            // 添加工具结果到消息
            messages.push({
              role: 'assistant',
              content: fullResponse.content as any,
            });
            messages.push({
              role: 'user',
              content: [{
                type: 'tool_result',
                tool_use_id: block.id,
                content: result,
              }],
            });
          } catch (err: any) {
            toolCall.result = `Error: ${err.message}`;
            messages.push({
              role: 'assistant',
              content: fullResponse.content as any,
            });
            messages.push({
              role: 'user',
              content: [{
                type: 'tool_result',
                tool_use_id: block.id,
                content: `Error: ${err.message}`,
              }],
            });
          }

          toolCalls.push(toolCall);
        }

        // 继续循环获取AI的最终响应
        finalContent = '';
        continue;
      }

      continueLoop = false;
    } else {
      // 非流式处理
      const nonStreamResponse = response as Anthropic.Messages.Message;
      const toolUseBlocks = nonStreamResponse.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
      );
      const textBlocks = nonStreamResponse.content.filter(
        (block): block is Anthropic.TextBlock => block.type === 'text'
      );

      finalContent = textBlocks.map(b => b.text).join('');

      if (toolUseBlocks.length > 0) {
        // 处理工具调用
        for (const block of toolUseBlocks) {
          const toolCall: ToolCall = {
            id: block.id,
            name: block.name,
            arguments: block.input as Record<string, unknown>,
          };

          try {
            const result = await executeTool(block.name, block.input as Record<string, unknown>);
            toolCall.result = result;

            messages.push({
              role: 'assistant',
              content: nonStreamResponse.content as any,
            });
            messages.push({
              role: 'user',
              content: [{
                type: 'tool_result',
                tool_use_id: block.id,
                content: result,
              }],
            });
          } catch (err: any) {
            toolCall.result = `Error: ${err.message}`;
            messages.push({
              role: 'assistant',
              content: nonStreamResponse.content as any,
            });
            messages.push({
              role: 'user',
              content: [{
                type: 'tool_result',
                tool_use_id: block.id,
                content: `Error: ${err.message}`,
              }],
            });
          }

          toolCalls.push(toolCall);
        }

        // 继续循环
        finalContent = '';
        continue;
      }

      continueLoop = false;
    }
  }

  return { content: finalContent, toolCalls };
}

async function runOpenAIAgent(
  payload: PromptPayload,
  onStream?: (text: string) => void
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const { apiKey, model, maxTokens, baseUrl } = payload.apiConfig;
  const client = new OpenAI({
    apiKey,
    baseURL: baseUrl,
  });

  const messages = buildOpenAIMessages(payload);
  const tools = getToolDefinitions();

  const toolCalls: ToolCall[] = [];
  let finalContent = '';

  let continueLoop = true;
  let iterations = 0;
  const maxIterations = 10;

  while (continueLoop && iterations < maxIterations) {
    iterations++;

    const completion = await client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      messages,
      tools: tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      })),
      stream: !!onStream,
    });

    if (onStream) {
      // 流式处理需要重新请求非流式版本来获取工具调用
      const fullCompletion = await client.chat.completions.create({
        model,
        max_tokens: maxTokens,
        messages,
        tools: tools.map(t => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        })),
      });

      const message = fullCompletion.choices[0]?.message;

      if (message?.content) {
        finalContent = message.content;
        onStream(message.content);
      }

      if (message?.tool_calls && message.tool_calls.length > 0) {
        for (const toolCall of message.tool_calls) {
          const args = JSON.parse(toolCall.function.arguments);
          const tc: ToolCall = {
            id: toolCall.id,
            name: toolCall.function.name,
            arguments: args,
          };

          try {
            const result = await executeTool(toolCall.function.name, args);
            tc.result = result;

            messages.push({
              role: 'assistant',
              content: message.content || '',
              tool_calls: [{
                id: toolCall.id,
                type: 'function',
                function: {
                  name: toolCall.function.name,
                  arguments: toolCall.function.arguments,
                },
              }],
            });
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: result,
            });
          } catch (err: any) {
            tc.result = `Error: ${err.message}`;
            messages.push({
              role: 'assistant',
              content: message.content || '',
              tool_calls: [{
                id: toolCall.id,
                type: 'function',
                function: {
                  name: toolCall.function.name,
                  arguments: toolCall.function.arguments,
                },
              }],
            });
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: `Error: ${err.message}`,
            });
          }

          toolCalls.push(tc);
        }

        finalContent = '';
        continue;
      }

      continueLoop = false;
    } else {
      const nonStreamCompletion = completion as OpenAI.Chat.Completions.ChatCompletion;
      const message = nonStreamCompletion.choices[0]?.message;

      finalContent = message?.content || '';

      if (message?.tool_calls && message.tool_calls.length > 0) {
        for (const toolCall of message.tool_calls) {
          const args = JSON.parse(toolCall.function.arguments);
          const tc: ToolCall = {
            id: toolCall.id,
            name: toolCall.function.name,
            arguments: args,
          };

          try {
            const result = await executeTool(toolCall.function.name, args);
            tc.result = result;

            messages.push({
              role: 'assistant',
              content: message.content || '',
              tool_calls: [{
                id: toolCall.id,
                type: 'function',
                function: {
                  name: toolCall.function.name,
                  arguments: toolCall.function.arguments,
                },
              }],
            });
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: result,
            });
          } catch (err: any) {
            tc.result = `Error: ${err.message}`;
            messages.push({
              role: 'assistant',
              content: message.content || '',
              tool_calls: [{
                id: toolCall.id,
                type: 'function',
                function: {
                  name: toolCall.function.name,
                  arguments: toolCall.function.arguments,
                },
              }],
            });
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: `Error: ${err.message}`,
            });
          }

          toolCalls.push(tc);
        }

        finalContent = '';
        continue;
      }

      continueLoop = false;
    }
  }

  return { content: finalContent, toolCalls };
}

function buildAnthropicMessages(payload: PromptPayload): Anthropic.Messages.MessageParam[] {
  const messages: Anthropic.Messages.MessageParam[] = [];

  // 添加历史消息
  for (const msg of payload.messages) {
    if (msg.role === 'user') {
      messages.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      messages.push({ role: 'assistant', content: msg.content });
    }
  }

  // 添加当前用户输入
  messages.push({ role: 'user', content: payload.userInput });

  return messages;
}

function buildOpenAIMessages(payload: PromptPayload): OpenAI.Chat.ChatCompletionMessageParam[] {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

  // System message
  messages.push({ role: 'system', content: payload.session.systemPrompt });

  // 添加历史消息
  for (const msg of payload.messages) {
    if (msg.role === 'user') {
      messages.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      messages.push({ role: 'assistant', content: msg.content });
    }
  }

  // 添加当前用户输入
  messages.push({ role: 'user', content: payload.userInput });

  return messages;
}
