/**
 * /lib/claude-agent.ts
 *
 * Multi-Provider Real AI Reasoning Layer for Recovery Engine.
 *
 * Runs REAL LLM calls via:
 *  1. Google Gemini (Gemini 3.5 Flash-Lite / 3.5 Flash) via GEMINI_API_KEY
 *  2. Anthropic (Claude 3.5 Haiku) via ANTHROPIC_API_KEY
 *  3. OpenAI (GPT-4o-mini) via OPENAI_API_KEY
 *
 * Includes an intelligent memory cache for batch stability and automatic 429 backoff.
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { TransactionInput, PolicyConfigInput, PolicyAction } from './policy-engine';

export type ClaudeRecommendation = {
  recommendedAction: PolicyAction;
  reasoning: string;
  isRealApi: boolean;
  model: string;
  provider: string;
};

const SYSTEM_PROMPT = `You are RecoverAI's Chief Recovery Agent for Indian eCommerce & SaaS payments.
Analyze the provided transaction context and recommend the best intervention strategy.

Available actions:
- auto_retry: Re-attempt payment through gateway/network.
- send_nudge: Send customer SMS/WhatsApp payment link or cart reminder.
- request_approval: Request customer authentication/2FA approval for subscriptions.
- stop_unrecoverable: Stop recovery to prevent customer annoyance, compliance breach, or repeated declines.
- no_action: Defer action for now.

You must respond in strict JSON format:
{
  "recommendedAction": "auto_retry" | "send_nudge" | "request_approval" | "stop_unrecoverable" | "no_action",
  "reasoning": "1-2 concise, specific sentences explaining your rationale based on customer tier, error reason, amount, and channel."
}`;

// In-memory cache for batch stability across identical transaction signatures
const inferenceCache = new Map<string, ClaudeRecommendation>();

function buildCacheKey(tx: TransactionInput): string {
  const abandonHrs = (tx as any).abandonedAt
    ? ((Date.now() - new Date((tx as any).abandonedAt).getTime()) / (1000 * 60 * 60)).toFixed(0)
    : 'none';
  return `${tx.type}:${tx.source}:${tx.reasonCode}:${tx.amountPaise}:${tx.customerTier}:${tx.retryCount}:${tx.nudgeCount}:${abandonHrs}`;
}

function buildUserContent(transaction: TransactionInput): string {
  return JSON.stringify({
    transactionId: transaction.id,
    externalPaymentId: (transaction as any).externalPaymentId,
    amountPaise: transaction.amountPaise,
    amountINR: transaction.amountPaise / 100,
    source: transaction.source,
    reasonCode: transaction.reasonCode,
    type: transaction.type,
    customerTier: transaction.customerTier || 'standard',
    retryCount: transaction.retryCount,
    nudgeCount: transaction.nudgeCount,
    hoursSinceAbandonment: (transaction as any).abandonedAt
      ? ((Date.now() - new Date((transaction as any).abandonedAt).getTime()) / (1000 * 60 * 60)).toFixed(1)
      : null,
  });
}

function parseModelJson(rawText: string): { recommendedAction: PolicyAction; reasoning: string } {
  const cleaned = rawText.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Failed to extract JSON from AI response: ${rawText}`);
  }
  const parsed = JSON.parse(jsonMatch[0]);
  const actionRaw = (parsed.recommendedAction || parsed.action || '').toLowerCase().replace(/[\s-]/g, '_');
  
  const validActions: PolicyAction[] = ['auto_retry', 'send_nudge', 'request_approval', 'stop_unrecoverable', 'no_action'];
  if (!validActions.includes(actionRaw as PolicyAction)) {
    throw new Error(`Invalid recommendedAction returned by model: ${parsed.recommendedAction || actionRaw}`);
  }

  return {
    recommendedAction: actionRaw as PolicyAction,
    reasoning: parsed.reasoning || parsed.reason || 'AI recommendation based on transaction context.',
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function recommendAction(
  transaction: TransactionInput,
  policyConfig: PolicyConfigInput,
  skipCache = false,
): Promise<ClaudeRecommendation> {
  const cacheKey = buildCacheKey(transaction);
  if (!skipCache && inferenceCache.has(cacheKey)) {
    return { ...inferenceCache.get(cacheKey)! };
  }

  const userContent = buildUserContent(transaction);

  // 1. Google Gemini (Primary high-speed live model)
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (geminiKey && geminiKey.trim() !== '') {
    const candidateModels = [
      process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
      'gemini-3.5-flash',
    ];

    const genAI = new GoogleGenerativeAI(geminiKey);

    for (const modelName of candidateModels) {
      for (let attempt = 1; attempt <= 6; attempt++) {
        try {
          const model = genAI.getGenerativeModel({
            model: modelName,
            systemInstruction: SYSTEM_PROMPT,
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.2,
            },
          });

          const result = await model.generateContent(userContent);
          const text = result.response.text();
          const parsed = parseModelJson(text);
          const rec: ClaudeRecommendation = {
            recommendedAction: parsed.recommendedAction,
            reasoning: parsed.reasoning,
            isRealApi: true,
            model: modelName,
            provider: 'Google Gemini',
          };
          inferenceCache.set(cacheKey, rec);
          return rec;
        } catch (err: any) {
          const is429 = err?.status === 429 || err?.message?.includes('429') || err?.message?.includes('quota') || err?.message?.includes('ResourceExhausted');
          if (is429 && attempt < 6) {
            console.log(`    ↳ [Quota backoff: pausing ${attempt * 6}s before retry...]`);
            await sleep(attempt * 6000);
            continue;
          }
          const is503 = err?.status === 503 || err?.message?.includes('503') || err?.message?.includes('high demand');
          if (is503 && attempt < 6) {
            await sleep(attempt * 2000);
            continue;
          }
          break;
        }
      }
    }
  }

  // 2. Anthropic Claude
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey && anthropicKey.trim() !== '' && !anthropicKey.includes('your_')) {
    try {
      const model = process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest';
      const workspaceId = process.env.ANTHROPIC_WORKSPACE_ID;
      const anthropic = new Anthropic({
        apiKey: anthropicKey,
        defaultHeaders: workspaceId ? { 'anthropic-workspace-id': workspaceId } : undefined,
      });

      const response = await anthropic.messages.create({
        model,
        max_tokens: 300,
        temperature: 0.2,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      });

      const text = response.content[0].type === 'text' ? response.content[0].text : '';
      const parsed = parseModelJson(text);

      const rec: ClaudeRecommendation = {
        recommendedAction: parsed.recommendedAction,
        reasoning: parsed.reasoning,
        isRealApi: true,
        model,
        provider: 'Anthropic Claude',
      };
      inferenceCache.set(cacheKey, rec);
      return rec;
    } catch (err: any) {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error(`Anthropic API failed (${err?.message || err}).`);
      }
    }
  }

  // 3. OpenAI
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey && openaiKey.trim() !== '') {
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'OpenAI error');
    const text = data.choices[0].message.content;
    const parsed = parseModelJson(text);
    const rec: ClaudeRecommendation = {
      recommendedAction: parsed.recommendedAction,
      reasoning: parsed.reasoning,
      isRealApi: true,
      model,
      provider: 'OpenAI GPT',
    };
    inferenceCache.set(cacheKey, rec);
    return rec;
  }

  throw new Error(
    `❌ FATAL: Real AI API calls failed. Please check your network connection or API status.`
  );
}
