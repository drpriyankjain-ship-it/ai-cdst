/**
 * CDST — LLM Client
 * ==================
 * Shared Gemini client instance imported by all stage files.
 * API key is read from the GEMINI_API_KEY environment variable.
 *
 * Direct port of llm_client.py
 */

import { GoogleGenAI } from '@google/genai';

const gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const CASCADE_STATUSES = new Set([503, 404, 429]);

const _usageLog = [];

/**
 * Drain and return all usage entries accumulated since the last call.
 */
export function popUsageLog() {
  const entries = [..._usageLog];
  _usageLog.length = 0;
  return entries;
}

/**
 * Extract full text from a Gemini response, concatenating all parts.
 */
export function responseText(response) {
  try {
    const parts = response.candidates[0].content.parts;
    return parts
      .filter(p => p.text)
      .map(p => p.text)
      .join('');
  } catch {
    return response.text || '';
  }
}

/**
 * Parse JSON from a Gemini response, tolerating markdown code fences.
 */
export function parseJsonResponse(text) {
  let t = text.trim();
  // Strip ```json ... ``` or ``` ... ``` fences
  t = t.replace(/^```(?:json)?\s*/, '');
  t = t.replace(/\s*```$/, '');
  t = t.trim();

  try {
    return JSON.parse(t);
  } catch {
    // noop
  }

  // Last resort: find first { or [
  for (const ch of ['{', '[']) {
    const idx = t.indexOf(ch);
    if (idx !== -1) {
      try {
        return JSON.parse(t.slice(idx));
      } catch {
        // noop
      }
    }
  }

  console.log(`\nDEBUG raw response.text (${text.length} chars):\n${text.slice(0, 1000)}\n`);
  throw new Error('Cannot parse JSON from Gemini response — see DEBUG above');
}

/**
 * Try each model in order; cascade to the next on 503/404/429.
 */
export async function generateWithCascade(models, contents, config = {}) {
  let lastErr = null;
  for (const model of models) {
    try {
      // Strip thinkingConfig for models that don't support it (non-2.5)
      let modelConfig = { ...config };
      if (!model.includes('2.5') && modelConfig.thinkingConfig) {
        delete modelConfig.thinkingConfig;
      }
      const response = await gemini.models.generateContent({
        model,
        contents,
        config: modelConfig,
      });
      const u = response.usageMetadata;
      if (u) {
        _usageLog.push({
          model,
          input_tokens: u.promptTokenCount || 0,
          output_tokens: u.candidatesTokenCount || 0,
        });
      }
      if (model !== models[0]) {
        console.warn(`[LLM] Cascade: used ${model} (primary ${models[0]} unavailable)`);
      }
      return response;
    } catch (err) {
      const code = err.status || err.code || 0;
      const msg = (err.message || '').toLowerCase();
      const shouldCascade = CASCADE_STATUSES.has(code) || msg.includes('503') || msg.includes('429') || msg.includes('unavailable') || msg.includes('overloaded') || msg.includes('resource_exhausted');
      if (!shouldCascade) throw err;
      lastErr = err;
      console.warn(`[LLM] Gemini ${code || 'error'} on ${model} — cascading to next model`);
    }
  }
  throw lastErr;
}

/**
 * Try each model in order for streaming; cascade only if no tokens yielded yet.
 */
export async function* streamWithCascade(models, contents, config = {}) {
  let lastErr = null;
  for (const model of models) {
    try {
      let modelConfig = { ...config };
      if (!model.includes('2.5') && modelConfig.thinkingConfig) {
        delete modelConfig.thinkingConfig;
      }
      let started = false;
      const stream = await gemini.models.generateContentStream({
        model,
        contents,
        config: modelConfig,
      });
      for await (const chunk of stream) {
        started = true;
        yield chunk;
      }
      return;
    } catch (err) {
      const code = err.status || err.code || 0;
      const msg = (err.message || '').toLowerCase();
      const shouldCascade = CASCADE_STATUSES.has(code) || msg.includes('503') || msg.includes('429') || msg.includes('unavailable') || msg.includes('overloaded') || msg.includes('resource_exhausted');
      if (err._started || !shouldCascade) throw err;
      lastErr = err;
      console.warn(`[LLM] Gemini ${code || 'error'} on ${model} (pre-stream) — cascading to next model`);
    }
  }
  throw lastErr;
}

export { gemini };
